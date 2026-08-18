import { rm } from "node:fs/promises";

import {
    type AppConfig,
    loadConfig,
} from "../config/config.js";
import {
    createCredentialStore,
    type CredentialStore,
} from "../config/credentials.js";
import {
    type AppPaths,
    ensureAppDirectories,
    resolveAppPaths,
} from "../config/paths.js";
import {
    DiscordConnectionManager,
    type DiscordManagerOptions,
} from "../discord/client.js";
import type { DiscordActivity, DiscordConnectionState } from "../discord/types.js";
import {
    createLogger,
    type Logger,
} from "../logging/logger.js";
import {
    authorizeT3Server,
    requestWebSocketAuthorization,
    type WebSocketAuthorization,
} from "../t3/auth.js";
import {
    discoverT3Server,
    type DiscoveryOptions,
} from "../t3/discovery.js";
import {
    connectT3RpcSession,
} from "../t3/rpc.js";
import type { DiscoveredT3Server } from "../t3/types.js";
import { isAbortError, waitForAbortableDelay } from "./backoff.js";
import {
    acquireDaemonLock,
    type AcquireDaemonLockOptions,
    consumeStopRequest,
    type DaemonLease,
} from "./lock.js";
import {
    type DaemonStatusPatch,
    DaemonStatusWriter,
} from "./status.js";
import {
    type PresencePublisher,
    runT3ConnectionLoop,
    type T3ConnectionDependencies,
} from "./t3-connection.js";

export interface DiscordManagerRuntime extends PresencePublisher {
    run(signal: AbortSignal): Promise<void>;
}

export interface DaemonDependencies {
    readonly ensureDirectories: (paths: AppPaths) => Promise<void>;
    readonly acquireLock: (options: AcquireDaemonLockOptions) => Promise<DaemonLease>;
    readonly loadConfig: (configFile: string) => Promise<AppConfig>;
    readonly createCredentialStore: (credentialsFile: string) => Promise<CredentialStore>;
    readonly createLogger: (logFile: string, debug: boolean) => Logger;
    readonly createDiscordManager: (options: DiscordManagerOptions) => DiscordManagerRuntime;
    readonly discover: (signal: AbortSignal) => Promise<DiscoveredT3Server | undefined>;
    readonly authorize: T3ConnectionDependencies["authorize"];
    readonly requestAuthorization: T3ConnectionDependencies["requestAuthorization"];
    readonly connectRpc: T3ConnectionDependencies["connectRpc"];
    readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly random: () => number;
    readonly now: () => number;
}

export interface DaemonTimings {
    readonly heartbeatMs?: number;
    readonly retryBaseMs?: number;
    readonly retryMaxMs?: number;
    readonly staleLockMs?: number;
}

export interface RunDaemonOptions {
    readonly paths?: AppPaths;
    readonly signal?: AbortSignal;
    readonly handleProcessSignals?: boolean;
    readonly debug?: boolean;
    readonly pid?: number;
    readonly entrypoint?: string;
    readonly nonce?: () => string;
    readonly env?: NodeJS.ProcessEnv;
    readonly discovery?: DiscoveryOptions;
    readonly timings?: DaemonTimings;
    readonly dependencies?: Partial<DaemonDependencies>;
}

export const DISCORD_CLIENT_ID_ENV = "T3_DISCORD_CLIENT_ID";

export function applyDaemonEnvironment(
    config: AppConfig,
    env: NodeJS.ProcessEnv = process.env,
): AppConfig {
    const clientId = env[DISCORD_CLIENT_ID_ENV]?.trim();
    if (clientId === undefined || clientId.length === 0) return config;
    if (clientId.length > 256) {
        throw new Error(`${DISCORD_CLIENT_ID_ENV} must be at most 256 characters`);
    }
    return {
        ...config,
        discord: { ...config.discord, clientId },
    };
}

