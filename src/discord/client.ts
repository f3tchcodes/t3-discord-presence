import { Client } from "@xhayper/discord-rpc";

import { discordActivitySemanticKey } from "./activity.js";
import type {
    DiscordActivity,
    DiscordConnectionState,
    DiscordPresenceClient,
} from "./types.js";

export interface DiscordManagerOptions {
    readonly clientId: string;
    readonly createClient?: (clientId: string) => DiscordPresenceClient;
    readonly debounceMs?: number;
    readonly operationTimeoutMs?: number;
    readonly retryBaseMs?: number;
    readonly retryMaxMs?: number;
    readonly random?: () => number;
    readonly onError?: (error: unknown) => void;
    readonly onStateChange?: (state: DiscordConnectionState) => void;
}

class LocalDiscordClient implements DiscordPresenceClient {
    readonly #client: Client;

    constructor(clientId: string) {
        this.#client = new Client({ clientId });
    }

    async login(): Promise<void> {
        await this.#client.login();
    }

    async setActivity(activity: DiscordActivity): Promise<void> {
        const user = this.#client.user;
        if (user === undefined) throw new Error("Discord RPC connected without a user");
        await user.setActivity(activity, process.pid);
    }

    async clearActivity(): Promise<void> {
        const user = this.#client.user;
        if (user !== undefined) await user.clearActivity(process.pid);
    }

    async destroy(): Promise<void> {
        await this.#client.destroy();
    }

    onDisconnected(listener: () => void): () => void {
        this.#client.on("disconnected", listener);
        return () => this.#client.off("disconnected", listener);
    }
}

function abortError(): Error {
    return new DOMException("The operation was aborted", "AbortError");
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(abortError());
        };
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Discord RPC operation timed out")), milliseconds);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export function discordRetryDelay(
    attempt: number,
    baseMs = 1_000,
    maximumMs = 30_000,
    random = Math.random,
): number {
    const exponential = Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempt));
    const jitter = 0.8 + random() * 0.4;
    return Math.max(0, Math.min(maximumMs, Math.round(exponential * jitter)));
}

function withoutOptionalAssets(activity: DiscordActivity): DiscordActivity | undefined {
    if (
        activity.largeImageKey === undefined
        && activity.smallImageKey === undefined
        && activity.largeImageUrl === undefined
        && activity.smallImageUrl === undefined
    ) {
        return undefined;
    }
    const withoutImages = { ...activity };
    delete withoutImages.largeImageKey;
    delete withoutImages.largeImageText;
    delete withoutImages.largeImageUrl;
    delete withoutImages.smallImageKey;
    delete withoutImages.smallImageText;
    delete withoutImages.smallImageUrl;
    return withoutImages;
}

export class DiscordConnectionManager {
    readonly #options: Required<Pick<
        DiscordManagerOptions,
        "debounceMs" | "operationTimeoutMs" | "retryBaseMs" | "retryMaxMs" | "random"
    >> & DiscordManagerOptions;
    #desired: DiscordActivity | null = null;
    #desiredKey = discordActivitySemanticKey(null);
    #revision = 0;
    #wake: (() => void) | undefined;
    #running = false;

