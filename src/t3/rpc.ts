import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export const T3_RPC_METHODS = {
    subscribeShell: "orchestration.subscribeShell",
    subscribeThread: "orchestration.subscribeThread",
} as const;

const SubscribeShellRpc = Rpc.make(T3_RPC_METHODS.subscribeShell, {
    payload: Schema.Struct({
        afterSequence: Schema.optionalKey(Schema.Number),
        requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
    }),
    success: Schema.Unknown,
    error: Schema.Unknown,
    stream: true,
});

const SubscribeThreadRpc = Rpc.make(T3_RPC_METHODS.subscribeThread, {
    payload: Schema.Struct({
        threadId: Schema.String,
        afterSequence: Schema.optionalKey(Schema.Number),
        requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
        turnLimit: Schema.optionalKey(Schema.Number),
    }),
    success: Schema.Unknown,
    error: Schema.Unknown,
    stream: true,
});

export const T3RpcGroup = RpcGroup.make(SubscribeShellRpc, SubscribeThreadRpc);
const makeT3RpcClient = RpcClient.make(T3RpcGroup);

export interface T3WebSocketAuthorization {
    readonly url: string;
}

export interface T3RpcConnectOptions {
    readonly openTimeoutMs?: number;
    readonly signal?: AbortSignal;
}

export interface T3RpcSubscriptionOptions {
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly signal?: AbortSignal;
}

export interface T3RpcThreadSubscriptionOptions extends T3RpcSubscriptionOptions {
    readonly turnLimit?: number;
}

export type T3RpcStreamHandler = (item: unknown) => void | PromiseLike<void>;

export interface T3RpcSubscription {
    readonly closed: Promise<void>;
    close(): Promise<void>;
}

export interface T3RpcSession {
    readonly closed: Promise<void>;
    subscribeShell(
        onItem: T3RpcStreamHandler,
        options?: T3RpcSubscriptionOptions,
    ): Promise<T3RpcSubscription>;
    subscribeThread(
        threadId: string,
        onItem: T3RpcStreamHandler,
        options?: T3RpcThreadSubscriptionOptions,
    ): Promise<T3RpcSubscription>;
    close(): Promise<void>;
}

export class T3RpcConnectionError extends Error {}

export class T3RpcDisconnectedError extends Error {}

export class T3RpcSubscriptionError extends Error {
    readonly method: string;

    constructor(method: string, cause: unknown) {
        super(`T3 RPC subscription ${method} failed.`, { cause });
        this.method = method;
    }
}

export class T3RpcClosedError extends Error {}

interface DeferredPromise<A> {
    readonly promise: Promise<A>;
    readonly settled: () => boolean;
    readonly resolve: (value: A | PromiseLike<A>) => void;
    readonly reject: (reason?: unknown) => void;
}

function makeDeferred<A>(): DeferredPromise<A> {
    let isSettled = false;
    let resolvePromise!: (value: A | PromiseLike<A>) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<A>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        settled: () => isSettled,
        resolve: value => {
            if (isSettled) return;
            isSettled = true;
            resolvePromise(value);
        },
        reject: reason => {
            if (isSettled) return;
            isSettled = true;
            rejectPromise(reason);
        },
    };
}

function abortError(): Error {
    return new DOMException("The T3 RPC operation was aborted.", "AbortError");
}

function validateAuthorizationUrl(value: string): string {
    try {
        const url = new URL(value);
        const ticket = url.searchParams.get("wsTicket");
        const forbiddenParameters = ["access_token", "authorization", "bearer", "token"];
        if (
            (url.protocol !== "ws:" && url.protocol !== "wss:")
            || url.username.length > 0
            || url.password.length > 0
            || ticket === null
            || ticket.length === 0
            || forbiddenParameters.some(parameter => url.searchParams.has(parameter))
        ) {
            throw new Error("invalid websocket authorization url");
        }
        return url.href;
    } catch (cause) {
        throw new T3RpcConnectionError("Invalid T3 WebSocket authorization URL.", { cause });
    }
}

function validateSequence(value: number | undefined, field: string): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new RangeError(`${field} must be a non-negative safe integer.`);
    }
}

function validateTurnLimit(value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new RangeError("turnLimit must be a positive safe integer.");
    }
}

class ManagedSubscription implements T3RpcSubscription {
    readonly closed: Promise<void>;
    private readonly completion = makeDeferred<void>();
    private readonly onAbort = () => void this.close();
    private readonly method: string;
    private readonly onItem: T3RpcStreamHandler;
    private readonly removeFromSession: (subscription: ManagedSubscription) => void;
    private readonly signal: AbortSignal | undefined;
    private readonly stream: Stream.Stream<unknown, unknown>;
    private cancel: (() => void) | undefined;
    private closing = false;
    private closePromise: Promise<void> | undefined;
    private failure: T3RpcSubscriptionError | undefined;

