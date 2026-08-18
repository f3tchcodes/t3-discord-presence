import { Client, CUSTOM_RPC_ERROR_CODE } from "@xhayper/discord-rpc";
import { expect, test } from "vitest";

import {
    createCredentialStore,
    CREDENTIAL_SCOPE,
} from "../../src/config/credentials.js";
import { DISCORD_APPLICATION_ID } from "../../src/discord/application.js";
import {
    authorizeT3Server,
    requestWebSocketAuthorization,
} from "../../src/t3/auth.js";
import { discoverT3Server } from "../../src/t3/discovery.js";
import {
    connectT3RpcSession,
    type T3RpcSession,
    type T3RpcSubscription,
} from "../../src/t3/rpc.js";
import {
    applyShellStreamItem,
    applyThreadStreamItem,
    createPresenceSourceState,
    type PresenceSourceState,
    type SelectedPresenceSource,
    selectPresenceSource,
} from "../../src/t3/state.js";

const RUN_REAL_INTEGRATION = process.env.T3_DISCORD_PRESENCE_INTEGRATION === "1";
const integrationTest = RUN_REAL_INTEGRATION ? test : test.skip;
const DISCORD_LOGIN_TIMEOUT_MESSAGE = "Discord RPC login timed out";
const ACTIVE_STATUSES = new Set<SelectedPresenceSource["status"]>([
    "running",
    "starting",
    "working",
    "monitoring",
    "waiting-for-approval",
    "waiting-for-input",
]);

