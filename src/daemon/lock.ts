import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { writeFileAtomic } from "../utils/atomic-file.js";

const LOCK_VERSION = 1;

export interface DaemonLockRecord {
    readonly version: typeof LOCK_VERSION;
    readonly pid: number;
    readonly nonce: string;
    readonly startedAt: string;
    readonly heartbeatAt: string;
    readonly entrypoint: string;
}

export interface StopRequest {
    readonly version: typeof LOCK_VERSION;
    readonly nonce: string;
    readonly requestedAt: string;
}

export interface AcquireDaemonLockOptions {
    readonly lockFile: string;
    readonly pid?: number;
    readonly entrypoint?: string;
    readonly now?: () => number;
    readonly nonce?: () => string;
    readonly processIsRunning?: (pid: number) => boolean;
}

export class DuplicateDaemonError extends Error {
    override readonly name = "DuplicateDaemonError";
    readonly record: DaemonLockRecord;

    constructor(record: DaemonLockRecord) {
        super(`t3-discord-presence is already running with pid ${String(record.pid)}`);
        this.record = record;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

export function parseDaemonLock(contents: string): DaemonLockRecord | undefined {
    let value: unknown;
    try {
        value = JSON.parse(contents) as unknown;
    } catch {
        return undefined;
    }
    if (!isRecord(value)) return undefined;
    const startedAt = parseTimestamp(value.startedAt);
    const heartbeatAt = parseTimestamp(value.heartbeatAt);
    if (
        value.version !== LOCK_VERSION
        || typeof value.pid !== "number"
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
        || typeof value.nonce !== "string"
        || value.nonce.length < 16
        || value.nonce.length > 256
        || startedAt === undefined
        || heartbeatAt === undefined
        || typeof value.entrypoint !== "string"
        || value.entrypoint.length > 4_096
    ) {
        return undefined;
    }
    return {
        version: LOCK_VERSION,
        pid: value.pid,
        nonce: value.nonce,
        startedAt,
        heartbeatAt,
        entrypoint: value.entrypoint,
    };
}

export function parseStopRequest(contents: string): StopRequest | undefined {
    let value: unknown;
    try {
        value = JSON.parse(contents) as unknown;
    } catch {
        return undefined;
    }
    if (!isRecord(value)) return undefined;
    const requestedAt = parseTimestamp(value.requestedAt);
    if (
        value.version !== LOCK_VERSION
        || typeof value.nonce !== "string"
        || value.nonce.length < 16
        || value.nonce.length > 256
        || requestedAt === undefined
    ) {
        return undefined;
    }
    return { version: LOCK_VERSION, nonce: value.nonce, requestedAt };
}

export function processIsRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function readLock(filePath: string): Promise<{
    readonly contents: string;
    readonly record: DaemonLockRecord | undefined;
} | undefined> {
    try {
        const contents = await readFile(filePath, "utf8");
        return { contents, record: parseDaemonLock(contents) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

async function removeIfUnchanged(
    filePath: string,
    expectedContents: string,
    ownerIsRunning: (pid: number) => boolean,
): Promise<boolean> {
    const current = await readLock(filePath);
    if (current === undefined) return true;
    if (current.contents !== expectedContents) return false;
    // re-probe immediately before unlinking. the contents comparison catches a
    // concurrent ownership change, while this second liveness check narrows the
    // window where a just-started or pid-reused owner could be mistaken for a dead one.
    if (current.record !== undefined && ownerIsRunning(current.record.pid)) return false;
    await rm(filePath, { force: true });
    return true;
}

async function createLock(filePath: string, record: DaemonLockRecord): Promise<boolean> {
    const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await link(temporaryPath, filePath);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
            throw error;
        }
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

export class DaemonLease {
    readonly #lockFile: string;
    #record: DaemonLockRecord;
    #released = false;

    constructor(lockFile: string, record: DaemonLockRecord) {
        this.#lockFile = lockFile;
        this.#record = record;
    }

    get record(): DaemonLockRecord {
        return this.#record;
    }

    async heartbeat(): Promise<boolean> {
        if (this.#released) return false;
        const current = await readLock(this.#lockFile);
        // ownership is defined by the live pid and nonce. do not rewrite the
        // lock here: a read-then-replace heartbeat could overwrite a successor
        // that acquired the lock between those operations. runtime liveness is
        // recorded separately in the nonce-bound daemon status snapshot.
        return current?.record?.nonce === this.#record.nonce;
    }

    async release(): Promise<void> {
        if (this.#released) return;
        this.#released = true;
        const current = await readLock(this.#lockFile);
        if (current?.record?.nonce === this.#record.nonce) {
            await rm(this.#lockFile, { force: true });
        }
    }
}

export async function acquireDaemonLock(
    options: AcquireDaemonLockOptions,
): Promise<DaemonLease> {
    const now = options.now ?? Date.now;
    const probe = options.processIsRunning ?? processIsRunning;

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const timestamp = new Date(now()).toISOString();
        const record: DaemonLockRecord = {
            version: LOCK_VERSION,
            pid: options.pid ?? process.pid,
            nonce: (options.nonce ?? randomUUID)(),
            startedAt: timestamp,
            heartbeatAt: timestamp,
            entrypoint: options.entrypoint ?? process.argv[1] ?? "",
        };
        if (parseDaemonLock(JSON.stringify(record)) === undefined) {
            throw new Error("daemon lock metadata is invalid");
        }
        if (await createLock(options.lockFile, record)) {
            return new DaemonLease(options.lockFile, record);
        }

        const existing = await readLock(options.lockFile);
        if (existing === undefined) continue;
        // a sleeping or suspended daemon cannot refresh its heartbeat, but it
        // still owns the lock. never reclaim a well-formed lock while its pid is
        // alive; heartbeat age is diagnostic metadata, not proof of death.
        if (existing.record !== undefined && probe(existing.record.pid)) {
            throw new DuplicateDaemonError(existing.record);
        }
        await removeIfUnchanged(options.lockFile, existing.contents, probe);
    }
    throw new Error("could not acquire the daemon lock after concurrent changes");
}

export async function readDaemonLock(filePath: string): Promise<DaemonLockRecord | undefined> {
    return (await readLock(filePath))?.record;
}

export async function requestDaemonStop(
    lockFile: string,
    stopFile: string,
    now = Date.now,
): Promise<DaemonLockRecord | undefined> {
    const record = await readDaemonLock(lockFile);
    if (record === undefined) return undefined;
    const request: StopRequest = {
        version: LOCK_VERSION,
        nonce: record.nonce,
        requestedAt: new Date(now()).toISOString(),
    };
    await writeFileAtomic(stopFile, `${JSON.stringify(request)}\n`);
    return record;
}

export async function consumeStopRequest(
    stopFile: string,
    nonce: string,
): Promise<boolean> {
    let contents: string;
    try {
        contents = await readFile(stopFile, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
    const request = parseStopRequest(contents);
    await rm(stopFile, { force: true });
    return request?.nonce === nonce;
}
