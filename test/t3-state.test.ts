import { describe, expect, it } from "vitest";

import {
    applyShellStreamItem,
    applyThreadStreamItem,
    createPresenceSourceState,
    type PresenceSourceState,
    READY_RECENCY_MS,
    selectPresenceSource,
    type T3BackgroundLiveness,
    type T3SessionStatus,
} from "../src/t3/state.js";

const now = Date.parse("2026-08-18T12:00:00.000Z");

function project(id = "project-1", title = "Presence project") {
    return {
        id,
        title,
        workspaceRoot: "C:\\private\\workspace",
        scripts: [{ command: "secret command" }],
    };
}

interface ThreadOptions {
    readonly id?: string;
    readonly projectId?: string;
    readonly status?: T3SessionStatus | null;
    readonly updatedAt?: string;
    readonly pendingApproval?: boolean;
    readonly pendingInput?: boolean;
    readonly background?: T3BackgroundLiveness | null;
    readonly providerName?: string | null;
    readonly turnState?: "running" | "interrupted" | "completed" | "error" | null;
    readonly startedAt?: string | null;
}

function thread(options: ThreadOptions = {}) {
    const id = options.id ?? "thread-1";
    const updatedAt = options.updatedAt ?? "2026-08-18T11:59:00.000Z";
    const status = options.status === undefined ? "idle" : options.status;
    const turnState = options.turnState === undefined
        ? status === "running"
            ? "running"
            : status === "error"
                ? "error"
                : "completed"
        : options.turnState;
    return {
        id,
        projectId: options.projectId ?? "project-1",
        title: `Thread ${id}`,
        modelSelection: { instanceId: "codex-work", model: "gpt-5.6" },
        latestTurn: turnState === null
            ? null
            : {
                state: turnState,
                startedAt: options.startedAt === undefined
                    ? "2026-08-18T11:55:00.000Z"
                    : options.startedAt,
                requestedAt: "2026-08-18T11:54:59.000Z",
                prompt: "private prompt",
            },
        session: status === null
            ? null
            : { status, updatedAt, providerName: options.providerName ?? null },
        updatedAt,
        latestUserMessageAt: "2026-08-18T11:54:59.000Z",
        hasPendingApprovals: options.pendingApproval ?? false,
        hasPendingUserInput: options.pendingInput ?? false,
        backgroundLiveness: options.background ?? null,
        worktreePath: "C:\\private\\worktree",
        messages: [{ text: "private message" }],
    };
}

function snapshot(
    threads: ReadonlyArray<unknown>,
    projects: ReadonlyArray<unknown> = [project()],
    snapshotSequence = 10,
) {
    return {
        kind: "snapshot",
        snapshot: { snapshotSequence, projects, threads, updatedAt: new Date(now).toISOString() },
    };
}

function stateWith(
    threads: ReadonlyArray<unknown>,
    projects?: ReadonlyArray<unknown>,
    snapshotSequence?: number,
) {
    return applyShellStreamItem(
        createPresenceSourceState(),
        snapshot(threads, projects, snapshotSequence),
    );
}

