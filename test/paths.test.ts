import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    type AppPaths,
    ensureAppDirectories,
    resolveAppPaths,
} from "../src/config/paths.js";

const temporaryDirectories: Array<string> = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "t3-presence-paths-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async directory => {
        await rm(directory, { recursive: true, force: true });
    }));
});

describe("resolveAppPaths", () => {
    it("uses roaming config and local state on Windows", () => {
        const paths = resolveAppPaths({
            platform: "win32",
            homeDirectory: "C:\\Users\\Ada",
            env: {
                APPDATA: "D:\\Roaming",
                LOCALAPPDATA: "D:\\Local",
            },
        });

        expect(paths.configFile).toBe("D:\\Roaming\\t3-discord-presence\\config.json");
        expect(paths.stateFile).toBe("D:\\Local\\t3-discord-presence\\state\\state.json");
        expect(paths.credentialsFile).toBe(
            "D:\\Local\\t3-discord-presence\\state\\credentials.json",
        );
        expect(paths.lockFile).toBe(
            "D:\\Local\\t3-discord-presence\\runtime\\daemon.lock",
        );
        expect(paths.logFile).toBe("D:\\Local\\t3-discord-presence\\logs\\daemon.log");
    });

    it("falls back to Windows home directories for relative environment paths", () => {
        const paths = resolveAppPaths({
            platform: "win32",
            homeDirectory: "C:\\Users\\Ada",
            env: {
                APPDATA: "relative\\roaming",
                LOCALAPPDATA: "relative\\local",
            },
        });

        expect(paths.configDirectory).toBe(
            "C:\\Users\\Ada\\AppData\\Roaming\\t3-discord-presence",
        );
        expect(paths.stateDirectory).toBe(
            "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\state",
        );
    });

    it("uses Application Support and Library Logs on macOS", () => {
        const paths = resolveAppPaths({
            platform: "darwin",
            homeDirectory: "/Users/ada",
            env: {},
        });

        expect(paths.configFile).toBe(
            "/Users/ada/Library/Application Support/t3-discord-presence/config/config.json",
        );
        expect(paths.runtimeDirectory).toBe(
            "/Users/ada/Library/Application Support/t3-discord-presence/runtime",
        );
        expect(paths.logFile).toBe(
            "/Users/ada/Library/Logs/t3-discord-presence/daemon.log",
        );
    });

    it("honors absolute XDG directories on Linux", () => {
        const paths = resolveAppPaths({
            platform: "linux",
            homeDirectory: "/home/ada",
            env: {
                XDG_CONFIG_HOME: "/mnt/config",
                XDG_STATE_HOME: "/mnt/state",
                XDG_RUNTIME_DIR: "/run/user/1000",
            },
        });

        expect(paths.configFile).toBe("/mnt/config/t3-discord-presence/config.json");
        expect(paths.stateFile).toBe("/mnt/state/t3-discord-presence/state.json");
        expect(paths.runtimeDirectory).toBe("/run/user/1000/t3-discord-presence");
        expect(paths.logDirectory).toBe("/mnt/state/t3-discord-presence/logs");
    });

    it("uses XDG fallbacks and keeps runtime separate from persistent state", () => {
        const paths = resolveAppPaths({
            platform: "linux",
            homeDirectory: "/home/ada",
            env: {
                XDG_CONFIG_HOME: "relative-config",
                XDG_STATE_HOME: "relative-state",
                XDG_RUNTIME_DIR: "relative-runtime",
            },
        });

        expect(paths.configDirectory).toBe("/home/ada/.config/t3-discord-presence");
        expect(paths.stateDirectory).toBe("/home/ada/.local/state/t3-discord-presence");
        expect(paths.runtimeDirectory).toBe(
            "/home/ada/.local/state/t3-discord-presence/runtime",
        );
    });

    it("rejects unsupported platforms and relative homes", () => {
        expect(() => resolveAppPaths({
            platform: "freebsd",
            homeDirectory: "/home/ada",
            env: {},
        })).toThrow("unsupported platform");
        expect(() => resolveAppPaths({
            platform: "linux",
            homeDirectory: "relative-home",
            env: {},
        })).toThrow("home directory must be absolute");
    });
});

describe("ensureAppDirectories", () => {
    it("creates config, state, runtime, and log directories", async () => {
        const root = await temporaryDirectory();
        const paths: AppPaths = {
            configDirectory: join(root, "config"),
            configFile: join(root, "config", "config.json"),
            stateDirectory: join(root, "state"),
            stateFile: join(root, "state", "state.json"),
            credentialsFile: join(root, "state", "credentials.json"),
            runtimeDirectory: join(root, "runtime"),
            lockFile: join(root, "runtime", "daemon.lock"),
            statusFile: join(root, "runtime", "status.json"),
            logDirectory: join(root, "logs"),
            logFile: join(root, "logs", "daemon.log"),
        };

        await ensureAppDirectories(paths);

        await expect(Promise.all([
            access(paths.configDirectory),
            access(paths.stateDirectory),
            access(paths.runtimeDirectory),
            access(paths.logDirectory),
        ])).resolves.toBeDefined();
    });
});
