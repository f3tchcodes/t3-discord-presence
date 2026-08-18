const unsafeUnicode = /[\p{Cc}\p{Cf}\p{Cs}]+/gu;
const absolutePath = /(?:^|[\s([{"'])(?:[A-Za-z]:[\\/]|[/\\]{2}|~[\\/]|[\\/][^\s/\\])/u;

export function sanitizePresenceText(
    value: unknown,
    maximum = 256,
): string | undefined {
    if (typeof value !== "string") return undefined;
    const limit = Number.isSafeInteger(maximum) && maximum > 0 ? maximum : 256;
    const normalized = value
        .replace(unsafeUnicode, " ")
        .normalize("NFC")
        .replace(/\s+/gu, " ")
        .trim();
    if (normalized.length === 0 || absolutePath.test(normalized)) return undefined;
    return [...normalized].slice(0, limit).join("");
}