    constructor(options: DiscordManagerOptions) {
        if (options.clientId.trim().length === 0) {
            throw new Error("Discord client id is required");
        }
        this.#options = {
            ...options,
            debounceMs: options.debounceMs ?? 500,
            operationTimeoutMs: options.operationTimeoutMs ?? 15_000,
            retryBaseMs: options.retryBaseMs ?? 1_000,
            retryMaxMs: options.retryMaxMs ?? 30_000,
            random: options.random ?? Math.random,
        };
    }

    setDesiredActivity(activity: DiscordActivity | null): boolean {
        const key = discordActivitySemanticKey(activity);
        if (key === this.#desiredKey) return false;
        this.#desired = activity === null ? null : { ...activity };
        this.#desiredKey = key;
        this.#revision += 1;
        this.#wakeCurrentWait();
        return true;
    }

    async run(signal: AbortSignal): Promise<void> {
        if (this.#running) throw new Error("Discord connection manager is already running");
        this.#running = true;
        let attempt = 0;
        try {
            while (!signal.aborted) {
                const client = (this.#options.createClient ?? (id => new LocalDiscordClient(id)))(
                    this.#options.clientId,
                );
                let disconnected = false;
                let connected = false;
                let activityPublished = false;
                const removeDisconnectListener = client.onDisconnected(() => {
                    disconnected = true;
                    this.#wakeCurrentWait();
                });
                try {
                    this.#setState("connecting");
                    await withTimeout(client.login(), this.#options.operationTimeoutMs);
                    if (signal.aborted) break;
                    connected = true;
                    attempt = 0;
                    this.#setState("connected");
                    let publishedKey: string | undefined;
                    let firstPublish = true;

                    while (!signal.aborted && !disconnected) {
                        const revision = this.#revision;
                        if (!firstPublish && this.#options.debounceMs > 0) {
                            await waitForDelay(this.#options.debounceMs, signal);
                            if (revision !== this.#revision) continue;
                        }
                        firstPublish = false;

                        const desiredKey = this.#desiredKey;
                        const desired = this.#desired === null ? null : { ...this.#desired };
                        if (publishedKey !== desiredKey) {
                            if (desired === null) {
                                if (activityPublished) {
                                    await withTimeout(
                                        client.clearActivity(),
                                        this.#options.operationTimeoutMs,
                                    );
                                }
                                activityPublished = false;
                            } else {
                                try {
                                    await withTimeout(
                                        client.setActivity(desired),
                                        this.#options.operationTimeoutMs,
                                    );
                                } catch (error) {
                                    const fallback = withoutOptionalAssets(desired);
                                    if (fallback === undefined) throw error;
                                    this.#options.onError?.(error);
                                    await withTimeout(
                                        client.setActivity(fallback),
                                        this.#options.operationTimeoutMs,
                                    );
                                }
                                activityPublished = true;
                            }
                            publishedKey = desiredKey;
                        }
                        await this.#waitForWake(revision, signal, () => disconnected);
                    }
                } catch (error) {
                    if (!signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
                        this.#options.onError?.(error);
                    }
                } finally {
                    removeDisconnectListener();
                    if (connected && activityPublished && !disconnected) {
                        await withTimeout(
                            client.clearActivity(),
                            this.#options.operationTimeoutMs,
                        ).catch(error => this.#options.onError?.(error));
                    }
                    await withTimeout(client.destroy(), this.#options.operationTimeoutMs).catch(
                        error => this.#options.onError?.(error),
                    );
                }

                if (signal.aborted) break;
                this.#setState("waiting");
                const delay = discordRetryDelay(
                    attempt,
                    this.#options.retryBaseMs,
                    this.#options.retryMaxMs,
                    this.#options.random,
                );
                attempt += 1;
                await waitForDelay(delay, signal).catch(error => {
                    if (!signal.aborted) throw error;
                });
            }
        } finally {
            this.#running = false;
            this.#wakeCurrentWait();
            this.#setState("stopped");
        }
    }

    #setState(state: DiscordConnectionState): void {
        this.#options.onStateChange?.(state);
    }

    #wakeCurrentWait(): void {
        const wake = this.#wake;
        this.#wake = undefined;
        wake?.();
    }

    #waitForWake(
        revision: number,
        signal: AbortSignal,
        disconnected: () => boolean,
    ): Promise<void> {
        if (revision !== this.#revision || signal.aborted || disconnected()) {
            return Promise.resolve();
        }
        return new Promise(resolve => {
            const onAbort = () => finish();
            const finish = () => {
                signal.removeEventListener("abort", onAbort);
                if (this.#wake === finish) this.#wake = undefined;
                resolve();
            };
            this.#wake = finish;
            signal.addEventListener("abort", onAbort, { once: true });
            if (revision !== this.#revision || signal.aborted || disconnected()) finish();
        });
    }
}
