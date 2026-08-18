import { describe, expect, it } from "vitest";

import type { AppPaths } from "../src/config/paths.js";
import {
    getStartupStatus,
    installStartup,
    uninstallStartup,
} from "../src/startup/index.js";
import type {
    UnixCommandRunner,
    UnixStartupFileSystem,
} from "../src/startup/unix.js";

function linuxPaths(): AppPaths {
    return {
        configDirectory: "/home/ada/.config/t3-discord-presence",
        configFile: "/home/ada/.config/t3-discord-presence/config.json",
        stateDirectory: "/home/ada/.local/state/t3-discord-presence",
        stateFile: "/home/ada/.local/state/t3-discord-presence/state.json",
        credentialsFile: "/home/ada/.local/state/t3-discord-presence/credentials.json",
        runtimeDirectory: "/run/user/1000/t3-discord-presence",
        lockFile: "/run/user/1000/t3-discord-presence/daemon.lock",
        stopFile: "/run/user/1000/t3-discord-presence/daemon.stop",
        statusFile: "/run/user/1000/t3-discord-presence/status.json",
        logDirectory: "/home/ada/.local/state/t3-discord-presence/logs",
        logFile: "/home/ada/.local/state/t3-discord-presence/logs/daemon.log",
    };
}

describe("startup platform dispatch", () => {
    it("dispatches Linux install, status, and uninstall through injected adapters", async () => {
        const files = new Map<string, string>();
        let enabled = false;
        let active = false;
        const fileSystem: UnixStartupFileSystem = {
            async ensureDirectory() {},
            async readTextFile(filePath) {
                return files.get(filePath);
            },
            async writeTextFile(filePath, contents) {
                files.set(filePath, contents);
            },
            async removeFile(filePath) {
                files.delete(filePath);
            },
        };
        const runCommand: UnixCommandRunner = async (_executable, arguments_) => {
            const operation = arguments_[1];
            if (operation === "is-enabled") return { exitCode: enabled ? 0 : 1, stdout: "", stderr: "" };
            if (operation === "is-active") return { exitCode: active ? 0 : 3, stdout: "", stderr: "" };
            if (operation === "enable") {
                enabled = true;
                active = true;
            }
            if (operation === "disable") {
                enabled = false;
                active = false;
            }
            return { exitCode: 0, stdout: "", stderr: "" };
        };
        const options = {
            platform: "linux" as const,
            cliEntrypoint: "/opt/t3 presence/dist/cli.js",
            nodeExecutable: "/opt/node/bin/node",
            paths: linuxPaths(),
            homeDirectory: "/home/ada",
        };
        const dependencies = { unix: { fileSystem, runCommand } };

        await expect(installStartup(options, dependencies)).resolves.toMatchObject({
            platform: "linux",
            installed: true,
            mechanism: "systemd",
        });
        await expect(getStartupStatus(options, dependencies)).resolves.toMatchObject({
            platform: "linux",
            installed: true,
            current: true,
        });
        await expect(uninstallStartup(options, dependencies)).resolves.toMatchObject({
            platform: "linux",
            unitRemoved: true,
            serviceDisabled: true,
        });
    });

    it("rejects unsupported platforms", async () => {
        await expect(installStartup({
            platform: "freebsd",
            cliEntrypoint: "/opt/app/cli.js",
            paths: linuxPaths(),
        })).rejects.toThrow("not supported");
    });
});
