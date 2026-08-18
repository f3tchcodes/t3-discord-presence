import { describe, expect, it } from "vitest";

import {
    buildDiscordActivity,
    DISCORD_ACTIVITY_TEXT_LIMIT,
    type DiscordActivityBuildOptions,
    discordActivitySemanticKey,
} from "../src/discord/activity.js";
import type { SelectedPresenceSource } from "../src/t3/state.js";

const visible: DiscordActivityBuildOptions = {
    presence: {
        showProject: true,
        showThread: true,
        showModel: true,
        showProvider: true,
        showElapsedTime: true,
    },
};

function source(overrides: Partial<SelectedPresenceSource> = {}): SelectedPresenceSource {
    return {
        threadId: "thread-1",
        projectTitle: "Cardel",
        threadTitle: "Fix reconnects",
        model: "gpt-5.6",
        provider: "Codex",
        status: "running",
        activity: "editing code",
        startedAt: "2026-08-18T11:22:33.000Z",
        activeAgentCount: 1,
        ...overrides,
    };
}

describe("Discord activity builder", () => {
    it("shows or hides project and thread names independently", () => {
        expect(buildDiscordActivity(source(), visible).details).toBe(
            "working on Cardel · Fix reconnects",
        );
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: { ...visible.presence, showThread: false },
        }).details).toBe("working on Cardel");
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: { ...visible.presence, showProject: false },
        }).details).toBe("working on Fix reconnects");
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: {
                ...visible.presence,
                showProject: false,
                showThread: false,
            },
        }).details).toBe("in T3 Code");
    });

    it("shows or hides model and provider metadata independently", () => {
        expect(buildDiscordActivity(source(), visible).state).toBe(
            "editing code · Codex · gpt-5.6",
        );
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: { ...visible.presence, showProvider: false },
        }).state).toBe("editing code · gpt-5.6");
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: { ...visible.presence, showModel: false },
        }).state).toBe("editing code · Codex");
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: {
                ...visible.presence,
                showModel: false,
                showProvider: false,
            },
        }).state).toBe("editing code");
    });

    it("moves model metadata to an image tooltip when an asset is configured", () => {
        expect(buildDiscordActivity(source(), {
            ...visible,
            discord: { largeImageKey: "t3code", smallImageKey: "codex" },
        })).toMatchObject({
            state: "editing code",
            largeImageKey: "t3code",
            largeImageText: "Codex · gpt-5.6",
            smallImageKey: "codex",
            smallImageText: "editing code",
        });
    });

    it("includes elapsed time only for active states when enabled", () => {
        const expected = Date.parse("2026-08-18T11:22:33.000Z");
        expect(buildDiscordActivity(source(), visible).startTimestamp).toBe(expected);
        expect(buildDiscordActivity(source(), {
            ...visible,
            presence: { ...visible.presence, showElapsedTime: false },
        })).not.toHaveProperty("startTimestamp");
        expect(buildDiscordActivity(source({ status: "idle", activity: "idle" }), visible))
            .not.toHaveProperty("startTimestamp");
        expect(buildDiscordActivity(source({ startedAt: "not a date" }), visible))
            .not.toHaveProperty("startTimestamp");
    });

    it("summarizes multiple active agents", () => {
        expect(buildDiscordActivity(source({ activeAgentCount: 3 }), visible).state).toBe(
            "3 agents working · Codex · gpt-5.6",
        );
    });

    it.each([
        ["idle", "idle"],
        ["ready", "ready"],
        ["error", "error"],
        ["starting", "starting agent"],
        ["running", "agent working"],
        ["working", "agent working"],
        ["monitoring", "monitoring"],
        ["waiting-for-approval", "waiting for approval"],
        ["waiting-for-input", "waiting for input"],
    ] as const)("uses a safe fallback for %s", (status, expected) => {
        const activity = buildDiscordActivity(source({
            status,
            activity: "curl -H Authorization: Bearer secret",
        }), {
            ...visible,
            presence: {
                ...visible.presence,
                showModel: false,
                showProvider: false,
            },
        });

        expect(activity.state).toBe(expected);
    });

    it("bounds every generated Discord string", () => {
        const long = "🔒private".repeat(100);
        const activity = buildDiscordActivity(source({
            projectTitle: long,
            threadTitle: long,
            model: long,
            provider: long,
        }), {
            ...visible,
            discord: { largeImageKey: long, smallImageKey: long },
        });

        for (const value of Object.values(activity)) {
            if (typeof value === "string") {
                expect([...value].length).toBeLessThanOrEqual(DISCORD_ACTIVITY_TEXT_LIMIT);
            }
        }
    });

    it("omits optional image fields when no keys are configured", () => {
        const withoutImages = buildDiscordActivity(source(), visible);
        expect(withoutImages).not.toHaveProperty("largeImageKey");
        expect(withoutImages).not.toHaveProperty("largeImageText");
        expect(withoutImages).not.toHaveProperty("smallImageKey");
        expect(withoutImages).not.toHaveProperty("smallImageText");
    });

    it("produces a stable semantic key independent of property order and Date representation", () => {
        const first = {
            details: "working on Cardel",
            state: "editing code",
            startTimestamp: new Date("2026-08-18T11:22:33.000Z"),
        };
        const second = {
            startTimestamp: new Date("2026-08-18T11:22:33.000Z"),
            state: "editing code",
            details: "working on Cardel",
        };

        expect(discordActivitySemanticKey(first)).toBe(discordActivitySemanticKey(second));
        expect(buildDiscordActivity(source(), visible)).toEqual(buildDiscordActivity(source(), visible));
    });

    it("does not copy raw commands, payloads, workspace paths, or hidden titles", () => {
        const secret = "curl -H Authorization: Bearer super-secret";
        const hostile = {
            ...source({
                projectTitle: "C:\\private\\customer-project",
                threadTitle: "private prompt title",
                activity: secret,
            }),
            workspaceRoot: "C:\\private\\workspace",
            worktreePath: "C:\\private\\worktree",
            command: secret,
            payload: { prompt: "private user prompt", command: secret },
        } as SelectedPresenceSource;
        const activity = buildDiscordActivity(hostile, {
            presence: {
                showProject: false,
                showThread: false,
                showModel: false,
                showProvider: false,
                showElapsedTime: false,
            },
        });
        const serialized = JSON.stringify(activity);

        expect(activity).toEqual({ details: "in T3 Code", state: "agent working" });
        expect(serialized).not.toContain("super-secret");
        expect(serialized).not.toContain("private");
        expect(serialized).not.toContain("workspace");
        expect(serialized).not.toContain("worktree");
    });

    it("does not publish absolute paths even when metadata is visible", () => {
        const activity = buildDiscordActivity(source({
            projectTitle: "C:\\private\\customer-project",
            threadTitle: "/home/alice/private-thread",
            model: "\\\\server\\private\\model",
            provider: "~/private/provider",
        }), visible);
        const serialized = JSON.stringify(activity);

        expect(activity).toEqual({
            details: "in T3 Code",
            state: "editing code",
            startTimestamp: Date.parse("2026-08-18T11:22:33.000Z"),
        });
        expect(serialized).not.toContain("private");
        expect(serialized).not.toContain("alice");
    });

    it("removes bidi controls and lone surrogates from display text", () => {
        const activity = buildDiscordActivity(source({
            projectTitle: "safe\u202Ename\uD800",
            model: "gpt\u2066-5\u2069",
            provider: "Codex",
        }), visible);
        const serialized = JSON.stringify(activity);

        expect(serialized).not.toContain("\u202E");
        expect(serialized).not.toContain("\u2066");
        expect(serialized).not.toContain("\u2069");
        expect(serialized).not.toContain("\uD800");
    });
});
