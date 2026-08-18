import type { AppConfig } from "../config/config.js";
import type { CredentialStore, StoredCredential } from "../config/credentials.js";
import { buildDiscordActivity } from "../discord/activity.js";
import type { DiscordActivity } from "../discord/types.js";
import type { Logger } from "../logging/logger.js";
import {
    isAuthorizationRejected,
    T3AuthError,
    type WebSocketAuthorization,
} from "../t3/auth.js";
import type { T3RpcSession, T3RpcSubscription } from "../t3/rpc.js";
import {
    applyShellStreamItem,
    applyThreadStreamItem,
    createPresenceSourceState,
    type PresenceSourceState,
    type SelectedPresenceSource,
    selectPresenceSource,
} from "../t3/state.js";
import type { DiscoveredT3Server } from "../t3/types.js";
import { isAbortError, reconnectDelay, waitForAbortableDelay } from "./backoff.js";
import type { DaemonStatusPatch } from "./status.js";

export interface PresencePublisher {
    setDesiredActivity(activity: DiscordActivity | null): boolean;
}

export interface DaemonStatusSink {
    update(patch: DaemonStatusPatch): Promise<void>;
}

export interface T3ConnectionDependencies {
    readonly discover: (signal: AbortSignal) => Promise<DiscoveredT3Server | undefined>;
    readonly authorize: (
        server: DiscoveredT3Server,
        store: CredentialStore,
        signal: AbortSignal,
        force?: boolean,
    ) => Promise<StoredCredential>;
    readonly requestAuthorization: (
        server: DiscoveredT3Server,
        accessToken: string,
        signal: AbortSignal,
    ) => Promise<WebSocketAuthorization>;
    readonly connectRpc: (
        authorization: WebSocketAuthorization,
        signal: AbortSignal,
    ) => Promise<T3RpcSession>;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly random?: () => number;
    readonly now?: () => number;
}

export interface T3ConnectionLoopOptions {
    readonly config: AppConfig;
    readonly credentials: CredentialStore;
    readonly presence: PresencePublisher;
    readonly status: DaemonStatusSink;
    readonly logger: Logger;
    readonly signal: AbortSignal;
    readonly dependencies: T3ConnectionDependencies;
    readonly pollIntervalMs?: number;
    readonly retryBaseMs?: number;
    readonly retryMaxMs?: number;
}

interface DeferredFailure {
    readonly promise: Promise<never>;
    reject(error: unknown): void;
}

function waitForAbort(signal: AbortSignal): {
    readonly promise: Promise<void>;
    dispose(): void;
} {
    let onAbort: (() => void) | undefined;
    const promise = signal.aborted
        ? Promise.resolve()
        : new Promise<void>(resolve => {
            onAbort = () => resolve();
            signal.addEventListener("abort", onAbort, { once: true });
        });
    return {
        promise,
        dispose() {
            if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
        },
    };
}

function deferredFailure(): DeferredFailure {
    let settled = false;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<never>((_resolve, reject) => {
        rejectPromise = reject;
    });
    return {
        promise,
        reject(error) {
            if (settled) return;
            settled = true;
            rejectPromise(error);
        },
    };
}

function selectedThreadIsActive(selected: SelectedPresenceSource): boolean {
    return selected.threadId !== undefined && (
        selected.status === "running"
        || selected.status === "starting"
        || selected.status === "working"
        || selected.status === "monitoring"
        || selected.status === "waiting-for-approval"
        || selected.status === "waiting-for-input"
    );
}

function safeErrorType(error: unknown): string {
    if (error instanceof T3AuthError) return "T3AuthError";
    if (isAbortError(error)) return "AbortError";
    return error instanceof Error && [
        "T3RpcClosedError",
        "T3RpcConnectionError",
        "T3RpcDisconnectedError",
        "T3RpcSubscriptionError",
    ].includes(error.name)
        ? error.name
        : "Error";
}

