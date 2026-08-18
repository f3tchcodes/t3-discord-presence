import { describe, expect, it, vi } from "vitest";

import {
    reconnectDelay,
    waitForAbortableDelay,
} from "../src/daemon/backoff.js";

describe("daemon reconnect backoff", () => {
    it("grows exponentially with bounded jitter and a hard cap", () => {
        expect(reconnectDelay(0, 1_000, 10_000, () => 0)).toBe(800);
        expect(reconnectDelay(1, 1_000, 10_000, () => 0.5)).toBe(2_000);
        expect(reconnectDelay(30, 1_000, 10_000, () => 1)).toBe(10_000);
        expect(reconnectDelay(-1, 1_000, 10_000, () => Number.NaN)).toBe(1_000);
    });

    it("cancels its timer without leaving a pending wait", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const waiting = waitForAbortableDelay(30_000, controller.signal);
        controller.abort();

        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });
});
