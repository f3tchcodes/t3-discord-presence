import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "../utils/atomic-file.js";

export type DaemonRuntimeState = "running" | "stopping" | "stopped";
export type T3ConnectionStatus = "waiting" | "connecting" | "connected" | "error";
export type DiscordStatus = "unconfigured" | "waiting" | "connecting" | "connected" | "stopped";
export type AuthStatus = "unknown" | "authorizing" | "valid" | "required" | "expired";

export interface DaemonStatusSnapshot {
    readonly version: 1;
    readonly pid: number;
    readonly nonce: string;
    readonly updatedAt: string;
    readonly daemon: DaemonRuntimeState;
    readonly t3: T3ConnectionStatus;
    readonly discord: DiscordStatus;
    readonly auth: AuthStatus;
    readonly environmentId?: string;
    readonly serverVersion?: string;
    readonly message?: string;
}

export type DaemonStatusPatch = Partial<Omit<DaemonStatusSnapshot, "version" | "pid" | "nonce" | "updatedAt">>;

export interface DaemonStatusWriterOptions {
    readonly filePath: string;
    readonly pid: number;
    readonly nonce: string;
    readonly now?: () => number;
    readonly initial?: DaemonStatusPatch;
}

const daemonStates = new Set<DaemonRuntimeState>(["running", "stopping", "stopped"]);
const t3States = new Set<T3ConnectionStatus>(["waiting", "connecting", "connected", "error"]);
const discordStates = new Set<DiscordStatus>([
    "unconfigured",
    "waiting",
    "connecting",
    "connected",
    "stopped",
]);
const authStates = new Set<AuthStatus>(["unknown", "authorizing", "valid", "required", "expired"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum = 1_024): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= maximum
        ? value
        : undefined;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>): T | undefined {
    return typeof value === "string" && values.has(value as T) ? value as T : undefined;
}

export function parseDaemonStatus(contents: string): DaemonStatusSnapshot | undefined {
    let value: unknown;
    try {
        value = JSON.parse(contents) as unknown;
    } catch {
        return undefined;
    }
    if (!isRecord(value)) return undefined;
    const updatedAt = boundedText(value.updatedAt);
    const timestamp = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
    const daemon = enumValue(value.daemon, daemonStates);
    const t3 = enumValue(value.t3, t3States);
    const discord = enumValue(value.discord, discordStates);
    const auth = enumValue(value.auth, authStates);
    const nonce = boundedText(value.nonce, 256);
    if (
        value.version !== 1
        || typeof value.pid !== "number"
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
        || nonce === undefined
        || !Number.isFinite(timestamp)
        || daemon === undefined
        || t3 === undefined
        || discord === undefined
        || auth === undefined
    ) {
        return undefined;
    }
    const environmentId = boundedText(value.environmentId);
    const serverVersion = boundedText(value.serverVersion, 256);
    const message = boundedText(value.message, 512);
    return {
        version: 1,
        pid: value.pid,
        nonce,
        updatedAt: new Date(timestamp).toISOString(),
        daemon,
        t3,
        discord,
        auth,
        ...(environmentId === undefined ? {} : { environmentId }),
        ...(serverVersion === undefined ? {} : { serverVersion }),
        ...(message === undefined ? {} : { message }),
    };
}

export async function readDaemonStatus(
    filePath: string,
): Promise<DaemonStatusSnapshot | undefined> {
    try {
        return parseDaemonStatus(await readFile(filePath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export class DaemonStatusWriter {
    readonly #filePath: string;
    readonly #now: () => number;
    #snapshot: DaemonStatusSnapshot;
    #queue: Promise<void> = Promise.resolve();

    constructor(options: DaemonStatusWriterOptions) {
        this.#filePath = options.filePath;
        this.#now = options.now ?? Date.now;
        this.#snapshot = {
            version: 1,
            pid: options.pid,
            nonce: options.nonce,
            updatedAt: new Date(this.#now()).toISOString(),
            daemon: "running",
            t3: "waiting",
            discord: "waiting",
            auth: "unknown",
            ...options.initial,
        };
        if (parseDaemonStatus(JSON.stringify(this.#snapshot)) === undefined) {
            throw new Error("initial daemon status is invalid");
        }
    }

    get snapshot(): DaemonStatusSnapshot {
        return this.#snapshot;
    }

    update(patch: DaemonStatusPatch): Promise<void> {
        const next: DaemonStatusSnapshot = {
            ...this.#snapshot,
            ...patch,
            updatedAt: new Date(this.#now()).toISOString(),
        };
        if (parseDaemonStatus(JSON.stringify(next)) === undefined) {
            return Promise.reject(new Error("daemon status patch is invalid"));
        }
        this.#snapshot = next;
        const write = this.#queue
            .catch(() => undefined)
            .then(async () => {
                await writeFileAtomic(this.#filePath, `${JSON.stringify(next, null, 4)}\n`);
            });
        this.#queue = write;
        return write;
    }

    async flush(): Promise<void> {
        await this.#queue;
    }
}
