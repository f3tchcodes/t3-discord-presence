import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMetadata = Readonly<Record<string, unknown>>;

export interface Logger {
    debug(message: string, metadata?: LogMetadata): Promise<void>;
    info(message: string, metadata?: LogMetadata): Promise<void>;
    warn(message: string, metadata?: LogMetadata): Promise<void>;
    error(message: string, metadata?: LogMetadata): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export interface LoggerOptions {
    readonly filePath: string;
    readonly level?: LogLevel;
    readonly maxBytes?: number;
    readonly maxFiles?: number;
    readonly now?: () => Date;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_STRING_CHARACTERS = 2_000;
const MAX_COLLECTION_ITEMS = 50;
const MAX_METADATA_DEPTH = 6;
const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const SENSITIVE_KEYS = new Set([
    "authorization",
    "proxyauthorization",
    "token",
    "accesstoken",
    "refreshtoken",
    "bearertoken",
    "subjecttoken",
    "pairingtoken",
    "pairingcredential",
    "bootstrapcredential",
    "credential",
    "credentials",
    "password",
    "passwd",
    "secret",
    "apikey",
    "cookie",
    "setcookie",
    "ticket",
    "wsticket",
    "prompt",
    "prompttext",
    "command",
    "rawcommand",
    "payload",
    "activitypayload",
    "path",
    "filepath",
    "directory",
    "cwd",
    "entrypoint",
    "workspaceroot",
    "worktreepath",
]);

function normalizedKey(key: string): string {
    return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
    const normalized = normalizedKey(key);
    return SENSITIVE_KEYS.has(normalized)
        || normalized.endsWith("token")
        || normalized.endsWith("ticket")
        || normalized.endsWith("authorization")
        || normalized.endsWith("credential")
        || normalized.endsWith("password")
        || normalized.endsWith("secret")
        || normalized.endsWith("apikey")
        || normalized.endsWith("cookie");
}

function truncate(value: string, maximumCharacters: number): string {
    if (value.length <= maximumCharacters) {
        return value;
    }
    return `${value.slice(0, maximumCharacters)}${TRUNCATED}`;
}

function redactString(value: string): string {
    return value
        .replaceAll(
            /(authorization\s*[:=]\s*)[^,;\r\n"']+/gi,
            `$1${REDACTED}`,
        )
        .replaceAll(/\bbearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
        .replaceAll(
            /\b(access[_-]?token|refresh[_-]?token|subject[_-]?token|pairing[_-]?token|bearer[_-]?token|id[_-]?token|ws[_-]?ticket|ticket|token|api[_-]?key|password|credential|secret)(\s*[:=]\s*)[^\s&,;"']+/gi,
            `$1$2${REDACTED}`,
        )
        .replaceAll(
            /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
            REDACTED,
        )
        .replaceAll(/(?:[A-Za-z]:[\\/]|\\\\|\/\/)[^,;\r\n"'<>]+/g, "[path]")
        .replaceAll(
            /(^|[\s("'=])\/(?!\/)[^,;\r\n"')<>]+/g,
            "$1[path]",
        );
}

function sanitizeValue(
    value: unknown,
    seen: WeakSet<object>,
    depth: number,
): unknown {
    if (value === null || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        return truncate(redactString(value), MAX_STRING_CHARACTERS);
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === "bigint" || typeof value === "symbol") {
        return String(value);
    }
    if (typeof value === "undefined") {
        return "[undefined]";
    }
    if (typeof value === "function") {
        return "[function]";
    }
    if (depth >= MAX_METADATA_DEPTH) {
        return TRUNCATED;
    }
    if (seen.has(value)) {
        return "[circular]";
    }
    seen.add(value);

    if (value instanceof Error) {
        return {
            name: value.name,
            message: truncate(redactString(value.message), MAX_STRING_CHARACTERS),
        };
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }
    if (Array.isArray(value)) {
        const sanitized = value
            .slice(0, MAX_COLLECTION_ITEMS)
            .map(item => sanitizeValue(item, seen, depth + 1));
        if (value.length > MAX_COLLECTION_ITEMS) {
            sanitized.push(TRUNCATED);
        }
        return sanitized;
    }

    const sanitized: Record<string, unknown> = {};
    const keys = Object.keys(value).slice(0, MAX_COLLECTION_ITEMS);
    for (const key of keys) {
        if (isSensitiveKey(key)) {
            sanitized[key] = REDACTED;
            continue;
        }
        try {
            sanitized[key] = sanitizeValue(
                (value as Record<string, unknown>)[key],
                seen,
                depth + 1,
            );
        } catch {
            sanitized[key] = "[unavailable]";
        }
    }
    if (Object.keys(value).length > MAX_COLLECTION_ITEMS) {
        sanitized._truncated = true;
    }
    return sanitized;
}

export function redactLogMetadata(metadata: LogMetadata): Record<string, unknown> {
    return sanitizeValue(metadata, new WeakSet(), 0) as Record<string, unknown>;
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertPositiveInteger(value: number, name: string, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
    }
}

interface LogEntry {
    readonly timestamp: string;
    readonly level: LogLevel;
    readonly message: string;
    readonly metadata?: Record<string, unknown>;
}

function serializeEntry(entry: LogEntry, maxBytes: number): string {
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line) <= maxBytes) {
        return line;
    }

    const withoutMetadata: LogEntry = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        metadata: { truncated: true },
    };
    line = `${JSON.stringify(withoutMetadata)}\n`;
    if (Buffer.byteLength(line) <= maxBytes) {
        return line;
    }

    let low = 0;
    let high = entry.message.length;
    let best = "";
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate: LogEntry = {
            timestamp: entry.timestamp,
            level: entry.level,
            message: `${entry.message.slice(0, middle)}${TRUNCATED}`,
        };
        const candidateLine = `${JSON.stringify(candidate)}\n`;
        if (Buffer.byteLength(candidateLine) <= maxBytes) {
            best = candidateLine;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    if (best === "") {
        throw new RangeError("maxBytes is too small for a log entry");
    }
    return best;
}

export class FileLogger implements Logger {
    readonly #filePath: string;
    readonly #level: LogLevel;
    readonly #maxBytes: number;
    readonly #maxFiles: number;
    readonly #now: () => Date;
    #queue: Promise<void> = Promise.resolve();
    #closed = false;

    constructor(options: LoggerOptions) {
        this.#filePath = options.filePath;
        this.#level = options.level ?? "info";
        this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
        this.#now = options.now ?? (() => new Date());
        assertPositiveInteger(this.#maxBytes, "maxBytes", 128);
        assertPositiveInteger(this.#maxFiles, "maxFiles", 1);
    }

    debug(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#log("debug", message, metadata);
    }

    info(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#log("info", message, metadata);
    }

    warn(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#log("warn", message, metadata);
    }

    error(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#log("error", message, metadata);
    }

    async flush(): Promise<void> {
        await this.#queue;
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.#queue;
    }

    #log(level: LogLevel, message: string, metadata?: LogMetadata): Promise<void> {
        if (this.#closed) {
            return Promise.reject(new Error("logger is closed"));
        }
        if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.#level]) {
            return Promise.resolve();
        }

        const operation = this.#queue.then(async () => {
            const entry: LogEntry = {
                timestamp: this.#now().toISOString(),
                level,
                message: truncate(redactString(message), MAX_MESSAGE_CHARACTERS),
                ...(metadata === undefined ? {} : { metadata: redactLogMetadata(metadata) }),
            };
            const line = serializeEntry(entry, this.#maxBytes);
            await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
            await this.#rotateIfNeeded(Buffer.byteLength(line));
            await appendFile(this.#filePath, line, { encoding: "utf8", mode: 0o600 });
        });
        this.#queue = operation.catch(() => undefined);
        return operation;
    }

    async #rotateIfNeeded(incomingBytes: number): Promise<void> {
        let currentBytes: number;
        try {
            currentBytes = (await stat(this.#filePath)).size;
        } catch (error) {
            if (isMissingFile(error)) {
                return;
            }
            throw error;
        }
        if (currentBytes === 0 || currentBytes + incomingBytes <= this.#maxBytes) {
            return;
        }

        for (let index = this.#maxFiles; index >= 1; index -= 1) {
            const destination = `${this.#filePath}.${index}`;
            const source = index === 1 ? this.#filePath : `${this.#filePath}.${index - 1}`;
            await rm(destination, { force: true });
            try {
                await rename(source, destination);
            } catch (error) {
                if (!isMissingFile(error)) {
                    throw error;
                }
            }
        }
    }
}

export function createLogger(options: LoggerOptions): Logger {
    return new FileLogger(options);
}
