import type { DiscordConfig, PresenceConfig } from "../config/config.js";
import { SAFE_ACTIVITY_LABELS, type SafeActivity } from "../t3/activity.js";
import type {
    SelectedPresenceSource,
    SelectedPresenceStatus,
} from "../t3/state.js";
import { sanitizePresenceText } from "../utils/presence-text.js";
import type { DiscordActivity } from "./types.js";

export const DISCORD_ACTIVITY_TEXT_LIMIT = 128;

export interface DiscordActivityBuildOptions {
    readonly presence: PresenceConfig;
    readonly discord?: Pick<DiscordConfig, "largeImageKey" | "smallImageKey">;
    readonly sessionStartedAt?: string;
}

const additionalSafeActivities = new Set([
    "idle",
    "monitoring",
    "ready",
    "starting agent",
]);

const safeActivities = new Set<string>([
    ...Object.values(SAFE_ACTIVITY_LABELS),
    ...additionalSafeActivities,
]);

function defaultActivity(status: SelectedPresenceStatus): SafeActivity | string {
    switch (status) {
        case "waiting-for-approval":
            return SAFE_ACTIVITY_LABELS.waitingForApproval;
        case "waiting-for-input":
            return SAFE_ACTIVITY_LABELS.waitingForInput;
        case "error":
            return SAFE_ACTIVITY_LABELS.error;
        case "starting":
            return "starting agent";
        case "monitoring":
            return "monitoring";
        case "ready":
            return "ready";
        case "idle":
            return "idle";
        case "running":
        case "working":
            return SAFE_ACTIVITY_LABELS.agentWorking;
    }
}

function safeActivity(source: SelectedPresenceSource): string {
    return safeActivities.has(source.activity)
        ? source.activity
        : defaultActivity(source.status);
}

function boundedText(value: string, maximum = DISCORD_ACTIVITY_TEXT_LIMIT): string {
    const printable = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ");
    const normalized = printable.replace(/\s+/g, " ").trim();
    const characters = [...normalized];
    if (characters.length <= maximum) return normalized;
    return `${characters.slice(0, maximum - 1).join("")}…`;
}

function optionalBoundedText(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const bounded = boundedText(value);
    return bounded.length === 0 ? undefined : bounded;
}

function contextDetails(
    source: SelectedPresenceSource,
    config: PresenceConfig,
): string {
    const context = [
        ...(config.showProject ? [sanitizePresenceText(source.projectTitle)] : []),
        ...(config.showThread ? [sanitizePresenceText(source.threadTitle)] : []),
    ].filter((value): value is string => value !== undefined);
    if (context.length === 0) return "in T3 Code";
    const active = source.status === "running"
        || source.status === "starting"
        || source.status === "working"
        || source.status === "monitoring"
        || source.status === "waiting-for-approval"
        || source.status === "waiting-for-input";
    return boundedText(`${active ? "working on" : "in"} ${context.join(" · ")}`);
}

function modelDetails(
    source: SelectedPresenceSource,
    config: PresenceConfig,
): string | undefined {
    const details = [
        ...(config.showProvider ? [sanitizePresenceText(source.provider)] : []),
        ...(config.showModel ? [sanitizePresenceText(source.model)] : []),
    ].filter((value): value is string => value !== undefined);
    return details.length === 0 ? undefined : boundedText(details.join(" · "));
}

function agentState(source: SelectedPresenceSource, activity: string): string {
    const canSummarizeAgents = source.status === "running"
        || source.status === "starting"
        || source.status === "working"
        || source.status === "monitoring";
    if (
        canSummarizeAgents
        && Number.isSafeInteger(source.activeAgentCount)
        && source.activeAgentCount > 1
    ) {
        return source.activeAgentCount > 999
            ? "999+ agents working"
            : `${source.activeAgentCount} agents working`;
    }
    return activity;
}

function elapsedTimestamp(
    source: SelectedPresenceSource,
    showElapsedTime: boolean,
    sessionStartedAt?: string,
): number | undefined {
    if (!showElapsedTime) return undefined;
    const active = source.status === "running"
        || source.status === "starting"
        || source.status === "working"
        || source.status === "monitoring"
        || source.status === "waiting-for-approval"
        || source.status === "waiting-for-input";
    const startedAt = sessionStartedAt ?? (active ? source.startedAt : undefined);
    if (startedAt === undefined) return undefined;
    const milliseconds = Date.parse(startedAt);
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

export function buildDiscordActivity(
    source: SelectedPresenceSource,
    options: DiscordActivityBuildOptions,
): DiscordActivity {
    const activity = safeActivity(source);
    const model = modelDetails(source, options.presence);
    const largeImageKey = optionalBoundedText(options.discord?.largeImageKey);
    const smallImageKey = optionalBoundedText(options.discord?.smallImageKey);
    const hasImage = largeImageKey !== undefined || smallImageKey !== undefined;
    const state = boundedText([
        agentState(source, activity),
        ...(!hasImage && model !== undefined ? [model] : []),
    ].join(" · "));
    const startTimestamp = elapsedTimestamp(
        source,
        options.presence.showElapsedTime,
        options.sessionStartedAt,
    );

    return {
        details: contextDetails(source, options.presence),
        state,
        ...(startTimestamp === undefined ? {} : { startTimestamp }),
        ...(largeImageKey === undefined ? {} : {
            largeImageKey,
            largeImageText: model ?? "T3 Code",
        }),
        ...(smallImageKey === undefined ? {} : {
            smallImageKey,
            smallImageText: largeImageKey === undefined && model !== undefined ? model : activity,
        }),
    };
}

function semanticValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(semanticValue);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, semanticValue(entry)]),
    );
}

export function discordActivitySemanticKey(activity: DiscordActivity | null): string {
    return JSON.stringify(semanticValue(activity));
}