    constructor(
        method: string,
        stream: Stream.Stream<unknown, unknown>,
        onItem: T3RpcStreamHandler,
        signal: AbortSignal | undefined,
        removeFromSession: (subscription: ManagedSubscription) => void,
    ) {
        this.closed = this.completion.promise;
        void this.closed.catch(() => undefined);
        this.method = method;
        this.stream = stream;
        this.onItem = onItem;
        this.removeFromSession = removeFromSession;
        this.signal = signal;
    }

    start(): void {
        const run = Stream.runForEach(this.stream, item => Effect.tryPromise({
            try: () => Promise.resolve(this.onItem(item)),
            catch: cause => new T3RpcSubscriptionError(this.method, cause),
        }));
        this.cancel = Effect.runCallback(run, {
            onExit: exit => {
                this.cancel = undefined;
                this.signal?.removeEventListener("abort", this.onAbort);
                this.removeFromSession(this);
                if (this.failure !== undefined) {
                    this.completion.reject(this.failure);
                    return;
                }
                if (this.closing) {
                    this.completion.resolve(undefined);
                    return;
                }
                const cause = Exit.isFailure(exit)
                    ? Cause.squash(exit.cause)
                    : new Error("The subscription stream ended.");
                this.completion.reject(new T3RpcSubscriptionError(this.method, cause));
            },
        });
        this.signal?.addEventListener("abort", this.onAbort, { once: true });
        if (this.signal?.aborted) void this.close();
    }

    close(): Promise<void> {
        if (this.closePromise !== undefined) return this.closePromise;
        this.closing = true;
        this.signal?.removeEventListener("abort", this.onAbort);
        this.cancel?.();
        this.closePromise = this.completion.promise.catch(() => undefined);
        return this.closePromise;
    }

    fail(cause: unknown): void {
        if (this.completion.settled() || this.failure !== undefined) return;
        this.failure = new T3RpcSubscriptionError(this.method, cause);
        this.signal?.removeEventListener("abort", this.onAbort);
        this.removeFromSession(this);
        this.completion.reject(this.failure);
        this.cancel?.();
    }
}

type T3RpcClient = Effect.Success<typeof makeT3RpcClient>;

class ManagedSession implements T3RpcSession {
    readonly closed: Promise<void>;
    private readonly client: T3RpcClient;
    private readonly completion: DeferredPromise<void>;
    private readonly onAbort = () => void this.close();
    private readonly scope: Scope.Closeable;
    private readonly signal: AbortSignal | undefined;
    private readonly subscriptions = new Set<ManagedSubscription>();
    private closing = false;
    private closePromise: Promise<void> | undefined;

    constructor(
        client: T3RpcClient,
        scope: Scope.Closeable,
        completion: DeferredPromise<void>,
        signal: AbortSignal | undefined,
    ) {
        this.client = client;
        this.scope = scope;
        this.completion = completion;
        this.closed = completion.promise;
        void this.closed.catch(() => undefined);
        this.signal = signal;
        signal?.addEventListener("abort", this.onAbort, { once: true });
    }

    async subscribeShell(
        onItem: T3RpcStreamHandler,
        options: T3RpcSubscriptionOptions = {},
    ): Promise<T3RpcSubscription> {
        this.assertOpen(options.signal);
        validateSequence(options.afterSequence, "afterSequence");
        const stream = this.client[T3_RPC_METHODS.subscribeShell]({
            ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
            ...(options.requestCompletionMarker === undefined
                ? {}
                : { requestCompletionMarker: options.requestCompletionMarker }),
        });
        return this.startSubscription(
            T3_RPC_METHODS.subscribeShell,
            stream,
            onItem,
            options.signal,
        );
    }

    async subscribeThread(
        threadId: string,
        onItem: T3RpcStreamHandler,
        options: T3RpcThreadSubscriptionOptions = {},
    ): Promise<T3RpcSubscription> {
        this.assertOpen(options.signal);
        if (threadId.trim().length === 0) throw new TypeError("threadId must not be empty.");
        validateSequence(options.afterSequence, "afterSequence");
        validateTurnLimit(options.turnLimit);
        const stream = this.client[T3_RPC_METHODS.subscribeThread]({
            threadId,
            ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
            ...(options.requestCompletionMarker === undefined
                ? {}
                : { requestCompletionMarker: options.requestCompletionMarker }),
            ...(options.turnLimit === undefined ? {} : { turnLimit: options.turnLimit }),
        });
        return this.startSubscription(
            T3_RPC_METHODS.subscribeThread,
            stream,
            onItem,
            options.signal,
        );
    }

