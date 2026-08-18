import { describe, expect, it } from "vitest";

import {
    type DaemonLifecycleDependencies,
    startDaemon,
    stopDaemon,
} from "../src/cli/lifecycle.js";
import type { AppPaths } from "../src/config/paths.js";
import type { DaemonLockRecord } from "../src/daemon/lock.js";

function appPaths(): AppPaths {
    return {
        configDirectory: "C:\\Users\\Ada\\AppData\\Roaming\\t3-discord-presence",
        configFile: "C:\\Users\\Ada\\AppData\\Roaming\\t3-discord-presence\\config.json",
        stateDirectory: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\state",
        stateFile: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\state\\state.json",
        credentialsFile: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\state\\credentials.json",
        runtimeDirectory: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\runtime",
        lockFile: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\runtime\\daemon.lock",
        stopFile: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\runtime\\daemon.stop",
        statusFile: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\runtime\\status.json",
        logDirectory: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\logs",
        logFile: "C:\\Users\\Ada\\AppData\\Local\\t3-discord-presence\\logs\\daemon.log",
    };
}

function lock(pid: number, nonce = "daemon-owner-nonce"): DaemonLockRecord {
    return {
        version: 1,
        pid,
        nonce,
        startedAt: "2026-08-18T12:00:00.000Z",
        heartbeatAt: "2026-08-18T12:00:00.000Z",
        entrypoint: "C:\\package\\dist\\cli.js",
    };
}

describe("CLI daemon lifecycle", () => {
    it("does not spawn a duplicate daemon with a fresh live lock", async () => {
        let spawnCount = 0;
        const result = await startDaemon({
            paths: appPaths(),
            cliEntrypoint: "C:\\package\\dist\\cli.js",
            dependencies: {
                readLock: async () => lock(101),
                isProcessRunning: () => true,
                process: {
                    async spawn() {
                        spawnCount += 1;
                        return { pid: 202 };
                    },
                },
            },
        });

        expect(result).toEqual({ outcome: "already-running", pid: 101 });
        expect(spawnCount).toBe(0);
    });

    it("does not spawn a duplicate when a live daemon has a stale heartbeat", async () => {
        let spawnCount = 0;
        const result = await startDaemon({
            paths: appPaths(),
            cliEntrypoint: "C:\\package\\dist\\cli.js",
            dependencies: {
                readLock: async () => lock(101),
                isProcessRunning: () => true,
                process: {
                    async spawn() {
                        spawnCount += 1;
                        return { pid: 202 };
                    },
                },
            },
        });

        expect(result).toEqual({ outcome: "already-running", pid: 101 });
        expect(spawnCount).toBe(0);
    });

    it("spawns the exact Node and compiled CLI command without a shell", async () => {
        let spawned = false;
        let invocation: {
            readonly executable: string;
            readonly arguments_: ReadonlyArray<string>;
            readonly options: unknown;
        } | undefined;
        const result = await startDaemon({
            paths: appPaths(),
            nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
            cliEntrypoint: "C:\\npm\\node_modules\\t3-discord-presence\\dist\\cli.js",
            environment: { T3CODE_HOME: "C:\\T3 Home" },
            dependencies: {
                readLock: async () => spawned ? lock(202) : undefined,
                isProcessRunning: () => true,
                process: {
                    async spawn(executable, arguments_, options) {
                        invocation = { executable, arguments_, options };
                        spawned = true;
                        return { pid: 202 };
                    },
                },
            },
        });

        expect(result).toEqual({ outcome: "started", pid: 202 });
        expect(invocation).toEqual({
            executable: "C:\\Program Files\\nodejs\\node.exe",
            arguments_: [
                "C:\\npm\\node_modules\\t3-discord-presence\\dist\\cli.js",
                "daemon",
            ],
            options: {
                detached: true,
                env: { T3CODE_HOME: "C:\\T3 Home" },
                shell: false,
                stdio: "ignore",
                windowsHide: true,
            },
        });
    });

    it("requests a nonce-bound cooperative stop and never signals the pid", async () => {
        const target = lock(303, "specific-daemon-nonce");
        let reads = 0;
        let stopArguments: ReadonlyArray<string> | undefined;
        const dependencies: Partial<DaemonLifecycleDependencies> = {
            readLock: async () => {
                reads += 1;
                return reads <= 2 ? target : undefined;
            },
            requestStop: async (lockFile, stopFile) => {
                stopArguments = [lockFile, stopFile];
                return target;
            },
            isProcessRunning: () => true,
            delay: async () => undefined,
        };

        await expect(stopDaemon({ paths: appPaths(), dependencies })).resolves.toEqual({
            outcome: "stopped",
            pid: 303,
        });
        expect(stopArguments).toEqual([appPaths().lockFile, appPaths().stopFile]);
    });

    it("reports a timeout without killing an unresponsive process", async () => {
        const target = lock(404);
        await expect(stopDaemon({
            paths: appPaths(),
            timeoutMs: 2,
            pollMs: 1,
            dependencies: {
                readLock: async () => target,
                requestStop: async () => target,
                isProcessRunning: () => true,
                delay: async () => undefined,
            },
        })).resolves.toEqual({ outcome: "timed-out", pid: 404 });
    });
});
