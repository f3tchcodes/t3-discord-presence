import { describe, expect, it } from "vitest";

import {
    resolveT3CliCommand,
    type T3CliFileSystemAdapter,
    type T3CliProcessAdapter,
} from "../src/t3/cli.js";

function fileSystem(files: ReadonlyArray<string>, links: Readonly<Record<string, string>> = {}): {
    readonly adapter: T3CliFileSystemAdapter;
    readonly checked: Array<string>;
} {
    const checked: Array<string> = [];
    return {
        checked,
        adapter: {
            async isFile(path) {
                checked.push(path);
                return files.includes(path);
            },
            async readLink(path) {
                return links[path];
            },
        },
    };
}

describe("T3 CLI resolution", () => {
    it("prefers a verified t3 command on PATH without inspecting Desktop files", async () => {
        const calls: Array<{ readonly executable: string; readonly arguments_: ReadonlyArray<string> }> = [];
        const processAdapter: T3CliProcessAdapter = {
            async run(executable, arguments_) {
                calls.push({ executable, arguments_ });
                return { exitCode: 0, stdout: "t3 v0.0.33\n", stderr: "" };
            },
        };
        const files = fileSystem([]);

        await expect(resolveT3CliCommand({
            process: processAdapter,
            fileSystem: files.adapter,
        })).resolves.toEqual({ executable: "t3", argumentsPrefix: [] });
        expect(calls).toEqual([{ executable: "t3", arguments_: ["--version"] }]);
        expect(files.checked).toEqual([]);
    });

    it("uses a bundled Windows CLI with spaced paths as discrete arguments", async () => {
        const bundled = "C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\t3code\\resources"
            + "\\app.asar.unpacked\\apps\\server\\dist\\bin.mjs";
        const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
        const files = fileSystem([bundled]);
        const calls: Array<{ readonly executable: string; readonly arguments_: ReadonlyArray<string> }> = [];
        const processAdapter: T3CliProcessAdapter = {
            async run(executable, arguments_) {
                calls.push({ executable, arguments_ });
                return executable === "t3"
                    ? { exitCode: 1, stdout: "", stderr: "not found" }
                    : { exitCode: 0, stdout: "v0.0.33", stderr: "" };
            },
        };

        await expect(resolveT3CliCommand({
            platform: "win32",
            env: { LOCALAPPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Local" },
            homeDir: "C:\\Users\\Ada Lovelace",
            nodeExecutable,
            currentExecutable: "C:\\Program Files\\nodejs\\node.exe",
            process: processAdapter,
            fileSystem: files.adapter,
        })).resolves.toEqual({
            executable: nodeExecutable,
            argumentsPrefix: [bundled],
        });
        expect(calls.at(-1)).toEqual({
            executable: nodeExecutable,
            arguments_: [bundled, "--version"],
        });
        expect(calls.at(-1)?.arguments_[0]).not.toContain('"');
    });

    it.each([
        {
            platform: "darwin" as const,
            homeDir: "/Users/ada",
            bundled: "/Applications/T3 Code.app/Contents/Resources/app.asar.unpacked/apps/server/dist/bin.mjs",
        },
        {
            platform: "linux" as const,
            homeDir: "/home/ada",
            bundled: "/opt/t3code/resources/app.asar.unpacked/apps/server/dist/bin.mjs",
        },
    ])("checks the stable $platform Desktop location", async ({ platform, homeDir, bundled }) => {
        const files = fileSystem([bundled]);
        const processAdapter: T3CliProcessAdapter = {
            async run(executable) {
                return executable === "t3"
                    ? { exitCode: 127, stdout: "", stderr: "" }
                    : { exitCode: 0, stdout: "0.0.33", stderr: "" };
            },
        };

        await expect(resolveT3CliCommand({
            platform,
            env: {},
            homeDir,
            nodeExecutable: "/usr/local/bin/node",
            currentExecutable: "/usr/local/bin/node",
            process: processAdapter,
            fileSystem: files.adapter,
        })).resolves.toEqual({
            executable: "/usr/local/bin/node",
            argumentsPrefix: [bundled],
        });
    });

    it("can derive a Linux Desktop resource directory from the live runtime PID", async () => {
        const bundled = "/run/user/1000/appimage/resources/app.asar.unpacked/apps/server/dist/bin.mjs";
        const files = fileSystem(
            [bundled],
            { "/proc/4321/exe": "/run/user/1000/appimage/t3code" },
        );
        const processAdapter: T3CliProcessAdapter = {
            async run(executable) {
                return executable === "t3"
                    ? { exitCode: 127, stdout: "", stderr: "" }
                    : { exitCode: 0, stdout: "0.0.33", stderr: "" };
            },
        };

        await expect(resolveT3CliCommand({
            platform: "linux",
            runtimePid: 4321,
            env: {},
            homeDir: "/home/ada",
            nodeExecutable: "/usr/bin/node",
            currentExecutable: "/usr/bin/node",
            process: processAdapter,
            fileSystem: files.adapter,
        })).resolves.toEqual({
            executable: "/usr/bin/node",
            argumentsPrefix: [bundled],
        });
    });

    it("returns undefined when neither PATH nor a verified bundled CLI is available", async () => {
        const files = fileSystem([]);
        const processAdapter: T3CliProcessAdapter = {
            async run() {
                return { exitCode: 1, stdout: "not a version", stderr: "" };
            },
        };

        await expect(resolveT3CliCommand({
            platform: "linux",
            env: {},
            homeDir: "/home/ada",
            currentExecutable: "/usr/bin/node",
            process: processAdapter,
            fileSystem: files.adapter,
        })).resolves.toBeUndefined();
    });
});
