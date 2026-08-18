import { spawn } from "node:child_process";

import type { AppPaths } from "../config/paths.js";
import {
    type DaemonLockRecord,
    processIsRunning,
    readDaemonLock,
    requestDaemonStop,
} from "../daemon/lock.js";

const DEFAULT_POLL_MS = 100;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

export interface DetachedSpawnOptions {
    readonly detached: true;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide: true;
}

export interface SpawnedDaemon {
    readonly pid: number;
}

export interface DaemonProcessAdapter {
    spawn(
        executable: string,
        arguments_: ReadonlyArray<string>,
        options: DetachedSpawnOptions,
    ): Promise<SpawnedDaemon>;
}

export const nodeDaemonProcessAdapter: DaemonProcessAdapter = {
    async spawn(executable, arguments_, options) {
        return new Promise<SpawnedDaemon>((resolve, reject) => {
            const child = spawn(executable, [...arguments_], options);
            let settled = false;
            child.once("error", error => {
                if (settled) return;
                settled = true;
                reject(error);
            });
            child.once("spawn", () => {
                if (settled) return;
                settled = true;
                const { pid } = child;
                if (pid === undefined) {
                    reject(new Error("the daemon process did not receive a process id"));
                    return;
                }
                child.unref();
                resolve({ pid });
            });
        });
    },
};

export interface DaemonLifecycleDependencies {
    readonly readLock: (filePath: string) => Promise<DaemonLockRecord | undefined>;
    readonly requestStop: (
        lockFile: string,
        stopFile: string,
    ) => Promise<DaemonLockRecord | undefined>;
    readonly isProcessRunning: (pid: number) => boolean;
    readonly process: DaemonProcessAdapter;
    readonly delay: (milliseconds: number) => Promise<void>;
}

const defaultDependencies: DaemonLifecycleDependencies = {
    readLock: readDaemonLock,
    requestStop: requestDaemonStop,
    isProcessRunning: processIsRunning,
    process: nodeDaemonProcessAdapter,
    delay: async milliseconds => new Promise(resolve => {
        setTimeout(resolve, milliseconds);
    }),
};

export interface StartDaemonOptions {
    readonly paths: AppPaths;
    readonly cliEntrypoint: string;
    readonly nodeExecutable?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly dependencies?: Partial<DaemonLifecycleDependencies>;
}

export interface StopDaemonOptions {
    readonly paths: AppPaths;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly dependencies?: Partial<DaemonLifecycleDependencies>;
}

export interface DaemonInspection {
    readonly running: boolean;
    readonly record?: DaemonLockRecord;
}

export type StartDaemonResult =
    | { readonly outcome: "started"; readonly pid: number }
    | { readonly outcome: "already-running"; readonly pid: number };

export type StopDaemonResult =
    | { readonly outcome: "stopped"; readonly pid: number }
    | { readonly outcome: "already-stopped" }
    | { readonly outcome: "timed-out"; readonly pid: number };

function dependenciesWithDefaults(
    dependencies: Partial<DaemonLifecycleDependencies> | undefined,
): DaemonLifecycleDependencies {
    return { ...defaultDependencies, ...dependencies };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return resolved;
}

export async function inspectDaemon(
    paths: Pick<AppPaths, "lockFile">,
    options: {
        readonly dependencies?: Partial<DaemonLifecycleDependencies>;
    } = {},
): Promise<DaemonInspection> {
    const dependencies = dependenciesWithDefaults(options.dependencies);
    const record = await dependencies.readLock(paths.lockFile);
    if (record === undefined) return { running: false };
    // a stale heartbeat can be caused by sleep, suspension, or a debugger. a
    // live owner is safer than briefly running two presence daemons at once.
    const running = dependencies.isProcessRunning(record.pid);
    return { running, record };
}

function pollCount(timeoutMs: number, pollMs: number): number {
    return Math.ceil(timeoutMs / pollMs) + 1;
}

export async function startDaemon(options: StartDaemonOptions): Promise<StartDaemonResult> {
    const dependencies = dependenciesWithDefaults(options.dependencies);
    const timeoutMs = positiveInteger(
        options.timeoutMs,
        DEFAULT_START_TIMEOUT_MS,
        "timeoutMs",
    );
    const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS, "pollMs");
    const existing = await inspectDaemon(options.paths, {
        dependencies,
    });
    if (existing.running && existing.record !== undefined) {
        return { outcome: "already-running", pid: existing.record.pid };
    }

    const child = await dependencies.process.spawn(
        options.nodeExecutable ?? process.execPath,
        [options.cliEntrypoint, "daemon"],
        {
            detached: true,
            env: { ...(options.environment ?? process.env) },
            shell: false,
            stdio: "ignore",
            windowsHide: true,
        },
    );

    for (let attempt = 0; attempt < pollCount(timeoutMs, pollMs); attempt += 1) {
        const inspection = await inspectDaemon(options.paths, {
            dependencies,
        });
        if (inspection.running && inspection.record !== undefined) {
            return inspection.record.pid === child.pid
                ? { outcome: "started", pid: child.pid }
                : { outcome: "already-running", pid: inspection.record.pid };
        }
        if (attempt + 1 < pollCount(timeoutMs, pollMs)) {
            await dependencies.delay(pollMs);
        }
    }
    throw new Error("the daemon did not become ready before the startup timeout");
}

export async function stopDaemon(options: StopDaemonOptions): Promise<StopDaemonResult> {
    const dependencies = dependenciesWithDefaults(options.dependencies);
    const timeoutMs = positiveInteger(
        options.timeoutMs,
        DEFAULT_STOP_TIMEOUT_MS,
        "timeoutMs",
    );
    const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS, "pollMs");
    const existing = await dependencies.readLock(options.paths.lockFile);
    if (existing === undefined || !dependencies.isProcessRunning(existing.pid)) {
        return { outcome: "already-stopped" };
    }
    const target = await dependencies.requestStop(options.paths.lockFile, options.paths.stopFile);
    if (target === undefined) return { outcome: "already-stopped" };

    const attempts = pollCount(timeoutMs, pollMs);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const current = await dependencies.readLock(options.paths.lockFile);
        if (current === undefined || current.nonce !== target.nonce) {
            return { outcome: "stopped", pid: target.pid };
        }
        if (attempt + 1 < attempts) await dependencies.delay(pollMs);
    }
    return { outcome: "timed-out", pid: target.pid };
}