describe("T3 presence source state", () => {
    it("returns an idle selection for an empty source", () => {
        expect(selectPresenceSource(createPresenceSourceState(), { now })).toEqual({
            status: "idle",
            activity: "idle",
            activeAgentCount: 0,
        });
    });

    it("normalizes only safe shell fields", () => {
        const state = stateWith([thread()]);
        const normalized = state.threads.get("thread-1");
        const serialized = JSON.stringify([...state.projects, ...state.threads]);

        expect(normalized).toMatchObject({
            id: "thread-1",
            projectId: "project-1",
            model: "gpt-5.6",
            provider: "codex-work",
            sessionStatus: "idle",
        });
        expect(serialized).not.toContain("workspace");
        expect(serialized).not.toContain("worktree");
        expect(serialized).not.toContain("private prompt");
        expect(serialized).not.toContain("private message");
        expect(serialized).not.toContain("secret command");
    });

    it("looks up the selected project and tolerates a missing project", () => {
        const known = selectPresenceSource(stateWith([thread()]), { now });
        const missing = selectPresenceSource(
            stateWith([thread({ projectId: "missing" })], []),
            { now },
        );

        expect(known.projectTitle).toBe("Presence project");
        expect(missing.threadId).toBe("thread-1");
        expect(missing).not.toHaveProperty("projectTitle");
    });

    it("prefers the session provider name over the configured instance id", () => {
        const state = stateWith([thread({ status: "running", providerName: "Codex" })]);

        expect(selectPresenceSource(state, { now }).provider).toBe("Codex");
    });

    it.each([
        [thread({ status: "running" }), "running"],
        [thread({ status: "starting", turnState: null }), "starting"],
        [thread({ status: "ready" }), "ready"],
        [thread({ status: "error" }), "error"],
        [thread({ status: "idle" }), "idle"],
        [thread({ status: "interrupted" }), "idle"],
        [thread({ status: "stopped" }), "idle"],
        [thread({ status: null }), "idle"],
        [thread({ status: "idle", background: "working" }), "working"],
        [thread({ status: "idle", background: "monitoring" }), "monitoring"],
    ])("selects the normalized status %#", (value, expected) => {
        expect(selectPresenceSource(stateWith([value]), { now }).status).toBe(expected);
    });

    it("uses the documented selection priority", () => {
        const state = stateWith([
            thread({ id: "idle", status: "idle", updatedAt: "2026-08-18T12:00:00Z" }),
            thread({ id: "ready", status: "ready", updatedAt: "2026-08-18T11:59:59Z" }),
            thread({ id: "background", status: "idle", background: "working" }),
            thread({ id: "starting", status: "starting", turnState: null }),
            thread({ id: "running", status: "running" }),
            thread({ id: "error", status: "error" }),
            thread({ id: "approval", status: "running", pendingApproval: true }),
        ]);

        expect(selectPresenceSource(state, { now })).toMatchObject({
            threadId: "approval",
            status: "waiting-for-approval",
            activity: "waiting for approval",
        });
    });

    it("keeps active work ahead of an error-only thread", () => {
        const state = stateWith([
            thread({
                id: "error",
                status: "error",
                updatedAt: "2026-08-18T12:00:00Z",
            }),
            thread({
                id: "running",
                status: "running",
                updatedAt: "2026-08-18T11:00:00Z",
            }),
        ]);

        expect(selectPresenceSource(state, { now })).toMatchObject({
            threadId: "running",
            status: "running",
        });
    });

    it("only treats ready sessions as recent within the configured window", () => {
        const oldReady = thread({
            id: "old-ready",
            status: "ready",
            updatedAt: new Date(now - READY_RECENCY_MS - 1).toISOString(),
        });
        const idle = thread({
            id: "new-idle",
            status: "idle",
            updatedAt: new Date(now - 1_000).toISOString(),
        });
        expect(selectPresenceSource(stateWith([oldReady, idle]), { now }).threadId).toBe("new-idle");

        const recentReady = thread({
            id: "recent-ready",
            status: "ready",
            updatedAt: new Date(now - READY_RECENCY_MS).toISOString(),
        });
        expect(selectPresenceSource(stateWith([recentReady, idle]), { now }).threadId).toBe(
            "recent-ready",
        );
    });

    it("counts active agents and picks latest update, then the lowest id", () => {
        const state = stateWith([
            thread({ id: "z", status: "running", updatedAt: "2026-08-18T11:58:00Z" }),
            thread({ id: "b", status: "running", updatedAt: "2026-08-18T11:59:00Z" }),
            thread({ id: "a", status: "running", updatedAt: "2026-08-18T11:59:00Z" }),
            thread({ id: "idle", status: "idle" }),
        ]);

        expect(selectPresenceSource(state, { now })).toMatchObject({
            threadId: "a",
            activeAgentCount: 3,
        });
    });

    it("counts pending work and a running latest turn as active", () => {
        const state = stateWith([
            thread({ id: "turn", status: "idle", turnState: "running" }),
            thread({ id: "approval", status: "idle", pendingApproval: true }),
            thread({ id: "input", status: "idle", pendingInput: true }),
            thread({ id: "idle", status: "idle" }),
        ]);

        expect(selectPresenceSource(state, { now }).activeAgentCount).toBe(3);
    });

    it("exposes the selected latest-turn start timestamp", () => {
        expect(selectPresenceSource(stateWith([thread({
            status: "running",
            startedAt: "2026-08-18T11:22:33+00:00",
        })]), { now }).startedAt).toBe("2026-08-18T11:22:33.000Z");
    });

    it("applies shell upserts, removals, synchronization, and sequence dedupe", () => {
        let state = stateWith([thread()], [project()], 10);
        state = applyShellStreamItem(state, {
            kind: "thread-upserted",
            sequence: 11,
            thread: thread({ id: "thread-2", status: "running" }),
        });
        state = applyShellStreamItem(state, {
            kind: "thread-removed",
            sequence: 12,
            threadId: "thread-2",
        });
        state = applyShellStreamItem(state, {
            kind: "thread-upserted",
            sequence: 11,
            thread: thread({ id: "thread-2", status: "running" }),
        });
        state = applyShellStreamItem(state, {
            kind: "project-upserted",
            sequence: 13,
            project: project("project-2", "Second"),
        });
        state = applyShellStreamItem(state, {
            kind: "project-removed",
            sequence: 14,
            projectId: "project-2",
        });
        state = applyShellStreamItem(state, { kind: "synchronized" });

        expect(state.threads.has("thread-2")).toBe(false);
        expect(state.projects.has("project-2")).toBe(false);
        expect(state.shellSequence).toBe(14);
        expect(state.synchronized).toBe(true);
    });

    it("ignores malformed items and stale snapshots without clearing good state", () => {
        const state = stateWith([thread()], [project()], 10);
        expect(applyShellStreamItem(state, null)).toBe(state);
        expect(applyShellStreamItem(state, snapshot([], [], 9))).toBe(state);
        expect(applyShellStreamItem(state, {
            kind: "thread-upserted",
            sequence: 11,
            thread: { id: "broken" },
        })).toBe(state);
    });

    it("advances the shell cursor for a forward-compatible event kind", () => {
        const state = stateWith([thread()], [project()], 10);
        const next = applyShellStreamItem(state, {
            kind: "thread-new-safe-event",
            sequence: 11,
            futurePayload: { ignored: true },
        });

        expect(next.shellSequence).toBe(11);
        expect(next.projects).toBe(state.projects);
        expect(next.threads).toBe(state.threads);
    });

    it("keeps only safe mapped thread detail and dedupes its sequence", () => {
        let state: PresenceSourceState = stateWith([thread({ status: "running" })]);
        state = applyThreadStreamItem(state, "thread-1", {
            kind: "snapshot",
            snapshot: {
                snapshotSequence: 20,
                thread: {
                    id: "thread-1",
                    messages: [{ text: "private message" }],
                    activities: [{
                        kind: "tool.started",
                        tone: "tool",
                        summary: "C:\\private\\secret.ts",
                        payload: {
                            itemType: "file_change",
                            command: "echo bearer-secret",
                        },
                        sequence: 19,
                        createdAt: "2026-08-18T11:58:00Z",
                    }],
                },
            },
        });
        state = applyThreadStreamItem(state, "thread-1", {
            kind: "event",
            event: {
                sequence: 21,
                aggregateId: "thread-1",
                type: "thread.activity-appended",
                payload: {
                    threadId: "thread-1",
                    activity: {
                        kind: "tool.started",
                        tone: "tool",
                        summary: "curl bearer-secret",
                        payload: { itemType: "command_execution", command: "curl bearer-secret" },
                    },
                },
            },
        });
        state = applyThreadStreamItem(state, "thread-1", {
            kind: "event",
            event: {
                sequence: 21,
                type: "thread.activity-appended",
                payload: {
                    threadId: "thread-1",
                    activity: { kind: "tool.started", payload: { itemType: "image_view" } },
                },
            },
        });

        expect(state.threads.get("thread-1")).toMatchObject({
            latestActivity: "running commands",
            detailSequence: 21,
        });
        const serialized = JSON.stringify([...state.threads]);
        expect(serialized).not.toContain("private");
        expect(serialized).not.toContain("bearer-secret");
        expect(serialized).not.toContain("messages");
    });

    it("tracks detail synchronization and preserves safe detail across shell upserts", () => {
        let state = stateWith([thread({ status: "running" })]);
        state = applyThreadStreamItem(state, "thread-1", {
            kind: "event",
            event: {
                sequence: 20,
                type: "thread.activity-appended",
                payload: {
                    threadId: "thread-1",
                    activity: { kind: "tool.started", payload: { itemType: "web_search" } },
                },
            },
        });
        state = applyThreadStreamItem(state, "thread-1", { kind: "synchronized" });
        state = applyShellStreamItem(state, {
            kind: "thread-upserted",
            sequence: 11,
            thread: thread({ status: "running", updatedAt: "2026-08-18T12:00:00Z" }),
        });

        expect(state.threads.get("thread-1")).toMatchObject({
            latestActivity: "searching web",
            detailSequence: 20,
            detailSynchronized: true,
        });
        expect(selectPresenceSource(state, { now }).activity).toBe("searching web");
    });

    it("rejects detail events for another thread", () => {
        const state = stateWith([thread({ status: "running" })]);
        const next = applyThreadStreamItem(state, "thread-1", {
            kind: "event",
            event: {
                sequence: 20,
                aggregateId: "other-thread",
                type: "thread.activity-appended",
                payload: { threadId: "other-thread", activity: { tone: "error" } },
            },
        });

        expect(next).toBe(state);
    });
});
