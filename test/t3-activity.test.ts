import { describe, expect, it } from "vitest";

import { mapActivity, SAFE_ACTIVITY_LABELS } from "../src/t3/activity.js";

describe("safe T3 activity mapping", () => {
    it.each([
        ["command_execution", SAFE_ACTIVITY_LABELS.runningCommands],
        ["file_change", SAFE_ACTIVITY_LABELS.editingCode],
        ["file_read", SAFE_ACTIVITY_LABELS.readingCode],
        ["web_search", SAFE_ACTIVITY_LABELS.searchingWeb],
        ["image_view", SAFE_ACTIVITY_LABELS.viewingImages],
        ["reasoning", SAFE_ACTIVITY_LABELS.thinking],
        ["plan", SAFE_ACTIVITY_LABELS.planning],
        ["error", SAFE_ACTIVITY_LABELS.error],
    ])("maps the %s item type", (itemType, expected) => {
        expect(mapActivity({
            kind: "tool.started",
            tone: "tool",
            payload: { itemType },
        })).toBe(expected);
    });

    it("maps approval and user-input requests", () => {
        expect(mapActivity({ tone: "approval", kind: "request.opened" })).toBe(
            SAFE_ACTIVITY_LABELS.waitingForApproval,
        );
        expect(mapActivity({
            kind: "request.opened",
            payload: { requestKind: "command_execution_approval" },
        })).toBe(SAFE_ACTIVITY_LABELS.waitingForApproval);
        expect(mapActivity({
            kind: "user-input.requested",
            tone: "approval",
            payload: { requestKind: "tool_user_input" },
        })).toBe(SAFE_ACTIVITY_LABELS.waitingForInput);
    });

    it("maps error tone before tool classification", () => {
        expect(mapActivity({
            kind: "tool.completed",
            tone: "error",
            payload: { itemType: "command_execution" },
        })).toBe(SAFE_ACTIVITY_LABELS.error);
    });

    it("maps known planning and thinking kinds", () => {
        expect(mapActivity({ kind: "turn.plan.updated", tone: "info" })).toBe(
            SAFE_ACTIVITY_LABELS.planning,
        );
        expect(mapActivity({ kind: "assistant.reasoning", tone: "info" })).toBe(
            SAFE_ACTIVITY_LABELS.thinking,
        );
    });

    it("falls back safely for unknown or malformed activities", () => {
        expect(mapActivity(undefined)).toBe(SAFE_ACTIVITY_LABELS.agentWorking);
        expect(mapActivity([])).toBe(SAFE_ACTIVITY_LABELS.agentWorking);
        expect(mapActivity({ kind: "provider.did-a-new-thing" })).toBe(
            SAFE_ACTIVITY_LABELS.agentWorking,
        );
    });

    it("never returns raw summaries, commands, paths, prompts, or payload data", () => {
        const secrets = [
            "curl -H Authorization: Bearer very-secret-token",
            "C:\\private\\customer\\source.ts",
            "do not reveal this prompt",
            "private payload content",
        ];
        const result = mapActivity({
            kind: "tool.started",
            tone: "tool",
            summary: secrets[0],
            command: secrets[0],
            path: secrets[1],
            prompt: secrets[2],
            payload: {
                itemType: "command_execution",
                command: secrets[0],
                data: secrets[3],
            },
        });
        const serialized = JSON.stringify(result);

        expect(result).toBe(SAFE_ACTIVITY_LABELS.runningCommands);
        for (const secret of secrets) expect(serialized).not.toContain(secret);
    });

    it("keeps every possible result bounded", () => {
        const longSecret = "secret".repeat(100_000);
        const result = mapActivity({
            kind: longSecret,
            tone: longSecret,
            summary: longSecret,
            payload: {
                itemType: longSecret,
                requestKind: longSecret,
                nested: longSecret,
            },
        });

        expect(result).toBe(SAFE_ACTIVITY_LABELS.agentWorking);
        expect(result.length).toBeLessThanOrEqual(32);
    });
});