    close(): Promise<void> {
        if (this.closePromise !== undefined) return this.closePromise;
        this.closing = true;
        this.signal?.removeEventListener("abort", this.onAbort);
        this.closePromise = (async () => {
            await Promise.all([...this.subscriptions].map(subscription => subscription.close()));
            await Effect.runPromise(Scope.close(this.scope, Exit.void));
            this.completion.resolve(undefined);
        })();
        return this.closePromise;
    }

    private assertOpen(signal: AbortSignal | undefined): void {
        if (signal?.aborted) throw abortError();
        if (this.closing || this.completion.settled()) {
            throw new T3RpcClosedError("The T3 RPC session is closed.");
        }
    }

    private startSubscription(
        method: string,
        stream: Stream.Stream<unknown, unknown>,
        onItem: T3RpcStreamHandler,
        signal: AbortSignal | undefined,
    ): T3RpcSubscription {
        const subscription = new ManagedSubscription(
            method,
            stream,
            onItem,
            signal,
            settled => this.subscriptions.delete(settled),
        );
        this.subscriptions.add(subscription);
        subscription.start();
        return subscription;
    }

    disconnected(): void {
        if (this.closing) {
            this.completion.resolve(undefined);
        } else {
            const error = new T3RpcDisconnectedError("The T3 WebSocket disconnected.");
            for (const subscription of this.subscriptions) subscription.fail(error);
            this.completion.reject(error);
        }
    }
}

export async function connectT3RpcSession(
    authorization: T3WebSocketAuthorization,
    options: T3RpcConnectOptions = {},
): Promise<T3RpcSession> {
    if (options.signal?.aborted) throw abortError();
    const url = validateAuthorizationUrl(authorization.url);
    const openTimeoutMs = options.openTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1) {
        throw new RangeError("openTimeoutMs must be a positive safe integer.");
    }

    const scope = await Effect.runPromise(Scope.make());
    const connected = makeDeferred<void>();
    const completion = makeDeferred<void>();
    let session: ManagedSession | undefined;
    let constructing = true;
    const hooks = RpcClient.ConnectionHooks.of({
        onConnect: Effect.sync(() => connected.resolve(undefined)),
        onDisconnect: Effect.sync(() => {
            if (session !== undefined) {
                session.disconnected();
            } else if (constructing) {
                const error = new T3RpcConnectionError("Could not establish the T3 WebSocket connection.");
                connected.reject(error);
                completion.reject(error);
            }
        }),
    });

    try {
        const socketLayer = Socket.layerWebSocket(url, { openTimeout: openTimeoutMs }).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
        );
        const protocolLayer = Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({
                retryTransientErrors: false,
                retryPolicy: Schedule.recurs(0),
            }),
        ).pipe(
            Layer.provide(Layer.mergeAll(
                socketLayer,
                RpcSerialization.layerJson,
                Layer.succeed(RpcClient.ConnectionHooks, hooks),
            )),
        );
        const protocolContext = await Effect.runPromise(
            Layer.build(protocolLayer).pipe(Scope.provide(scope)),
        );
        const client = await Effect.runPromise(
            makeT3RpcClient.pipe(
                Effect.provide(protocolContext),
                Scope.provide(scope),
            ),
        );
        session = new ManagedSession(client, scope, completion, options.signal);
        constructing = false;
        await Promise.race([connected.promise, completion.promise]);
        if (options.signal?.aborted) {
            await session.close();
            throw abortError();
        }
        return session;
    } catch (cause) {
        constructing = false;
        await session?.close();
        await Effect.runPromise(Scope.close(scope, Exit.void));
        if (
            cause instanceof T3RpcConnectionError
            || cause instanceof T3RpcDisconnectedError
            || (cause instanceof DOMException && cause.name === "AbortError")
        ) {
            throw cause;
        }
        throw new T3RpcConnectionError("Could not create the T3 RPC session.", { cause });
    }
}

export async function withT3RpcSession<A>(
    authorization: T3WebSocketAuthorization,
    use: (session: T3RpcSession) => A | PromiseLike<A>,
    options: T3RpcConnectOptions = {},
): Promise<A> {
    const session = await connectT3RpcSession(authorization, options);
    try {
        return await use(session);
    } finally {
        await session.close();
    }
}
