import { describe, expect, it, vi } from "vitest";

import {
    DiscordConnectionManager,
    discordRetryDelay,
} from "../src/discord/client.js";
import type { DiscordActivity, DiscordPresenceClient } from "../src/discord/types.js";

class FakeDiscordClient implements DiscordPresenceClient {
    readonly activities: Array<DiscordActivity> = [];
    clearCount = 0;
    destroyCount = 0;
    loginError: Error | undefined;
    rejectImages = false;
    readonly #disconnectListeners = new Set<() => void>();

    async login(): Promise<void> {
        if (this.loginError !== undefined) throw this.loginError;
    }

    async setActivity(activity: DiscordActivity): Promise<void> {
        if (this.rejectImages && activity.largeImageKey !== undefined) {
            this.rejectImages = false;
            throw new Error("unknown image asset");
        }
        this.activities.push(activity);
    }

    async clearActivity(): Promise<void> {
        this.clearCount += 1;
    }

    async destroy(): Promise<void> {
        this.destroyCount += 1;
    }

    onDisconnected(listener: () => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => this.#disconnectListeners.delete(listener);
    }

    disconnect(): void {
        for (const listener of this.#disconnectListeners) listener();
    }
}

async function until(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("condition was not reached");
}

describe("DiscordConnectionManager", () => {
    it("publishes, semantically dedupes, and clears activity", async () => {
        const client = new FakeDiscordClient();
        const controller = new AbortController();
        const manager = new DiscordConnectionManager({
            clientId: "123",
            createClient: () => client,
            debounceMs: 0,
            retryBaseMs: 0,
            retryMaxMs: 0,
        });
        const running = manager.run(controller.signal);

        expect(manager.setDesiredActivity({ details: "working on Cardel", state: "editing code" }))
            .toBe(true);
        await until(() => client.activities.length === 1);
        expect(manager.setDesiredActivity({ state: "editing code", details: "working on Cardel" }))
            .toBe(false);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(client.activities).toHaveLength(1);

        manager.setDesiredActivity(null);
        await until(() => client.clearCount === 1);
        controller.abort();
        await running;
        expect(client.destroyCount).toBe(1);
    });

    it("creates a fresh client and republishes after disconnect", async () => {
        const first = new FakeDiscordClient();
        const second = new FakeDiscordClient();
        const clients = [first, second];
        const controller = new AbortController();
        const manager = new DiscordConnectionManager({
            clientId: "123",
            createClient: () => clients.shift() ?? second,
            debounceMs: 0,
            retryBaseMs: 0,
            retryMaxMs: 0,
            random: () => 0.5,
        });
        manager.setDesiredActivity({ details: "in T3 Code", state: "idle" });
        const running = manager.run(controller.signal);

        await until(() => first.activities.length === 1);
        first.disconnect();
        await until(() => second.activities.length === 1);
        expect(second.activities[0]).toEqual(first.activities[0]);

        controller.abort();
        await running;
        expect(first.destroyCount).toBe(1);
        expect(second.destroyCount).toBe(1);
        expect(second.clearCount).toBe(1);
    });

    it("waits and retries when Discord is unavailable", async () => {
        const unavailable = new FakeDiscordClient();
        unavailable.loginError = new Error("Discord is closed");
        const available = new FakeDiscordClient();
        const clients = [unavailable, available];
        const errors: Array<unknown> = [];
        const states: Array<string> = [];
        const controller = new AbortController();
        const manager = new DiscordConnectionManager({
            clientId: "123",
            createClient: () => clients.shift() ?? available,
            debounceMs: 0,
            retryBaseMs: 0,
            retryMaxMs: 0,
            random: () => 0.5,
            onError: error => errors.push(error),
            onStateChange: state => states.push(state),
        });
        manager.setDesiredActivity({ state: "agent working" });
        const running = manager.run(controller.signal);

        await until(() => available.activities.length === 1);
        expect(errors).toHaveLength(1);
        expect(states).toContain("waiting");
        expect(unavailable.destroyCount).toBe(1);

        controller.abort();
        await running;
    });

    it("retries without optional image assets when Discord rejects them", async () => {
        const client = new FakeDiscordClient();
        client.rejectImages = true;
        const errors: Array<unknown> = [];
        const controller = new AbortController();
        const manager = new DiscordConnectionManager({
            clientId: "123",
            createClient: () => client,
            debounceMs: 0,
            onError: error => errors.push(error),
        });
        manager.setDesiredActivity({
            details: "working on Cardel",
            state: "editing code",
            largeImageKey: "not-configured",
            largeImageText: "T3 Code",
        });
        const running = manager.run(controller.signal);

        await until(() => client.activities.length === 1);
        expect(client.activities[0]).toEqual({
            details: "working on Cardel",
            state: "editing code",
        });
        expect(errors).toHaveLength(1);

        controller.abort();
        await running;
    });

    it("does not allow two run loops", async () => {
        const client = new FakeDiscordClient();
        const controller = new AbortController();
        const manager = new DiscordConnectionManager({
            clientId: "123",
            createClient: () => client,
            debounceMs: 0,
        });
        const running = manager.run(controller.signal);

        await expect(manager.run(controller.signal)).rejects.toThrow("already running");
        controller.abort();
        await running;
    });
});

describe("discordRetryDelay", () => {
    it("caps exponential retry and applies bounded jitter", () => {
        expect(discordRetryDelay(0, 1_000, 30_000, () => 0)).toBe(800);
        expect(discordRetryDelay(20, 1_000, 30_000, () => 0.5)).toBe(30_000);
        expect(discordRetryDelay(20, 1_000, 30_000, () => 1)).toBe(30_000);
    });

    it("uses injectable randomness", () => {
        const random = vi.fn(() => 0.25);
        expect(discordRetryDelay(2, 100, 10_000, random)).toBe(360);
        expect(random).toHaveBeenCalledOnce();
    });
});