function defaultDependencies(options: RunDaemonOptions): DaemonDependencies {
    const discoveryFetch = options.discovery?.fetch ?? globalThis.fetch;
    return {
        ensureDirectories: ensureAppDirectories,
        acquireLock: acquireDaemonLock,
        loadConfig,
        createCredentialStore: async credentialsFile => createCredentialStore({ credentialsFile }),
        createLogger: (logFile, debug) => createLogger({
            filePath: logFile,
            level: debug ? "debug" : "info",
        }),
        createDiscordManager: managerOptions => new DiscordConnectionManager(managerOptions),
        discover: async signal => discoverT3Server({
            ...options.discovery,
            fetch: async (input, init) => discoveryFetch(input, {
                ...init,
                signal: init?.signal === undefined || init.signal === null
                    ? signal
                    : AbortSignal.any([signal, init.signal]),
            }),
        }),
        authorize: async (server, store, signal, force) => authorizeT3Server(
            server,
            store,
            { signal, force: force === true },
        ),
        requestAuthorization: async (server, accessToken, signal) => (
            requestWebSocketAuthorization(server, accessToken, { signal })
        ),
        connectRpc: async (authorization, signal) => (
            connectT3RpcSession(authorization, { signal })
        ),
        wait: waitForAbortableDelay,
        random: Math.random,
        now: Date.now,
    };
}

function resolveDependencies(options: RunDaemonOptions): DaemonDependencies {
    return { ...defaultDependencies(options), ...options.dependencies };
}

function positiveTiming(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return resolved;
}

async function safeLog(
    logger: Logger,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
): Promise<void> {
    await logger[level](message, metadata).catch(() => undefined);
}

function safeErrorType(error: unknown): string {
    if (isAbortError(error)) return "AbortError";
    return error instanceof Error && ["ConfigError", "CredentialStoreError"].includes(error.name)
        ? error.name
        : "Error";
}

function updateStatus(
    status: DaemonStatusWriter,
    patch: DaemonStatusPatch,
    logger: Logger,
): void {
    void status.update(patch).catch(async () => {
        await safeLog(logger, "warn", "could not update daemon status");
    });
}

function installShutdownHandlers(
    controller: AbortController,
    enabled: boolean,
): () => void {
    if (!enabled) return () => undefined;
    const shutdown = () => controller.abort();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("beforeExit", shutdown);
    return () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        process.off("beforeExit", shutdown);
    };
}

function forwardAbortSignal(
    source: AbortSignal | undefined,
    controller: AbortController,
): () => void {
    if (source === undefined) return () => undefined;
    const abort = () => controller.abort(source.reason);
    source.addEventListener("abort", abort, { once: true });
    if (source.aborted) abort();
    return () => source.removeEventListener("abort", abort);
}

async function runMaintenanceLoop(
    paths: AppPaths,
    lease: DaemonLease,
    status: DaemonStatusWriter,
    logger: Logger,
    controller: AbortController,
    wait: DaemonDependencies["wait"],
    heartbeatMs: number,
): Promise<void> {
    const { signal } = controller;
    while (!signal.aborted) {
        try {
            await wait(heartbeatMs, signal);
        } catch (error) {
            if (signal.aborted || isAbortError(error)) return;
            throw error;
        }
        if (signal.aborted) return;
        if (await consumeStopRequest(paths.stopFile, lease.record.nonce)) {
            await safeLog(logger, "info", "cooperative stop requested");
            controller.abort();
            return;
        }
        if (!await lease.heartbeat()) {
            await safeLog(logger, "error", "daemon lock ownership was lost");
            controller.abort();
            return;
        }
        await status.update({});
    }
}

