import { sanitizePresenceText } from "../utils/presence-text.js";
import {
    mapActivity,
    SAFE_ACTIVITY_LABELS,
    type SafeActivity,
} from "./activity.js";

export const READY_RECENCY_MS = 5 * 60 * 1_000;

export type T3SessionStatus =
    | "idle"
    | "starting"
    | "running"
    | "ready"
    | "interrupted"
    | "stopped"
    | "error";

export type T3LatestTurnState = "running" | "interrupted" | "completed" | "error";
export type T3BackgroundLiveness = "working" | "monitoring";

export interface PresenceProjectState {
    readonly id: string;
    readonly title: string;
}

export interface PresenceThreadState {
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly model: string | null;
    readonly provider: string | null;
    readonly sessionStatus: T3SessionStatus | null;
    readonly latestTurnState: T3LatestTurnState | null;
    readonly latestTurnStartedAt: string | null;
    readonly updatedAt: string;
    readonly latestUserMessageAt: string | null;
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
    readonly backgroundLiveness: T3BackgroundLiveness | null;
    readonly latestActivity: SafeActivity | null;
    readonly detailSequence: number | null;
    readonly detailSynchronized: boolean;
}

export interface PresenceSourceState {
    readonly projects: ReadonlyMap<string, PresenceProjectState>;
    readonly threads: ReadonlyMap<string, PresenceThreadState>;
    readonly shellSequence: number | null;
    readonly synchronized: boolean;
}

export type SelectedPresenceStatus =
    | "waiting-for-approval"
    | "waiting-for-input"
    | "error"
    | "running"
    | "starting"
    | "working"
    | "monitoring"
    | "ready"
    | "idle";

export interface SelectedPresenceSource {
    readonly threadId?: string;
    readonly projectTitle?: string;
    readonly threadTitle?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly status: SelectedPresenceStatus;
    readonly activity: string;
    readonly startedAt?: string;
    readonly activeAgentCount: number;
}

export interface PresenceSelectionOptions {
    readonly now?: number;
    readonly readyRecencyMs?: number;
}

const sessionStatuses = new Set<T3SessionStatus>([
    "idle",
    "starting",
    "running",
    "ready",
    "interrupted",
    "stopped",
    "error",
]);

const latestTurnStates = new Set<T3LatestTurnState>([
    "running",
    "interrupted",
    "completed",
    "error",
]);

const backgroundLivenessValues = new Set<T3BackgroundLiveness>(["working", "monitoring"]);

const epoch = new Date(0).toISOString();

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : undefined;
}

function identity(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 1_024 ? trimmed : undefined;
}

function displayText(value: unknown): string | undefined {
    return sanitizePresenceText(value, 256);
}

function displayTitle(value: unknown, fallback: string): string | undefined {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    return displayText(value) ?? fallback;
}