interface Latch {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function makeLatch(): Latch {
    let resolvePromise!: () => void;
    const promise = new Promise<void>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

async function within<T>(
    operation: PromiseLike<T>,
    milliseconds: number,
    timeoutMessage: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), milliseconds);
    });
    try {
        return await Promise.race([Promise.resolve(operation), timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function closesBeforeReady(
    session: T3RpcSession,
    subscription: T3RpcSubscription,
    streamName: string,
): Promise<never> {
    return Promise.race([
        session.closed.then(() => {
            throw new Error(`T3 RPC closed before ${streamName} synchronization`);
        }),
        subscription.closed.then(() => {
            throw new Error(`T3 ${streamName} stream closed before synchronization`);
        }),
    ]);
}

function selectedThreadIsActive(
    selected: SelectedPresenceSource,
): selected is SelectedPresenceSource & { readonly threadId: string } {
    return selected.threadId !== undefined && ACTIVE_STATUSES.has(selected.status);
}

function isDiscordUnavailable(error: unknown): boolean {
    if (error instanceof Error && error.message === DISCORD_LOGIN_TIMEOUT_MESSAGE) return true;
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = error.code;
    return code === CUSTOM_RPC_ERROR_CODE.CONNECTION_ENDED
        || code === CUSTOM_RPC_ERROR_CODE.CONNECTION_TIMEOUT
        || code === CUSTOM_RPC_ERROR_CODE.COULD_NOT_CONNECT
        || code === CUSTOM_RPC_ERROR_CODE.COULD_NOT_FIND_CLIENT;
}

async function verifyDiscordPresence(): Promise<"verified" | "unavailable"> {
    const client = new Client({ clientId: DISCORD_APPLICATION_ID });
    let activitySet = false;
    try {
        await within(client.login(), 10_000, DISCORD_LOGIN_TIMEOUT_MESSAGE);
        const user = client.user;
        if (user === undefined) throw new Error("Discord RPC connected without a user");

        await within(user.setActivity({
            details: "T3 Code integration check",
            state: "read-only presence verification",
        }, process.pid), 5_000, "Discord RPC presence update timed out");
        activitySet = true;
        await within(
            user.clearActivity(process.pid),
            5_000,
            "Discord RPC presence clear timed out",
        );
        activitySet = false;
        return "verified";
    } catch (error) {
        if (isDiscordUnavailable(error)) return "unavailable";
        throw error;
    } finally {
        if (activitySet && client.user !== undefined) {
            await within(
                client.user.clearActivity(process.pid),
                3_000,
                "Discord RPC cleanup timed out",
            ).catch(() => undefined);
        }
        await within(client.destroy(), 5_000, "Discord RPC shutdown timed out")
            .catch(() => undefined);
    }
}

integrationTest("uses only T3 read APIs and safely completes live stream snapshots", async () => {
    const lifetime = new AbortController();
    const lifetimeTimer = setTimeout(() => lifetime.abort(), 35_000);
    let session: T3RpcSession | undefined;
    let shellSubscription: T3RpcSubscription | undefined;
    let threadSubscription: T3RpcSubscription | undefined;
    let stage = "T3 discovery";

    try {
        const server = await discoverT3Server({ timeoutMs: 3_000 });
        if (server === undefined) {
            throw new Error("No verified running T3 environment was discovered");
        }
        expect(server.descriptor.serverVersion.length).toBeGreaterThan(0);

        stage = "read-only T3 authorization";
        const credentialStore = await createCredentialStore();
        const credential = await authorizeT3Server(server, credentialStore, {
            signal: lifetime.signal,
            timeoutMs: 5_000,
        });
        expect(credential.scope).toBe(CREDENTIAL_SCOPE);

        stage = "one-time T3 WebSocket authorization";
        const authorization = await requestWebSocketAuthorization(
            server,
            credential.accessToken,
            { signal: lifetime.signal, timeoutMs: 5_000 },
        );
        stage = "T3 RPC connection";
        session = await connectT3RpcSession(authorization, {
            signal: lifetime.signal,
            openTimeoutMs: 8_000,
        });

        stage = "T3 shell stream synchronization";
        let shellState: PresenceSourceState = createPresenceSourceState();
        const shellSynchronized = makeLatch();
        shellSubscription = await session.subscribeShell(item => {
            shellState = applyShellStreamItem(shellState, item);
            if (shellState.synchronized) shellSynchronized.resolve();
        }, {
            signal: lifetime.signal,
            requestCompletionMarker: true,
        });
        await within(Promise.race([
            shellSynchronized.promise,
            closesBeforeReady(session, shellSubscription, "shell"),
        ]), 10_000, "T3 shell stream synchronization timed out");
        expect(shellState.synchronized).toBe(true);
        expect(shellState.shellSequence !== null).toBe(true);

        const selected = selectPresenceSource(shellState);
        if (selectedThreadIsActive(selected)) {
            stage = "T3 thread stream synchronization";
            const threadId = selected.threadId;
            let detailState = shellState;
            const threadSynchronized = makeLatch();
            threadSubscription = await session.subscribeThread(threadId, item => {
                detailState = applyThreadStreamItem(detailState, threadId, item);
                if (detailState.threads.get(threadId)?.detailSynchronized === true) {
                    threadSynchronized.resolve();
                }
            }, {
                signal: lifetime.signal,
                requestCompletionMarker: true,
                turnLimit: 1,
            });
            await within(Promise.race([
                threadSynchronized.promise,
                closesBeforeReady(session, threadSubscription, "thread"),
            ]), 10_000, "T3 thread stream synchronization timed out");
            expect(detailState.threads.get(threadId)?.detailSynchronized).toBe(true);
            const detailSequence = detailState.threads.get(threadId)?.detailSequence;
            expect(detailSequence !== null && detailSequence !== undefined).toBe(true);
        }

    } catch {
        throw new Error(`Live integration failed during ${stage}`);
    } finally {
        clearTimeout(lifetimeTimer);
        lifetime.abort();
        if (threadSubscription !== undefined) {
            await within(
                threadSubscription.close(),
                3_000,
                "T3 thread stream cleanup timed out",
            ).catch(() => undefined);
        }
        if (shellSubscription !== undefined) {
            await within(
                shellSubscription.close(),
                3_000,
                "T3 shell stream cleanup timed out",
            ).catch(() => undefined);
        }
        if (session !== undefined) {
            await within(session.close(), 5_000, "T3 RPC cleanup timed out")
                .catch(() => undefined);
        }
    }
}, 75_000);

integrationTest("optionally sets and clears the built-in Discord presence", async ({ skip }) => {
    const outcome = await verifyDiscordPresence();
    if (outcome === "unavailable") {
        skip("optional Discord presence stage skipped: Discord Desktop is unavailable");
    }
    expect(outcome).toBe("verified");
}, 30_000);
