import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "../utils/atomic-file.js";
import { resolveAppPaths } from "./paths.js";

export interface PresenceConfig {
    readonly showProject: boolean;
    readonly showThread: boolean;
    readonly showModel: boolean;
    readonly showProvider: boolean;
    readonly showElapsedTime: boolean;
}

export interface DiscordConfig {
    readonly largeImageKey?: string;
    readonly smallImageKey?: string;
}

export interface AppConfig {
    readonly presence: PresenceConfig;
    readonly discord: DiscordConfig;
}

export const DEFAULT_CONFIG: AppConfig = Object.freeze({
    presence: Object.freeze({
        showProject: true,
        showThread: false,
        showModel: true,
        showProvider: true,
        showElapsedTime: true,
    }),
    discord: Object.freeze({}),
});

const TOP_LEVEL_KEYS = new Set(["presence", "discord"]);
const PRESENCE_KEYS = new Set([
    "showProject",
    "showThread",
    "showModel",
    "showProvider",
    "showElapsedTime",
]);
const DISCORD_KEYS = new Set(["largeImageKey", "smallImageKey"]);

export class ConfigError extends Error {
    override readonly name = "ConfigError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, location: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new ConfigError(`${location} must be an object`);
    }
    return value;
}

function rejectUnknownKeys(
    value: Readonly<Record<string, unknown>>,
    allowedKeys: ReadonlySet<string>,
    location: string,
): void {
    const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
        throw new ConfigError(`${location}.${unknownKey} is not a supported setting`);
    }
}

function optionalBoolean(
    value: Readonly<Record<string, unknown>>,
    key: keyof PresenceConfig,
    fallback: boolean,
): boolean {
    const candidate = value[key];
    if (candidate === undefined) {
        return fallback;
    }
    if (typeof candidate !== "boolean") {
        throw new ConfigError(`config.presence.${key} must be a boolean`);
    }
    return candidate;
}

function optionalString(
    value: Readonly<Record<string, unknown>>,
    key: keyof DiscordConfig,
): string | undefined {
    const candidate = value[key];
    if (candidate === undefined) {
        return undefined;
    }
    if (typeof candidate !== "string" || candidate.trim() === "") {
        throw new ConfigError(`config.discord.${key} must be a non-empty string`);
    }
    if (candidate.length > 256) {
        throw new ConfigError(`config.discord.${key} must be at most 256 characters`);
    }
    return candidate;
}

function readPresenceConfig(value: unknown): PresenceConfig {
    if (value === undefined) {
        return { ...DEFAULT_CONFIG.presence };
    }
    const presence = expectRecord(value, "config.presence");
    rejectUnknownKeys(presence, PRESENCE_KEYS, "config.presence");
    return {
        showProject: optionalBoolean(presence, "showProject", DEFAULT_CONFIG.presence.showProject),
        showThread: optionalBoolean(presence, "showThread", DEFAULT_CONFIG.presence.showThread),
        showModel: optionalBoolean(presence, "showModel", DEFAULT_CONFIG.presence.showModel),
        showProvider: optionalBoolean(presence, "showProvider", DEFAULT_CONFIG.presence.showProvider),
        showElapsedTime: optionalBoolean(
            presence,
            "showElapsedTime",
            DEFAULT_CONFIG.presence.showElapsedTime,
        ),
    };
}

function readDiscordConfig(value: unknown): DiscordConfig {
    if (value === undefined) {
        return {};
    }
    const discord = expectRecord(value, "config.discord");
    rejectUnknownKeys(discord, DISCORD_KEYS, "config.discord");
    const largeImageKey = optionalString(discord, "largeImageKey");
    const smallImageKey = optionalString(discord, "smallImageKey");

    return {
        ...(largeImageKey === undefined ? {} : { largeImageKey }),
        ...(smallImageKey === undefined ? {} : { smallImageKey }),
    };
}

export function validateConfig(value: unknown): AppConfig {
    const config = expectRecord(value, "config");
    rejectUnknownKeys(config, TOP_LEVEL_KEYS, "config");
    return {
        presence: readPresenceConfig(config.presence),
        discord: readDiscordConfig(config.discord),
    };
}

export async function loadConfig(
    configFile = resolveAppPaths().configFile,
): Promise<AppConfig> {
    let contents: string;
    try {
        contents = await readFile(configFile, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return validateConfig({});
        }
        throw new ConfigError(`could not read config: ${configFile}`, { cause: error });
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error) {
        throw new ConfigError(`config contains invalid JSON: ${configFile}`, { cause: error });
    }

    try {
        return validateConfig(parsed);
    } catch (error) {
        if (error instanceof ConfigError) {
            throw new ConfigError(`${error.message} in ${configFile}`, { cause: error });
        }
        throw error;
    }
}

export async function saveConfig(
    config: AppConfig,
    configFile = resolveAppPaths().configFile,
): Promise<void> {
    const validated = validateConfig(config);
    await writeFileAtomic(configFile, `${JSON.stringify(validated, null, 4)}\n`);
}
