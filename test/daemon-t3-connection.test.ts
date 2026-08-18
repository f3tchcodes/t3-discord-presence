import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { CredentialStore, StoredCredential } from "../src/config/credentials.js";
import type { DaemonStatusPatch } from "../src/daemon/status.js";
import {
    type PresencePublisher,
    runT3ConnectionLoop,
} from "../src/daemon/t3-connection.js";
import type { DiscordActivity } from "../src/discord/types.js";
import type { Logger, LogMetadata } from "../src/logging/logger.js";
import { T3AuthError, type WebSocketAuthorization } from "../src/t3/auth.js";
import type {
    T3RpcSession,
    T3RpcStreamHandler,
    T3RpcSubscription,
    T3RpcThreadSubscriptionOptions,
} from "../src/t3/rpc.js";
import type { DiscoveredT3Server } from "../src/t3/types.js";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
}

class FakeSubscription implements T3RpcSubscription {
    readonly #completion = deferred<void>();
    readonly closed = this.#completion.promise;
    closeCalls = 0;

    async close(): Promise<void> {
        this.closeCalls += 1;
        this.#completion.resolve(undefined);
    }

    fail(error = new Error("subscription disconnected")): void {
        this.#completion.reject(error);
    }
}

class FakeSession implements T3RpcSession {
    readonly #completion = deferred<void>();
    readonly closed = this.#completion.promise;
    readonly shell = new FakeSubscription();
    readonly focused = new FakeSubscription();
    shellHandler: T3RpcStreamHandler | undefined;
    threadHandler: T3RpcStreamHandler | undefined;
    focusedThreadId: string | undefined;
    threadOptions: T3RpcThreadSubscriptionOptions | undefined;
    closeCalls = 0;

    async subscribeShell(
        onItem: T3RpcStreamHandler,
    ): Promise<T3RpcSubscription> {
        this.shellHandler = onItem;
        return this.shell;
    }

    async subscribeThread(
        threadId: string,
        onItem: T3RpcStreamHandler,
        options?: T3RpcThreadSubscriptionOptions,
    ): Promise<T3RpcSubscription> {
        this.focusedThreadId = threadId;
        this.threadHandler = onItem;
        this.threadOptions = options;
        return this.focused;
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        await this.shell.close();
        await this.focused.close();
        this.#completion.resolve(undefined);
    }

    disconnect(): void {
        this.#completion.reject(new Error("socket disconnected"));
    }
}

class DeferredSubscribeSession extends FakeSession {
    readonly subscriptionStarted = deferred<void>();
    readonly #subscriptionAllowed = deferred<void>();

    allowSubscription(): void {
        this.#subscriptionAllowed.resolve(undefined);
    }

    override async subscribeShell(
        onItem: T3RpcStreamHandler,
    ): Promise<T3RpcSubscription> {
        this.subscriptionStarted.resolve(undefined);
        await this.#subscriptionAllowed.promise;
        return super.subscribeShell(onItem);
    }
}

class FailedSubscribeSession extends FakeSession {
    override async subscribeShell(): Promise<T3RpcSubscription> {
        throw new Error("shell subscription failed");
    }
}

class MemoryLogger implements Logger {
    readonly entries: Array<{ message: string; metadata?: LogMetadata }> = [];
    closed = false;

    debug(message: string, metadata?: LogMetadata): Promise<void> {
        this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
        return Promise.resolve();
    }

    info(message: string, metadata?: LogMetadata): Promise<void> {
        this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
        return Promise.resolve();
    }

    warn(message: string, metadata?: LogMetadata): Promise<void> {
        this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
        return Promise.resolve();
    }

    error(message: string, metadata?: LogMetadata): Promise<void> {
        this.entries.push({ message, ...(metadata === undefined ? {} : { metadata }) });
        return Promise.resolve();
    }

    flush(): Promise<void> {
        return Promise.resolve();
    }

    close(): Promise<void> {
        this.closed = true;
        return Promise.resolve();
    }
}

class MemoryPresence implements PresencePublisher {
    readonly updates: Array<DiscordActivity | null> = [];
    readonly #reportsChanges: boolean;

    constructor(reportsChanges = true) {
        this.#reportsChanges = reportsChanges;
    }

    setDesiredActivity(activity: DiscordActivity | null): boolean {
        const previous = JSON.stringify(this.updates.at(-1));
        const next = JSON.stringify(activity);
        if (previous === next) return false;
        this.updates.push(activity);
        return this.#reportsChanges;
    }
}