async function safeLog(
    logger: Logger,
    level: "debug" | "info" | "warn",
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
): Promise<void> {
    await logger[level](message, metadata).catch(() => undefined);
}

type T3DebugMetadata = Readonly<{
    eventType?: string;
    threadId?: string;
    sessionStatus?: string;
    activityKind?: string;
    timestamp?: string;
}>;

const debugSessionStatuses = new Set([
    "idle",
    "starting",
    "running",
    "ready",
    "interrupted",
    "stopped",
    "error",
    "working",
    "monitoring",
    "waiting-for-approval",
    "waiting-for-input",
]);

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : undefined;
}

function debugClassifier(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const candidate = value.trim();
    return candidate.length > 0
        && candidate.length <= 128
        && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(candidate)
        ? candidate
        : undefined;
}

function debugThreadId(value: unknown): string | undefined {
    const candidate = debugClassifier(value);
    return candidate !== undefined && candidate.length <= 128 ? candidate : undefined;
}

function debugTimestamp(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function debugSessionStatus(value: unknown): string | undefined {
    return typeof value === "string" && debugSessionStatuses.has(value) ? value : undefined;
}

function streamDebugMetadata(item: unknown, fallbackThreadId?: string): T3DebugMetadata {
    const record = asRecord(item);
    if (record === undefined) return {};
    const event = asRecord(record.event);
    const payload = asRecord(event?.payload);
    const snapshot = asRecord(record.snapshot);
    const thread = asRecord(record.thread)
        ?? asRecord(payload?.thread)
        ?? asRecord(snapshot?.thread);
    const session = asRecord(thread?.session) ?? asRecord(payload?.session);
    const activity = asRecord(payload?.activity);
    const eventType = debugClassifier(event?.type) ?? debugClassifier(record.kind);
    const threadId = debugThreadId(payload?.threadId)
        ?? debugThreadId(thread?.id)
        ?? debugThreadId(event?.aggregateId)
        ?? debugThreadId(record.threadId)
        ?? debugThreadId(fallbackThreadId);
    const sessionStatus = debugSessionStatus(session?.status);
    const activityKind = debugClassifier(activity?.kind);
    const timestamp = debugTimestamp(activity?.createdAt)
        ?? debugTimestamp(event?.createdAt)
        ?? debugTimestamp(thread?.updatedAt)
        ?? debugTimestamp(record.updatedAt);
    return {
        ...(eventType === undefined ? {} : { eventType }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(sessionStatus === undefined ? {} : { sessionStatus }),
        ...(activityKind === undefined ? {} : { activityKind }),
        ...(timestamp === undefined ? {} : { timestamp }),
    };
}

function selectionDebugMetadata(selected: SelectedPresenceSource): T3DebugMetadata {
    const threadId = debugThreadId(selected.threadId);
    const sessionStatus = debugSessionStatus(selected.status);
    const activityKind = debugClassifier(selected.activity.replaceAll(" ", "-"));
    const timestamp = debugTimestamp(selected.startedAt);
    return {
        eventType: "selection",
        ...(threadId === undefined ? {} : { threadId }),
        ...(sessionStatus === undefined ? {} : { sessionStatus }),
        ...(activityKind === undefined ? {} : { activityKind }),
        ...(timestamp === undefined ? {} : { timestamp }),
    };
}

class ConnectedT3State {
    readonly #config: AppConfig;
    readonly #logger: Logger;
    readonly #presence: PresencePublisher;
    readonly #session: T3RpcSession;
    readonly #signal: AbortSignal;
    readonly #now: () => number;
    readonly #failure = deferredFailure();
    #state: PresenceSourceState = createPresenceSourceState();
    #shell: T3RpcSubscription | undefined;
    #focused: T3RpcSubscription | undefined;
    #focusedThreadId: string | undefined;
    #focusRevision = 0;
    #focusQueue: Promise<void> = Promise.resolve();
    #selectionFingerprint: string | undefined;

    constructor(
        session: T3RpcSession,
        options: Pick<T3ConnectionLoopOptions, "config" | "logger" | "presence" | "signal">,
        now: () => number,
    ) {
        this.#session = session;
        this.#config = options.config;
        this.#logger = options.logger;
        this.#presence = options.presence;
        this.#signal = options.signal;
        this.#now = now;
    }

    async subscribe(): Promise<void> {
        this.#shell = await this.#session.subscribeShell(item => {
            void safeLog(this.#logger, "debug", "t3 shell event", streamDebugMetadata(item));
            this.#state = applyShellStreamItem(this.#state, item);
            this.#publishSelection();
        }, { signal: this.#signal, requestCompletionMarker: true });
    }

    async waitUntilClosed(): Promise<void> {
        if (this.#shell === undefined) {
            throw new Error("T3 shell subscription was not started");
        }
        const aborted = waitForAbort(this.#signal);
        try {
            await Promise.race([
                this.#session.closed,
                this.#shell.closed,
                this.#failure.promise,
                aborted.promise,
            ]);
        } finally {
            aborted.dispose();
        }
    }

    async close(): Promise<void> {
        this.#focusRevision += 1;
        await this.#focusQueue.catch(() => undefined);
        await this.#focused?.close().catch(() => undefined);
        await this.#shell?.close().catch(() => undefined);
        await this.#session.close().catch(() => undefined);
    }

    #publishSelection(): void {
        const selected = selectPresenceSource(this.#state, { now: this.#now() });
        this.#presence.setDesiredActivity(buildDiscordActivity(selected, {
            presence: this.#config.presence,
            discord: this.#config.discord,
        }));
        const selectionFingerprint = JSON.stringify({
            threadId: selected.threadId,
            status: selected.status,
            activity: selected.activity,
            startedAt: selected.startedAt,
            activeAgentCount: selected.activeAgentCount,
        });
        if (selectionFingerprint !== this.#selectionFingerprint) {
            this.#selectionFingerprint = selectionFingerprint;
            void safeLog(
                this.#logger,
                "debug",
                "presence selection changed",
                selectionDebugMetadata(selected),
            );
        }
        this.#scheduleFocusedThread(selected);
    }

    #scheduleFocusedThread(selected: SelectedPresenceSource): void {
        const desiredThreadId = selectedThreadIsActive(selected) ? selected.threadId : undefined;
        if (desiredThreadId === this.#focusedThreadId) return;
        const revision = this.#focusRevision + 1;
        this.#focusRevision = revision;
        this.#focusQueue = this.#focusQueue
            .catch(() => undefined)
            .then(async () => {
                if (revision !== this.#focusRevision || this.#signal.aborted) return;
                await this.#focused?.close();
                this.#focused = undefined;
                this.#focusedThreadId = undefined;
                if (desiredThreadId === undefined) return;
                const subscription = await this.#session.subscribeThread(
                    desiredThreadId,
                    item => {
                        void safeLog(
                            this.#logger,
                            "debug",
                            "t3 thread event",
                            streamDebugMetadata(item, desiredThreadId),
                        );
                        this.#state = applyThreadStreamItem(this.#state, desiredThreadId, item);
                        this.#publishSelection();
                    },
                    {
                        signal: this.#signal,
                        requestCompletionMarker: true,
                        turnLimit: 1,
                    },
                );
                if (revision !== this.#focusRevision || this.#signal.aborted) {
                    await subscription.close();
                    return;
                }
                this.#focused = subscription;
                this.#focusedThreadId = desiredThreadId;
                void subscription.closed.catch(error => this.#failure.reject(error));
            });
        void this.#focusQueue.catch(error => this.#failure.reject(error));
    }
}

function authStatus(error: unknown): DaemonStatusPatch {
    if (isAuthorizationRejected(error)) {
        return { auth: "expired", t3: "error", message: "T3 authentication expired" };
    }
    if (
        error instanceof T3AuthError
        && (error.code === "pairing-unavailable" || error.code === "pairing-failed")
    ) {
        return { auth: "required", t3: "error", message: "T3 authorization is required" };
    }
    return { t3: "error", message: "T3 connection failed" };
}

export async function runT3ConnectionLoop(options: T3ConnectionLoopOptions): Promise<void> {
    const {
        credentials,
        dependencies,
        logger,
        presence,
        signal,
        status,
    } = options;
    const wait = dependencies.wait ?? waitForAbortableDelay;
    const random = dependencies.random ?? Math.random;
    const now = dependencies.now ?? Date.now;
    const pollIntervalMs = options.pollIntervalMs ?? 3_000;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
        throw new RangeError("pollIntervalMs must be a positive safe integer");
    }
    let attempt = 0;
    let forceAuthorization = false;
    let waitingWasLogged = false;

    while (!signal.aborted) {
        let server: DiscoveredT3Server | undefined;
        let connected: ConnectedT3State | undefined;
        let serverWasAbsent = false;
        let phase: "discovery" | "authorization" | "ticket" | "rpc" | "subscription" = "discovery";
        try {
            await status.update({ t3: "waiting", message: "waiting for T3 Code" });
            server = await dependencies.discover(signal);
            if (signal.aborted) break;
            if (server === undefined) {
                serverWasAbsent = true;
                attempt = 0;
                if (!waitingWasLogged) {
                    waitingWasLogged = true;
                    await safeLog(logger, "info", "waiting for t3");
                }
            } else {
                waitingWasLogged = false;
                await safeLog(logger, "info", "found t3 server", {
                    environmentId: server.descriptor.environmentId,
                    serverVersion: server.descriptor.serverVersion,
                });
                phase = "authorization";
                await status.update({
                    t3: "connecting",
                    auth: "authorizing",
                    environmentId: server.descriptor.environmentId,
                    serverVersion: server.descriptor.serverVersion,
                    message: "authorizing with T3 Code",
                });
                const credential = await dependencies.authorize(
                    server,
                    credentials,
                    signal,
                    forceAuthorization,
                );
                forceAuthorization = false;
                phase = "ticket";
                const authorization = await dependencies.requestAuthorization(
                    server,
                    credential.accessToken,
                    signal,
                );
                phase = "rpc";
                const session = await dependencies.connectRpc(authorization, signal);
                connected = new ConnectedT3State(session, options, now);
                phase = "subscription";
                await connected.subscribe();
                attempt = 0;
                await status.update({
                    t3: "connected",
                    auth: "valid",
                    message: "connected to T3 Code",
                });
                await safeLog(logger, "info", "connected to t3", {
                    environmentId: server.descriptor.environmentId,
                    serverVersion: server.descriptor.serverVersion,
                });
                await connected.waitUntilClosed();
                if (!signal.aborted) throw new Error("T3 subscription ended");
            }
        } catch (error) {
            if (signal.aborted || isAbortError(error)) break;
            if (server !== undefined && isAuthorizationRejected(error)) {
                forceAuthorization = true;
                await credentials.delete(server.descriptor.environmentId).catch(() => undefined);
                await safeLog(logger, "warn", "authentication expired", {
                    status: error.status,
                });
            } else {
                await safeLog(logger, "warn", "t3 connection interrupted", {
                    phase,
                    errorType: safeErrorType(error),
                });
            }
            await status.update(authStatus(error));
        } finally {
            await connected?.close();
            if (presence.setDesiredActivity(null)) {
                await safeLog(logger, "debug", "presence cleared", { reason: "t3-unavailable" });
            }
        }

        if (signal.aborted) break;
        await status.update({ t3: "waiting", message: "waiting for T3 Code" });
        const delay = serverWasAbsent
            ? pollIntervalMs
            : reconnectDelay(
                attempt,
                options.retryBaseMs,
                options.retryMaxMs,
                random,
            );
        if (!serverWasAbsent) attempt += 1;
        try {
            await wait(delay, signal);
        } catch (error) {
            if (!signal.aborted && !isAbortError(error)) throw error;
        }
    }
    presence.setDesiredActivity(null);
}
