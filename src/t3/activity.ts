export const SAFE_ACTIVITY_LABELS = {
    agentWorking: "agent working",
    editingCode: "editing code",
    error: "error",
    planning: "planning",
    readingCode: "reading code",
    runningCommands: "running commands",
    searchingWeb: "searching web",
    thinking: "thinking",
    viewingImages: "viewing images",
    waitingForApproval: "waiting for approval",
    waitingForInput: "waiting for input",
} as const;

export type SafeActivity = typeof SAFE_ACTIVITY_LABELS[keyof typeof SAFE_ACTIVITY_LABELS];

const approvalRequestKinds = new Set([
    "approval",
    "apply_patch_approval",
    "command",
    "command_execution_approval",
    "exec_command_approval",
    "file_change",
    "file_change_approval",
    "file_read",
    "file_read_approval",
    "request_approval",
]);

const userInputRequestKinds = new Set([
    "tool_user_input",
    "user_input",
    "user_input_request",
]);

const itemActivities: Readonly<Record<string, SafeActivity>> = {
    command_execution: SAFE_ACTIVITY_LABELS.runningCommands,
    context_compaction: SAFE_ACTIVITY_LABELS.thinking,
    error: SAFE_ACTIVITY_LABELS.error,
    file_change: SAFE_ACTIVITY_LABELS.editingCode,
    file_read: SAFE_ACTIVITY_LABELS.readingCode,
    image_view: SAFE_ACTIVITY_LABELS.viewingImages,
    plan: SAFE_ACTIVITY_LABELS.planning,
    reasoning: SAFE_ACTIVITY_LABELS.thinking,
    web_search: SAFE_ACTIVITY_LABELS.searchingWeb,
};

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : undefined;
}

function classifier(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

function kindIs(kind: string | undefined, ...parts: ReadonlyArray<string>): boolean {
    if (kind === undefined) return false;
    return parts.some(part => `_${kind}_`.includes(`_${part}_`));
}

export function mapActivity(activity: unknown): SafeActivity {
    const record = asRecord(activity);
    if (record === undefined) return SAFE_ACTIVITY_LABELS.agentWorking;

    const kind = classifier(record.kind);
    const tone = classifier(record.tone);
    const payload = asRecord(record.payload);
    const itemType = classifier(payload?.itemType);
    const requestKind = classifier(payload?.requestKind);

    if (kindIs(kind, "user_input") || userInputRequestKinds.has(requestKind ?? "")) {
        return SAFE_ACTIVITY_LABELS.waitingForInput;
    }
    if (
        tone === "approval"
        || kindIs(kind, "approval", "permission")
        || approvalRequestKinds.has(requestKind ?? "")
    ) {
        return SAFE_ACTIVITY_LABELS.waitingForApproval;
    }
    if (tone === "error" || kindIs(kind, "error", "failed", "failure")) {
        return SAFE_ACTIVITY_LABELS.error;
    }

    const itemActivity = itemType === undefined ? undefined : itemActivities[itemType];
    if (itemActivity !== undefined) return itemActivity;

    if (kindIs(kind, "plan", "planning", "todo")) return SAFE_ACTIVITY_LABELS.planning;
    if (kindIs(kind, "thinking", "reasoning", "context_compaction")) {
        return SAFE_ACTIVITY_LABELS.thinking;
    }

    return SAFE_ACTIVITY_LABELS.agentWorking;
}
