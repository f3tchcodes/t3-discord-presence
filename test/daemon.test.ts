import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { CredentialStore, StoredCredential } from "../src/config/credentials.js";
import { resolveAppPaths } from "../src/config/paths.js";
import { waitForAbortableDelay } from "../src/daemon/backoff.js";
import {
    applyDaemonEnvironment,
    type DiscordManagerRuntime,
    runDaemon,
} from "../src/daemon/daemon.js";
import {
    DuplicateDaemonError,
    readDaemonLock,
    requestDaemonStop,
} from "../src/daemon/lock.js";
import { readDaemonStatus } from "../src/daemon/status.js";
import type { DiscordManagerOptions } from "../src/discord/client.js";
import type { DiscordActivity } from "../src/discord/types.js";
import type { Logger, LogMetadata } from "../src/logging/logger.js";
import type {
    T3RpcSession,
    T3RpcStreamHandler,
    T3RpcSubscription,
} from "../src/t3/rpc.js";
import type { DiscoveredT3Server } from "../src/t3/types.js";
import { useTempDirectory } from "./utils/temp-directory.js";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    return { promise, reject, resolve };
}

class MemoryLogger implements Logger {
    readonly entries: Array<{ message: string; metadata?: LogMetadata }> = [];
    closed = false;

    #write(message: string, metadata?: LogMetadata): Promise<void> {
        this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
        return Promise.resolve();
    }

    debug(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#write(message, metadata);
    }

    info(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#write(message, metadata);
    }

    warn(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#write(message, metadata);
    }

    error(message: string, metadata?: LogMetadata): Promise<void> {
        return this.#write(message, metadata);
    }

    flush(): Promise<void> {
        return Promise.resolve();
    }

    close(): Promise<void> {
        this.closed = true;
        return Promise.resolve();
    }
}

class FakeSubscription implements T3RpcSubscription {
    readonly #completion = deferred<void>();
    readonly closed = this.#completion.promise;
    closeCalls = 0;

    async close(): Promise<void> {
        this.closeCalls += 1;
        this.#completion.resolve(undefined);
    }
}

class FakeSession implements T3RpcSession {
    readonly #completion = deferred<void>();
    readonly shell = new FakeSubscription();
    readonly focused = new FakeSubscription();
    readonly closed = this.#completion.promise;
    shellHandler: T3RpcStreamHandler | undefined;
    closeCalls = 0;

    async subscribeShell(onItem: T3RpcStreamHandler): Promise<T3RpcSubscription> {
        this.shellHandler = onItem;
        return this.shell;
    }

    async subscribeThread(): Promise<T3RpcSubscription> {
        return this.focused;
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        await this.shell.close();
        await this.focused.close();
        this.#completion.resolve(undefined);
    }
}

class FakeDiscordManager implements DiscordManagerRuntime {
    readonly #options: DiscordManagerOptions;
    readonly updates: Array<DiscordActivity | null> = [];
    started = false;
    stopped = false;

    constructor(options: DiscordManagerOptions) {
        this.#options = options;
    }

    setDesiredActivity(activity: DiscordActivity | null): boolean {
        this.updates.push(activity);
        return true;
    }

