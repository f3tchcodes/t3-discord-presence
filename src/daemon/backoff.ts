function positiveFinite(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function reconnectDelay(
    attempt: number,
    baseMs = 1_000,
    maximumMs = 30_000,
    random = Math.random,
): number {
    const base = positiveFinite(baseMs, 1_000);
    const maximum = Math.max(base, positiveFinite(maximumMs, 30_000));
    const exponent = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
    const exponential = Math.min(maximum, base * 2 ** Math.min(exponent, 30));
    const sampled = random();
    const boundedRandom = Number.isFinite(sampled) ? Math.min(1, Math.max(0, sampled)) : 0.5;
    const jitter = 0.8 + boundedRandom * 0.4;
    return Math.max(0, Math.min(maximum, Math.round(exponential * jitter)));
}

export function waitForAbortableDelay(
    milliseconds: number,
    signal: AbortSignal,
): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(new DOMException("The retry wait was aborted", "AbortError"));
    }
    const delay = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, delay);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(new DOMException("The retry wait was aborted", "AbortError"));
        };
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}
