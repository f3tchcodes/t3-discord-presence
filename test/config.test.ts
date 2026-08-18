import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    ConfigError,
    DEFAULT_CONFIG,
    loadConfig,
    saveConfig,
    validateConfig,
} from "../src/config/config.js";

const temporaryDirectories: Array<string> = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "t3-presence-config-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async directory => {
        await rm(directory, { recursive: true, force: true });
    }));
});

describe("validateConfig", () => {
    it("uses privacy-conscious defaults", () => {
        expect(validateConfig({})).toEqual({
            presence: {
                showProject: true,
                showThread: false,
                showModel: true,
                showProvider: true,
                showElapsedTime: true,
            },
            discord: {},
        });
        expect(DEFAULT_CONFIG.presence.showThread).toBe(false);
    });

    it("merges partial presence settings with defaults", () => {
        expect(validateConfig({
            presence: {
                showProject: false,
                showThread: true,
            },
        })).toEqual({
            presence: {
                showProject: false,
                showThread: true,
                showModel: true,
                showProvider: true,
                showElapsedTime: true,
            },
            discord: {},
        });
    });

    it("accepts optional Discord image keys without application configuration", () => {
        expect(validateConfig({
            discord: {
                largeImageKey: "t3code",
                smallImageKey: "codex",
            },
        }).discord).toEqual({
            largeImageKey: "t3code",
            smallImageKey: "codex",
        });
    });

    it("rejects wrong setting types and empty Discord values", () => {
        expect(() => validateConfig({
            presence: { showProject: "yes" },
        })).toThrow("config.presence.showProject must be a boolean");
        expect(() => validateConfig({
            discord: { largeImageKey: "  " },
        })).toThrow("config.discord.largeImageKey must be a non-empty string");
    });

    it("does not allow credentials in the settings file", () => {
        expect(() => validateConfig({ accessToken: "secret" })).toThrow(
            "config.accessToken is not a supported setting",
        );
        expect(() => validateConfig({
            discord: { authorization: "Bearer secret" },
        })).toThrow("config.discord.authorization is not a supported setting");
        expect(() => validateConfig({
            discord: { clientId: "legacy-application-id" },
        })).toThrow("config.discord.clientId is not a supported setting");
    });

    it("rejects arrays, null, and unknown nested settings", () => {
        expect(() => validateConfig([])).toThrow("config must be an object");
        expect(() => validateConfig(null)).toThrow("config must be an object");
        expect(() => validateConfig({
            presence: { visible: true },
        })).toThrow("config.presence.visible is not a supported setting");
    });
});

describe("config persistence", () => {
    it("returns defaults when the config file is missing", async () => {
        const root = await temporaryDirectory();

        await expect(loadConfig(join(root, "missing", "config.json"))).resolves.toEqual(
            DEFAULT_CONFIG,
        );
    });

    it("loads, validates, and fills a partial config", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "config.json");
        await writeFile(filePath, JSON.stringify({
            presence: { showElapsedTime: false },
            discord: { largeImageKey: "t3code" },
        }));

        const config = await loadConfig(filePath);

        expect(config.presence.showElapsedTime).toBe(false);
        expect(config.presence.showThread).toBe(false);
        expect(config.discord.largeImageKey).toBe("t3code");
    });

    it("reports malformed JSON without including its contents", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "config.json");
        await writeFile(filePath, "{ secret-token");

        const error = await loadConfig(filePath).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain("invalid JSON");
        expect((error as Error).message).not.toContain("secret-token");
    });

    it("saves a normalized config atomically", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "nested", "config.json");

        await saveConfig({
            presence: {
                showProject: false,
                showThread: false,
                showModel: true,
                showProvider: false,
                showElapsedTime: true,
            },
            discord: { largeImageKey: "t3code" },
        }, filePath);

        const contents = await readFile(filePath, "utf8");
        expect(contents.endsWith("\n")).toBe(true);
        expect(JSON.parse(contents)).toEqual(await loadConfig(filePath));
    });
});