function timestamp(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function sequence(value: unknown): number | undefined {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : undefined;
}

function normalizeProject(value: unknown): PresenceProjectState | undefined {
    const project = asRecord(value);
    const id = identity(project?.id);
    const title = displayTitle(project?.title, "private project");
    return id !== undefined && title !== undefined ? { id, title } : undefined;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>): T | null {
    return typeof value === "string" && values.has(value as T) ? value as T : null;
}

function normalizeThread(
    value: unknown,
    existing?: PresenceThreadState,
): PresenceThreadState | undefined {
    const thread = asRecord(value);
    const id = identity(thread?.id);
    const projectId = identity(thread?.projectId);
    const title = displayTitle(thread?.title, "private thread");
    if (thread === undefined || id === undefined || projectId === undefined || title === undefined) {
        return undefined;
    }

    const modelSelection = asRecord(thread.modelSelection);
    const session = asRecord(thread.session);
    const latestTurn = asRecord(thread.latestTurn);

    return {
        id,
        projectId,
        title,
        model: displayText(modelSelection?.model) ?? null,
        provider: displayText(session?.providerName) ?? displayText(modelSelection?.instanceId) ?? null,
        sessionStatus: enumValue(session?.status, sessionStatuses),
        latestTurnState: enumValue(latestTurn?.state, latestTurnStates),
        latestTurnStartedAt: timestamp(latestTurn?.startedAt) ?? null,
        updatedAt: timestamp(thread.updatedAt) ?? timestamp(session?.updatedAt) ?? epoch,
        latestUserMessageAt: timestamp(thread.latestUserMessageAt) ?? null,
        hasPendingApprovals: thread.hasPendingApprovals === true,
        hasPendingUserInput: thread.hasPendingUserInput === true,
        backgroundLiveness: enumValue(thread.backgroundLiveness, backgroundLivenessValues),
        latestActivity: existing?.latestActivity ?? null,
        detailSequence: existing?.detailSequence ?? null,
        detailSynchronized: existing?.detailSynchronized ?? false,
    };
}

export function createPresenceSourceState(): PresenceSourceState {
    return {
        projects: new Map(),
        threads: new Map(),
        shellSequence: null,
        synchronized: false,
    };
}

function withShellSequence(
    state: PresenceSourceState,
    shellSequence: number,
    patch: Partial<Pick<PresenceSourceState, "projects" | "threads">>,
): PresenceSourceState {
    return { ...state, ...patch, shellSequence };
}

export function applyShellStreamItem(
    state: PresenceSourceState,
    item: unknown,
): PresenceSourceState {
    const record = asRecord(item);
    if (record === undefined) return state;

    if (record.kind === "synchronized") {
        return state.synchronized ? state : { ...state, synchronized: true };
    }

    if (record.kind === "snapshot") {
        const snapshot = asRecord(record.snapshot);
        const snapshotSequence = sequence(snapshot?.snapshotSequence);
        if (
            snapshot === undefined
            || snapshotSequence === undefined
            || !Array.isArray(snapshot.projects)
            || !Array.isArray(snapshot.threads)
            || (state.shellSequence !== null && snapshotSequence < state.shellSequence)
        ) {
            return state;
        }
        const projects = new Map<string, PresenceProjectState>();
        for (const value of snapshot.projects) {
            const project = normalizeProject(value);
            if (project !== undefined) projects.set(project.id, project);
        }
        const threads = new Map<string, PresenceThreadState>();
        for (const value of snapshot.threads) {
            const rawThread = asRecord(value);
            const rawId = identity(rawThread?.id);
            const thread = normalizeThread(value, rawId === undefined ? undefined : state.threads.get(rawId));
            if (thread !== undefined) threads.set(thread.id, thread);
        }
        return {
            projects,
            threads,
            shellSequence: snapshotSequence,
            synchronized: false,
        };
    }

    const eventSequence = sequence(record.sequence);
    if (
        eventSequence === undefined
        || (state.shellSequence !== null && eventSequence <= state.shellSequence)
    ) {
        return state;
    }

    if (record.kind === "project-upserted") {
        const project = normalizeProject(record.project);
        if (project === undefined) return state;
        const projects = new Map(state.projects);
        projects.set(project.id, project);
        return withShellSequence(state, eventSequence, { projects });
    }
    if (record.kind === "project-removed") {
        const projectId = identity(record.projectId);
        if (projectId === undefined) return state;
        const projects = new Map(state.projects);
        projects.delete(projectId);
        return withShellSequence(state, eventSequence, { projects });
    }
    if (record.kind === "thread-upserted") {
        const rawThread = asRecord(record.thread);
        const rawId = identity(rawThread?.id);
        const thread = normalizeThread(
            record.thread,
            rawId === undefined ? undefined : state.threads.get(rawId),
        );
        if (thread === undefined) return state;
        const threads = new Map(state.threads);
        threads.set(thread.id, thread);
        return withShellSequence(state, eventSequence, { threads });
    }
    if (record.kind === "thread-removed") {
        const threadId = identity(record.threadId);
        if (threadId === undefined) return state;
        const threads = new Map(state.threads);
        threads.delete(threadId);
        return withShellSequence(state, eventSequence, { threads });
    }

    return typeof record.kind === "string" && record.kind.length <= 128
        ? { ...state, shellSequence: eventSequence }
        : state;
}

interface ActivityCandidate {
    readonly value: unknown;
    readonly sequence: number | null;
    readonly createdAt: number;
    readonly index: number;
}

function latestActivity(values: ReadonlyArray<unknown>): SafeActivity | null {
    let latest: ActivityCandidate | undefined;
    for (const [index, value] of values.entries()) {
        const record = asRecord(value);
        if (record === undefined || typeof record.kind !== "string") continue;
        const candidate: ActivityCandidate = {
            value,
            sequence: sequence(record.sequence) ?? null,
            createdAt: Date.parse(timestamp(record.createdAt) ?? epoch),
            index,
        };
        if (
            latest === undefined
            || (candidate.sequence !== null && latest.sequence === null)
            || (candidate.sequence !== null
                && latest.sequence !== null
                && candidate.sequence > latest.sequence)
            || (candidate.sequence === latest.sequence && candidate.createdAt > latest.createdAt)
            || (candidate.sequence === latest.sequence
                && candidate.createdAt === latest.createdAt
                && candidate.index > latest.index)
        ) {
            latest = candidate;
        }
    }
    return latest === undefined ? null : mapActivity(latest.value);
}

function replaceThread(
    state: PresenceSourceState,
    thread: PresenceThreadState,
): PresenceSourceState {
    const threads = new Map(state.threads);
    threads.set(thread.id, thread);
    return { ...state, threads };
}

export function applyThreadStreamItem(
    state: PresenceSourceState,
    threadId: string,
    item: unknown,
): PresenceSourceState {
    const thread = state.threads.get(threadId);
    const record = asRecord(item);
    if (thread === undefined || record === undefined) return state;

    if (record.kind === "synchronized") {
        return thread.detailSynchronized
            ? state
            : replaceThread(state, { ...thread, detailSynchronized: true });
    }

    if (record.kind === "snapshot") {
        const snapshot = asRecord(record.snapshot);
        const snapshotSequence = sequence(snapshot?.snapshotSequence);
        const detailThread = asRecord(snapshot?.thread);
        const activities = detailThread?.activities;
        if (
            snapshotSequence === undefined
            || (thread.detailSequence !== null && snapshotSequence < thread.detailSequence)
            || identity(detailThread?.id) !== threadId
            || !Array.isArray(activities)
        ) {
            return state;
        }
        return replaceThread(state, {
            ...thread,
            latestActivity: latestActivity(activities),
            detailSequence: snapshotSequence,
            detailSynchronized: false,
        });
    }

    if (record.kind !== "event") return state;
    const event = asRecord(record.event);
    const eventSequence = sequence(event?.sequence);
    if (
        event === undefined
        || eventSequence === undefined
        || (thread.detailSequence !== null && eventSequence <= thread.detailSequence)
        || (typeof event.aggregateId === "string" && event.aggregateId !== threadId)
    ) {
        return state;
    }
    const payload = asRecord(event.payload);
    if (typeof payload?.threadId === "string" && payload.threadId !== threadId) return state;

    const activity = event.type === "thread.activity-appended" && payload !== undefined
        ? mapActivity(payload.activity)
        : thread.latestActivity;
    return replaceThread(state, {
        ...thread,
        latestActivity: activity,
        detailSequence: eventSequence,
    });
}

interface RankedThread {
    readonly thread: PresenceThreadState;
    readonly rank: number;
    readonly status: SelectedPresenceStatus;
    readonly activity: string;
}

function rankThread(
    thread: PresenceThreadState,
    now: number,
    readyRecencyMs: number,
): RankedThread {
    if (thread.hasPendingApprovals) {
        return { thread, rank: 8, status: "waiting-for-approval", activity: "waiting for approval" };
    }
    if (thread.hasPendingUserInput) {
        return { thread, rank: 8, status: "waiting-for-input", activity: "waiting for input" };
    }
    if (thread.sessionStatus === "running" || thread.latestTurnState === "running") {
        return {
            thread,
            rank: 7,
            status: "running",
            activity: thread.latestActivity ?? SAFE_ACTIVITY_LABELS.agentWorking,
        };
    }
    if (thread.sessionStatus === "starting") {
        return { thread, rank: 6, status: "starting", activity: "starting agent" };
    }
    if (thread.backgroundLiveness === "working") {
        return { thread, rank: 5, status: "working", activity: SAFE_ACTIVITY_LABELS.agentWorking };
    }
    if (thread.backgroundLiveness === "monitoring") {
        return { thread, rank: 5, status: "monitoring", activity: "monitoring" };
    }
    if (thread.sessionStatus === "error" || thread.latestTurnState === "error") {
        return { thread, rank: 4, status: "error", activity: "error" };
    }
    const age = now - Date.parse(thread.updatedAt);
    if (thread.sessionStatus === "ready" && age <= readyRecencyMs) {
        return { thread, rank: 3, status: "ready", activity: "ready" };
    }
    return { thread, rank: 0, status: "idle", activity: "idle" };
}

function isActiveAgent(thread: PresenceThreadState): boolean {
    return thread.sessionStatus === "running"
        || thread.sessionStatus === "starting"
        || thread.latestTurnState === "running"
        || thread.hasPendingApprovals
        || thread.hasPendingUserInput
        || thread.backgroundLiveness !== null;
}

export function selectPresenceSource(
    state: PresenceSourceState,
    options: PresenceSelectionOptions = {},
): SelectedPresenceSource {
    const now = Number.isFinite(options.now) ? options.now as number : Date.now();
    const readyRecencyMs = Number.isFinite(options.readyRecencyMs)
        && (options.readyRecencyMs as number) >= 0
        ? options.readyRecencyMs as number
        : READY_RECENCY_MS;
    const activeAgentCount = [...state.threads.values()].filter(isActiveAgent).length;
    const ranked = [...state.threads.values()]
        .map(thread => rankThread(thread, now, readyRecencyMs))
        .sort((left, right) => (
            right.rank - left.rank
            || Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt)
            || left.thread.id.localeCompare(right.thread.id)
        ));
    const selected = ranked[0];
    if (selected === undefined) {
        return { status: "idle", activity: "idle", activeAgentCount };
    }
    const projectTitle = state.projects.get(selected.thread.projectId)?.title;
    return {
        threadId: selected.thread.id,
        ...(projectTitle === undefined ? {} : { projectTitle }),
        threadTitle: selected.thread.title,
        ...(selected.thread.model === null ? {} : { model: selected.thread.model }),
        ...(selected.thread.provider === null ? {} : { provider: selected.thread.provider }),
        status: selected.status,
        activity: selected.activity,
        ...(selected.thread.latestTurnStartedAt === null
            ? {}
            : { startedAt: selected.thread.latestTurnStartedAt }),
        activeAgentCount,
    };
}