    async run(signal: AbortSignal): Promise<void> {
        this.started = true;
        this.#options.onStateChange?.("connecting");
        this.#options.onStateChange?.("connected");
        if (!signal.aborted) {
            await new Promise<void>(resolve => {
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
        }
        this.stopped = true;
        this.#options.onStateChange?.("stopped");
    }
}

const server: DiscoveredT3Server = {
    baseDir: "C:\\t3",
    variant: "userdata",
    runtimePath: "C:\\t3\\userdata\\server-runtime.json",
    runtime: {
        version: 1,
        pid: 123,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-08-18T00:00:00.000Z",
    },
    descriptor: {
        environmentId: "environment-1",
        label: "T3 Code",
        platform: { os: "windows", arch: "x64" },
        serverVersion: "0.0.33",
        capabilities: { repositoryIdentity: true },
    },
};

const credential: StoredCredential = {
    environmentId: "environment-1",
    accessToken: "stored-access-token",
    expiresAt: "2026-09-18T00:00:00.000Z",
    scope: "orchestration:read",
};

const credentials: CredentialStore = {
    mode: "file",
    get: async () => credential,
    set: async () => undefined,
    delete: async () => undefined,
};

async function until(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error("condition was not reached");
}

function testPaths(root: string) {
    return resolveAppPaths({
        platform: "win32",
        env: {
            APPDATA: `${root}\\roaming`,
            LOCALAPPDATA: `${root}\\local`,
        },
        homeDirectory: root,
    });
}

describe("daemon lifecycle", () => {
    const temp = useTempDirectory();

    it("keeps Discord independent and cleans every owned resource on shutdown", async () => {
        const paths = testPaths(temp.path("shutdown-home"));
        const controller = new AbortController();
        const logger = new MemoryLogger();
        const session = new FakeSession();
        let discord: FakeDiscordManager | undefined;
        const connectRpc = vi.fn(async () => session);
        const running = runDaemon({
            paths,
            signal: controller.signal,
            env: { T3_DISCORD_CLIENT_ID: "environment-discord-id" },
            handleProcessSignals: false,
            timings: { heartbeatMs: 10, retryBaseMs: 1, retryMaxMs: 4 },
            dependencies: {
                loadConfig: async () => ({
                    ...DEFAULT_CONFIG,
                    discord: { clientId: "discord-application-id" },
                }),
                createCredentialStore: async () => credentials,
                createLogger: () => logger,
                createDiscordManager: options => {
                    discord = new FakeDiscordManager(options);
                    return discord;
                },
                discover: async () => server,
                authorize: async () => credential,
                requestAuthorization: async () => ({
                    ticket: "ticket",
                    expiresAt: "2026-08-18T12:05:00.000Z",
                    url: "ws://127.0.0.1:3773/ws?wsTicket=ticket",
                }),
                connectRpc,
                wait: waitForAbortableDelay,
                random: () => 0.5,
            },
        });

        await until(() => session.shellHandler !== undefined);
        expect(discord?.started).toBe(true);
        expect(discord?.updates).toEqual([]);
        expect(connectRpc).toHaveBeenCalledOnce();
        expect(await readDaemonLock(paths.lockFile)).toBeDefined();

        await session.shellHandler?.({
            kind: "snapshot",
            snapshot: { snapshotSequence: 1, projects: [], threads: [] },
        });
        expect(discord?.updates.length).toBeGreaterThan(0);
        controller.abort();
        await running;

        expect(session.closeCalls).toBeGreaterThan(0);
        expect(session.shell.closeCalls).toBeGreaterThan(0);
        expect(discord?.stopped).toBe(true);
        expect(discord?.updates.at(-1)).toBeNull();
        expect(logger.closed).toBe(true);
        expect(await readDaemonLock(paths.lockFile)).toBeUndefined();
        await expect(readFile(paths.stopFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readDaemonStatus(paths.statusFile)).resolves.toMatchObject({
            daemon: "stopped",
            discord: "stopped",
        });
    });

    it("uses a non-empty environment client id ahead of config", () => {
        expect(applyDaemonEnvironment({
            ...DEFAULT_CONFIG,
            discord: { clientId: "config-id", largeImageKey: "t3code" },
        }, { T3_DISCORD_CLIENT_ID: "  environment-id  " })).toEqual({
            ...DEFAULT_CONFIG,
            discord: { clientId: "environment-id", largeImageKey: "t3code" },
        });
        expect(applyDaemonEnvironment({
            ...DEFAULT_CONFIG,
            discord: { clientId: "config-id" },
        }, { T3_DISCORD_CLIENT_ID: "   " }).discord.clientId).toBe("config-id");
    });

    it("honors a nonce-bound cooperative stop request", async () => {
        const paths = testPaths(temp.path("stop-home"));
        const logger = new MemoryLogger();
        const running = runDaemon({
            paths,
            handleProcessSignals: false,
            timings: { heartbeatMs: 5, retryBaseMs: 1_000 },
            nonce: () => "cooperative-daemon-owner",
            dependencies: {
                loadConfig: async () => DEFAULT_CONFIG,
                createCredentialStore: async () => credentials,
                createLogger: () => logger,
                discover: async () => undefined,
                wait: waitForAbortableDelay,
            },
        });
        await until(() => logger.entries.some(entry => entry.message === "waiting for t3"));

        await expect(requestDaemonStop(paths.lockFile, paths.stopFile)).resolves.toMatchObject({
            nonce: "cooperative-daemon-owner",
        });
        await running;

        expect(logger.entries.some(entry => entry.message === "cooperative stop requested"))
            .toBe(true);
        expect(await readDaemonLock(paths.lockFile)).toBeUndefined();
    });

    it("rejects a duplicate daemon without disturbing the owner", async () => {
        const paths = testPaths(temp.path("duplicate-home"));
        const ownerController = new AbortController();
        const logger = new MemoryLogger();
        const common = {
            paths,
            handleProcessSignals: false,
            timings: { heartbeatMs: 100, retryBaseMs: 100 },
            dependencies: {
                loadConfig: async () => DEFAULT_CONFIG,
                createCredentialStore: async () => credentials,
                createLogger: () => logger,
                discover: async () => undefined,
                wait: waitForAbortableDelay,
            },
        } as const;
        const owner = runDaemon({ ...common, signal: ownerController.signal });
        await until(() => logger.entries.some(entry => entry.message === "daemon started"));

        await expect(runDaemon(common)).rejects.toBeInstanceOf(DuplicateDaemonError);
        expect(await readDaemonLock(paths.lockFile)).toBeDefined();

        ownerController.abort();
        await owner;
        expect(await readDaemonLock(paths.lockFile)).toBeUndefined();
    });
});
