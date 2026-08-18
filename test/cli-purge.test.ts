import { describe, expect, it } from "vitest";

import {
    assertAppOwnedPaths,
    environmentIdsFromCredentialFile,
    purgeAppData,
} from "../src/cli/purge.js";
import type { CredentialStore } from "../src/config/credentials.js";
import type { AppPaths } from "../src/config/paths.js";

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

describe("CLI purge ownership", () => {
    it("extracts only valid environment ids without exposing credential values", () => {
        const contents = JSON.stringify({
            version: 1,
            environments: {
                "environment-one": { accessToken: "private-token" },
                " bad-environment ": { accessToken: "another-token" },
            },
        });

        expect(environmentIdsFromCredentialFile(contents)).toEqual(["environment-one"]);
        expect(environmentIdsFromCredentialFile("not json")).toEqual([]);
    });

    it("refuses broad or unexpected purge targets", () => {
        expect(() => assertAppOwnedPaths({
            ...linuxPaths(),
            stateDirectory: "/home/ada",
        }, "linux")).toThrow("refusing to purge");
        expect(() => assertAppOwnedPaths({
            ...linuxPaths(),
            credentialsFile: "/home/ada/private.json",
        }, "linux")).toThrow("unexpected application file");
    });

    it("deletes known credentials and only app-owned directories", async () => {
        const removedCredentials: Array<string> = [];
        const removedPaths: Array<{ readonly path: string; readonly recursive: boolean }> = [];
        const credentials: CredentialStore = {
            mode: "keyring",
            async get() {
                return undefined;
            },
            async set() {},
            async delete(environmentId) {
                removedCredentials.push(environmentId);
            },
        };
        const result = await purgeAppData({
            paths: linuxPaths(),
            platform: "linux",
            credentials,
            environmentIds: ["current-environment", "fallback-environment"],
            fileSystem: {
                async readTextFile(filePath) {
                    expect(filePath).toBe(linuxPaths().credentialsFile);
                    return JSON.stringify({
                        version: 1,
                        environments: {
                            "fallback-environment": {
                                accessToken: "never-output-this-token",
                            },
                        },
                    });
                },
                async remove(path, options) {
                    removedPaths.push({ path, recursive: options.recursive });
                },
            },
        });

        expect(removedCredentials).toEqual(["current-environment", "fallback-environment"]);
        expect(removedPaths).toEqual([
            { path: linuxPaths().runtimeDirectory, recursive: true },
            { path: linuxPaths().logDirectory, recursive: true },
            { path: linuxPaths().stateDirectory, recursive: true },
            { path: linuxPaths().configDirectory, recursive: true },
        ]);
        expect(result).toEqual({ credentialsRemoved: 2, directoriesRemoved: 4 });
    });
});