function startDiscord(
    config: AppConfig,
    dependencies: DaemonDependencies,
    status: DaemonStatusWriter,
    logger: Logger,
    signal: AbortSignal,
): { readonly manager?: DiscordManagerRuntime; readonly task?: Promise<void> } {
    if (config.discord.clientId === undefined) {
        updateStatus(status, {
            discord: "unconfigured",
            message: "Discord application is not configured",
        }, logger);
        return {};
    }
    let previous: DiscordConnectionState = "waiting";
    const manager = dependencies.createDiscordManager({
        clientId: config.discord.clientId,
        random: dependencies.random,
        onStateChange(state) {
            updateStatus(status, { discord: state }, logger);
            if (state === "connected") {
                void safeLog(logger, "info", "discord connected");
            } else if (state === "waiting" && previous === "connected") {
                void safeLog(logger, "warn", "discord disconnected");
            }
            previous = state;
        },
        onError() {
            void safeLog(logger, "warn", "discord connection interrupted", {
                errorType: "Error",
            });
        },
    });
    const task = manager.run(signal).catch(async error => {
        if (!signal.aborted) {
            updateStatus(status, { discord: "stopped" }, logger);
            await safeLog(logger, "error", "discord connection manager stopped", {
                errorType: safeErrorType(error),
            });
        }
    });
    return { manager, task };
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
    const paths = options.paths ?? resolveAppPaths();
    const dependencies = resolveDependencies(options);
    const heartbeatMs = positiveTiming(options.timings?.heartbeatMs, 2_000, "heartbeatMs");
    const staleLockMs = positiveTiming(options.timings?.staleLockMs, 15_000, "staleLockMs");
    const controller = new AbortController();
    await dependencies.ensureDirectories(paths);
    const lease = await dependencies.acquireLock({
        lockFile: paths.lockFile,
        ...(options.pid === undefined ? {} : { pid: options.pid }),
        ...(options.entrypoint === undefined ? {} : { entrypoint: options.entrypoint }),
        now: dependencies.now,
        staleAfterMs: staleLockMs,
        ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
    const removeForwardedAbort = forwardAbortSignal(options.signal, controller);
    const removeShutdownHandlers = installShutdownHandlers(
        controller,
        options.handleProcessSignals !== false,
    );
    let logger: Logger | undefined;
    let status: DaemonStatusWriter | undefined;
    let discord: DiscordManagerRuntime | undefined;
    let discordTask: Promise<void> | undefined;
    let maintenanceTask: Promise<void> | undefined;
    let failure: unknown;

    try {
        logger = dependencies.createLogger(paths.logFile, options.debug === true);
        status = new DaemonStatusWriter({
            filePath: paths.statusFile,
            pid: lease.record.pid,
            nonce: lease.record.nonce,
            now: dependencies.now,
        });
        await status.update({ daemon: "running", message: "daemon started" });
        await safeLog(logger, "info", "daemon started", {
            pid: lease.record.pid,
        });
        maintenanceTask = runMaintenanceLoop(
            paths,
            lease,
            status,
            logger,
            controller,
            dependencies.wait,
            heartbeatMs,
        ).catch(async error => {
            if (!controller.signal.aborted) {
                await safeLog(logger as Logger, "error", "daemon heartbeat failed", {
                    errorType: safeErrorType(error),
                });
                controller.abort();
            }
        });

        const config = applyDaemonEnvironment(
            await dependencies.loadConfig(paths.configFile),
            options.env ?? process.env,
        );
        const credentials = await dependencies.createCredentialStore(paths.credentialsFile);
        const startedDiscord = startDiscord(
            config,
            dependencies,
            status,
            logger,
            controller.signal,
        );
        discord = startedDiscord.manager;
        discordTask = startedDiscord.task;
        const presence: PresencePublisher = {
            setDesiredActivity(activity: DiscordActivity | null): boolean {
                return discord?.setDesiredActivity(activity) ?? false;
            },
        };
        await runT3ConnectionLoop({
            config,
            credentials,
            presence,
            status,
            logger,
            signal: controller.signal,
            ...(options.timings?.retryBaseMs === undefined
                ? {}
                : { retryBaseMs: options.timings.retryBaseMs }),
            ...(options.timings?.retryMaxMs === undefined
                ? {}
                : { retryMaxMs: options.timings.retryMaxMs }),
            dependencies: {
                discover: dependencies.discover,
                authorize: dependencies.authorize,
                requestAuthorization: dependencies.requestAuthorization,
                connectRpc: dependencies.connectRpc,
                wait: dependencies.wait,
                random: dependencies.random,
                now: dependencies.now,
            },
        });
    } catch (error) {
        failure = error;
        if (logger !== undefined) {
            await safeLog(logger, "error", "daemon stopped after an internal failure", {
                errorType: safeErrorType(error),
            });
        }
    } finally {
        if (status !== undefined) {
            await status.update({ daemon: "stopping", message: "daemon is stopping" })
                .catch(() => undefined);
        }
        discord?.setDesiredActivity(null);
        controller.abort();
        await Promise.allSettled([
            ...(discordTask === undefined ? [] : [discordTask]),
            ...(maintenanceTask === undefined ? [] : [maintenanceTask]),
        ]);
        await consumeStopRequest(paths.stopFile, lease.record.nonce).catch(() => undefined);
        if (status !== undefined) {
            await status.update({
                daemon: "stopped",
                t3: "waiting",
                discord: discord === undefined ? "unconfigured" : "stopped",
                message: "daemon stopped",
            }).catch(() => undefined);
            await status.flush().catch(() => undefined);
        }
        await lease.release();
        if (logger !== undefined) {
            await safeLog(logger, "info", "daemon stopped");
            await logger.close().catch(() => undefined);
        }
        await rm(paths.stopFile, { force: true }).catch(() => undefined);
        removeShutdownHandlers();
        removeForwardedAbort();
    }

    if (failure !== undefined) throw failure;
}

export type { WebSocketAuthorization };
