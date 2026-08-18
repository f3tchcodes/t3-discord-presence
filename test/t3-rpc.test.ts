import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
    connectT3RpcSession,
    T3RpcConnectionError,
    T3RpcDisconnectedError,
    T3RpcSubscriptionError,
    withT3RpcSession,
} from "../src/t3/rpc.js";

interface RpcRequest {
    readonly _tag: "Request";
    readonly id: string | number;
    readonly tag: string;
    readonly payload: unknown;
}

class FakeWebSocket extends EventTarget {
    static readonly instances: Array<FakeWebSocket> = [];

    readonly sent: Array<string> = [];
    readyState = 0;

    constructor() {
        super();
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
        });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    }

    close(code = 1000, reason = ""): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }

    receive(message: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }

    disconnect(): void {
        this.close(1006, "connection lost");
    }

    requests(): ReadonlyArray<RpcRequest> {
        return this.sent
            .map(message => JSON.parse(message) as unknown)
            .filter((message): message is RpcRequest => (
                typeof message === "object"
                && message !== null
                && "_tag" in message
                && message._tag === "Request"
            ));
    }
}

const authorization = { url: "ws://127.0.0.1:3773/ws?wsTicket=fresh-ticket" };
let originalWebSocket: typeof WebSocket;

function after(milliseconds: number, value: string): Promise<string> {
    return new Promise(resolve => setTimeout(() => resolve(value), milliseconds));
}

beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    FakeWebSocket.instances.length = 0;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
});

test("runs shell and thread subscriptions concurrently and closes every handle", async () => {
    const session = await connectT3RpcSession(authorization);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    const received: Array<unknown> = [];
    const threadAbort = new AbortController();
    const [shell, firstThread, secondThread] = await Promise.all([
        session.subscribeShell(item => {
            received.push(item);
        }, { requestCompletionMarker: true }),
        session.subscribeThread("thread-1", item => {
            received.push(item);
        }, {
            afterSequence: 4,
            signal: threadAbort.signal,
            turnLimit: 3,
        }),
        session.subscribeThread("thread-2", item => {
            received.push(item);
        }),
    ]);

    await vi.waitFor(() => expect(socket?.requests()).toHaveLength(3));
    const requests = socket?.requests() ?? [];
    expect(requests.map(request => request.tag)).toEqual([
        "orchestration.subscribeShell",
        "orchestration.subscribeThread",
        "orchestration.subscribeThread",
    ]);
    expect(requests[0]?.payload).toEqual({ requestCompletionMarker: true });
    expect(requests[1]?.payload).toEqual({ threadId: "thread-1", afterSequence: 4, turnLimit: 3 });

    socket?.receive({
        _tag: "Chunk",
        requestId: requests[0]?.id,
        values: [{ kind: "synchronized" }],
    });
    await vi.waitFor(() => expect(received).toEqual([{ kind: "synchronized" }]));

    threadAbort.abort();
    await firstThread.closed;
    await session.close();

    await expect(Promise.all([shell.closed, secondThread.closed, session.closed])).resolves.toEqual([
        undefined,
        undefined,
        undefined,
    ]);
    expect(socket?.readyState).toBe(3);
});

test("surfaces an unexpected disconnect to the session and subscriptions", async () => {
    const session = await connectT3RpcSession(authorization);
    const subscription = await session.subscribeShell(() => undefined);
    const socket = FakeWebSocket.instances[0];
    const sessionFailure = session.closed.catch(error => error as unknown);
    const subscriptionFailure = subscription.closed.catch(error => error as unknown);

    await vi.waitFor(() => expect(socket?.requests()).toHaveLength(1));
    socket?.disconnect();

    await expect(Promise.race([sessionFailure, after(500, "session timeout")]))
        .resolves.toBeInstanceOf(T3RpcDisconnectedError);
    await expect(Promise.race([subscriptionFailure, after(500, "subscription timeout")]))
        .resolves.toBeInstanceOf(T3RpcSubscriptionError);
    await expect(Promise.race([session.close(), after(500, "close timeout")]))
        .resolves.toBeUndefined();
});

test("rejects URLs that omit a websocket ticket or expose a bearer", async () => {
    await expect(connectT3RpcSession({ url: "ws://127.0.0.1:3773/ws" }))
        .rejects.toBeInstanceOf(T3RpcConnectionError);
    await expect(connectT3RpcSession({
        url: "ws://127.0.0.1:3773/ws?wsTicket=ticket&access_token=bearer",
    })).rejects.toBeInstanceOf(T3RpcConnectionError);
    expect(FakeWebSocket.instances).toHaveLength(0);
});

test("the scoped helper closes the websocket when its callback fails", async () => {
    const failure = new Error("callback failed");
    await expect(withT3RpcSession(authorization, () => {
        throw failure;
    })).rejects.toBe(failure);
    expect(FakeWebSocket.instances[0]?.readyState).toBe(3);
});