function credentialStore() {
    const deleted: Array<string> = [];
    const store: CredentialStore = {
        mode: "file",
        get: async () => undefined,
        set: async () => undefined,
        delete: async environmentId => {
            deleted.push(environmentId);
        },
    };
    return { store, deleted };
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

const authorization: WebSocketAuthorization = {
    ticket: "one-time-ticket",
    expiresAt: "2026-08-18T12:05:00.000Z",
    url: "ws://127.0.0.1:3773/ws?wsTicket=one-time-ticket",
};

function shellSnapshot() {
    return {
        kind: "snapshot",
        snapshot: {
            snapshotSequence: 10,
            projects: [{
                id: "project-1",
                title: "Visible project",
                workspaceRoot: "C:\\private\\workspace",
            }],
            threads: [{
                id: "thread-1",
                projectId: "project-1",
                title: "private prompt title",
                modelSelection: { instanceId: "codex", model: "gpt-5.6" },
                latestTurn: {
                    state: "running",
                    startedAt: "2026-08-18T11:55:00.000Z",
                    prompt: "private prompt body",
                },
                session: { status: "running", providerName: "Codex" },
                updatedAt: "2026-08-18T11:59:00.000Z",
                hasPendingApprovals: false,
                hasPendingUserInput: false,
                backgroundLiveness: null,
                worktreePath: "C:\\private\\worktree",
            }],
        },
    };
}

async function until(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error("condition was not reached");
}

function harness(overrides: {
    readonly controller?: AbortController;
    readonly discover?: () => Promise<DiscoveredT3Server | undefined>;
    readonly requestAuthorization?: () => Promise<WebSocketAuthorization>;
    readonly connectRpc?: () => Promise<T3RpcSession>;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly pollIntervalMs?: number;
    readonly presenceReportsChanges?: boolean;
} = {}) {
    const controller = overrides.controller ?? new AbortController();
    const logger = new MemoryLogger();
    const presence = new MemoryPresence(overrides.presenceReportsChanges ?? true);
    const credentials = credentialStore();
    const statuses: Array<DaemonStatusPatch> = [];
    const status = {
        async update(patch: DaemonStatusPatch) {
            statuses.push(patch);
        },
    };
    const authorize = vi.fn(async () => credential);
    const requestAuthorization = vi.fn(overrides.requestAuthorization ?? (async () => authorization));
    const connectRpc = vi.fn(overrides.connectRpc ?? (async () => new FakeSession()));
    const discover = vi.fn(overrides.discover ?? (async () => server));
    const wait = vi.fn(overrides.wait ?? (async () => undefined));
    const run = runT3ConnectionLoop({
        config: DEFAULT_CONFIG,
        credentials: credentials.store,
        presence,
        status,
        logger,
        signal: controller.signal,
        ...(overrides.pollIntervalMs === undefined
            ? {}
            : { pollIntervalMs: overrides.pollIntervalMs }),
        retryBaseMs: 1,
        retryMaxMs: 4,
        dependencies: {
            discover,
            authorize,
            requestAuthorization,
            connectRpc,
            wait,
            random: () => 0.5,
            now: () => Date.parse("2026-08-18T12:00:00.000Z"),
        },
    });
    return {
        authorize,
        connectRpc,
        controller,
        credentials,
        discover,
        logger,
        presence,
        requestAuthorization,
        run,
        statuses,
        wait,
    };
}

describe("T3 daemon connection loop", () => {
    it("polls normally absent T3 instances on a fixed cadence", async () => {
        const controller = new AbortController();
        const delays: Array<number> = [];
        const test = harness({
            controller,
            discover: async () => undefined,
            pollIntervalMs: 4_321,
            wait: async milliseconds => {
                delays.push(milliseconds);
                if (delays.length === 3) controller.abort();
            },
        });

        await test.run;

        expect(delays).toEqual([4_321, 4_321, 4_321]);
        expect(test.authorize).not.toHaveBeenCalled();
    });

    it("does not report connected until the shell subscription succeeds", async () => {
        const session = new DeferredSubscribeSession();
        const test = harness({ connectRpc: async () => session });

        await session.subscriptionStarted.promise;
        expect(test.statuses).not.toContainEqual(expect.objectContaining({ t3: "connected" }));
        expect(test.logger.entries.some(entry => entry.message === "connected to t3")).toBe(false);

        session.allowSubscription();
        await until(() => test.statuses.some(status => status.t3 === "connected"));
        expect(test.logger.entries.some(entry => entry.message === "connected to t3")).toBe(true);

        test.controller.abort();
        await test.run;
    });

    it("keeps exponential failure backoff until a shell subscription succeeds", async () => {
        const controller = new AbortController();
        const delays: Array<number> = [];
        const test = harness({
            controller,
            connectRpc: async () => new FailedSubscribeSession(),
            wait: async milliseconds => {
                delays.push(milliseconds);
                if (delays.length === 3) controller.abort();
            },
        });

        await test.run;

        expect(delays).toEqual([1, 2, 4]);
        expect(test.statuses).not.toContainEqual(expect.objectContaining({ t3: "connected" }));
    });

    it("resets failure backoff after a shell subscription succeeds", async () => {
        const controller = new AbortController();
        const connected = new FakeSession();
        const delays: Array<number> = [];
        let connectionAttempts = 0;
        const test = harness({
            controller,
            connectRpc: async () => {
                connectionAttempts += 1;
                return connectionAttempts < 3 ? new FailedSubscribeSession() : connected;
            },
            wait: async milliseconds => {
                delays.push(milliseconds);
                if (delays.length === 3) controller.abort();
            },
        });

        await until(() => connected.shellHandler !== undefined);
        connected.disconnect();
        await test.run;

        expect(delays).toEqual([1, 2, 1]);
    });

    it("waits for T3, publishes safe state, and follows only the selected active thread", async () => {
        const session = new FakeSession();
        let discoveryCalls = 0;
        const test = harness({
            discover: async () => {
                discoveryCalls += 1;
                return discoveryCalls === 1 ? undefined : server;
            },
            connectRpc: async () => session,
        });

        await until(() => session.shellHandler !== undefined);
        await session.shellHandler?.(shellSnapshot());
        await until(() => session.threadHandler !== undefined);
        expect(session.focusedThreadId).toBe("thread-1");
        expect(session.threadOptions).toMatchObject({ turnLimit: 1 });
        await session.threadHandler?.({
            kind: "event",
            event: {
                sequence: 20,
                aggregateId: "thread-1",
                type: "thread.activity-appended",
                payload: {
                    threadId: "thread-1",
                    activity: {
                        kind: "tool.started",
                        payload: {
                            itemType: "file_change",
                            command: "curl -H Authorization: Bearer private-secret",
                        },
                    },
                },
            },
        });
        await until(() => test.presence.updates.some(update => update?.state?.includes("editing code")));

        const serializedPresence = JSON.stringify(test.presence.updates);
        const serializedLogs = JSON.stringify(test.logger.entries);
        expect(serializedPresence).toContain("editing code");
        expect(serializedPresence).toContain("Visible project");
        expect(serializedPresence).not.toContain("private prompt");
        expect(serializedPresence).not.toContain("worktree");
        expect(serializedPresence).not.toContain("private-secret");
        expect(serializedLogs).not.toContain("private-secret");
        expect(test.wait).toHaveBeenCalled();

        test.controller.abort();
        await test.run;
        expect(test.presence.updates.at(-1)).toBeNull();
        expect(session.closeCalls).toBeGreaterThan(0);
    });

    it("keeps the T3 runtime timer stable while the runtime stays open", async () => {
        const session = new FakeSession();
        const test = harness({ connectRpc: async () => session });

        await until(() => session.shellHandler !== undefined);
        await session.shellHandler?.({
            kind: "snapshot",
            snapshot: {
                snapshotSequence: 1,
                projects: [],
                threads: [],
            },
        });
        await until(() => test.presence.updates.some(update => update?.state === "idle"));

        expect(test.presence.updates.find(update => update?.state === "idle"))
            .toMatchObject({ startTimestamp: Date.parse(server.runtime.startedAt) });

        test.controller.abort();
        await test.run;
    });

    it("logs only whitelisted stream metadata even without a Discord publisher change", async () => {
        const session = new FakeSession();
        const test = harness({
            connectRpc: async () => session,
            presenceReportsChanges: false,
        });

        await until(() => session.shellHandler !== undefined);
        await session.shellHandler?.(shellSnapshot());
        await session.shellHandler?.({
            kind: "thread-upserted",
            sequence: 11,
            thread: {
                id: "thread-1",
                projectId: "project-1",
                title: "do not log this private prompt title",
                session: { status: "running", providerName: "Codex" },
                latestTurn: {
                    state: "running",
                    startedAt: "2026-08-18T11:55:00.000Z",
                    prompt: "do not log this prompt body",
                },
                updatedAt: "2026-08-18T11:59:30.000Z",
                worktreePath: "C:\\private\\do-not-log-this-path",
            },
        });
        await until(() => session.threadHandler !== undefined);
        await session.threadHandler?.({
            kind: "event",
            event: {
                sequence: 20,
                aggregateId: "thread-1",
                type: "thread.activity-appended",
                createdAt: "2026-08-18T11:59:45.000Z",
                payload: {
                    threadId: "thread-1",
                    prompt: "do not log nested prompt",
                    path: "C:\\private\\nested-path",
                    activity: {
                        kind: "tool.started",
                        createdAt: "2026-08-18T11:59:44.000Z",
                        payload: {
                            itemType: "command_execution",
                            command: "curl -H Authorization: Bearer do-not-log-command",
                        },
                    },
                },
            },
        });
        await until(() => test.logger.entries.some(entry => entry.message === "t3 thread event"));

        const debugEntries = test.logger.entries.filter(entry => (
            entry.message === "t3 shell event"
            || entry.message === "t3 thread event"
            || entry.message === "presence selection changed"
        ));
        expect(debugEntries.some(entry => entry.message === "presence selection changed"))
            .toBe(true);
        for (const entry of debugEntries) {
            expect(Object.keys(entry.metadata ?? {})).toEqual(expect.arrayContaining(["eventType"]));
            expect(Object.keys(entry.metadata ?? {}).every(key => [
                "eventType",
                "threadId",
                "sessionStatus",
                "activityKind",
                "timestamp",
            ].includes(key))).toBe(true);
        }
        expect(debugEntries).toContainEqual(expect.objectContaining({
            message: "t3 shell event",
            metadata: {
                eventType: "thread-upserted",
                threadId: "thread-1",
                sessionStatus: "running",
                timestamp: "2026-08-18T11:59:30.000Z",
            },
        }));
        expect(debugEntries).toContainEqual(expect.objectContaining({
            message: "t3 thread event",
            metadata: {
                eventType: "thread.activity-appended",
                threadId: "thread-1",
                activityKind: "tool.started",
                timestamp: "2026-08-18T11:59:44.000Z",
            },
        }));
        const serializedLogs = JSON.stringify(test.logger.entries);
        expect(serializedLogs).not.toContain("do not log");
        expect(serializedLogs).not.toContain("do-not-log");
        expect(serializedLogs).not.toContain("private\\\\");
        expect(serializedLogs).not.toContain("payload");
        expect(serializedLogs).not.toContain("prompt");

        test.controller.abort();
        await test.run;
    });

    it("clears presence when T3 disappears and reconnects with a fresh session", async () => {
        const first = new FakeSession();
        const second = new FakeSession();
        let connections = 0;
        const test = harness({
            connectRpc: async () => {
                connections += 1;
                return connections === 1 ? first : second;
            },
        });

        await until(() => first.shellHandler !== undefined);
        await first.shellHandler?.(shellSnapshot());
        first.disconnect();
        await until(() => second.shellHandler !== undefined);

        expect(test.presence.updates).toContain(null);
        expect(test.connectRpc).toHaveBeenCalledTimes(2);
        expect(first.closeCalls).toBeGreaterThan(0);
        test.controller.abort();
        await test.run;
        expect(second.closeCalls).toBeGreaterThan(0);
    });

    it("invalidates a rejected bearer credential and successfully reauthorizes", async () => {
        const session = new FakeSession();
        let ticketCalls = 0;
        const test = harness({
            requestAuthorization: async () => {
                ticketCalls += 1;
                if (ticketCalls === 1) {
                    throw new T3AuthError("rejected secret credential", "unauthorized", 401);
                }
                return authorization;
            },
            connectRpc: async () => session,
        });

        await until(() => session.shellHandler !== undefined);
        expect(test.credentials.deleted).toEqual(["environment-1"]);
        expect(test.authorize).toHaveBeenCalledTimes(2);
        expect((test.authorize.mock.calls as Array<Array<unknown>>)[1]?.[3]).toBe(true);
        expect(test.statuses).toContainEqual(expect.objectContaining({ auth: "expired" }));
        expect(JSON.stringify(test.logger.entries)).not.toContain("rejected secret credential");

        test.controller.abort();
        await test.run;
    });
});
