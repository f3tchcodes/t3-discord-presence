import { describe, expect, it } from "vitest";

import type { PurgeAppDataOptions } from "../src/cli/purge.js";
import {
    CLI_EXIT,
    type CliDependencies,
    runCli,
    type RunCliOptions,
} from "../src/cli/run.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { CredentialStore, StoredCredential } from "../src/config/credentials.js";
import type { AppPaths } from "../src/config/paths.js";
import type { DaemonStatusSnapshot } from "../src/daemon/status.js";
import { T3AuthError } from "../src/t3/auth.js";
import type { DiscoveredT3Server } from "../src/t3/types.js";

function writer() {
    let value = "";
    return {
        stream: {
            write(chunk: string) {
                value += chunk;
                return true;
            },
        },
        value: () => value,
    };
}

function paths(): AppPaths {
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

function server(environmentId = "environment-one"): DiscoveredT3Server {
    return {
        baseDir: "/home/ada/.t3",
        variant: "userdata",
        runtimePath: "/home/ada/.t3/userdata/server-runtime.json",
        runtime: {
            version: 1,
            pid: 777,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-08-18T12:00:00.000Z",
        },
        descriptor: {
            environmentId,
            label: "T3 Code",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.33",
            capabilities: { repositoryIdentity: true },
        },
    };
}

function credentialStore(mode: "file" | "keyring" = "keyring"): CredentialStore {
    return {
        mode,
        async get() {
            return undefined;
        },
        async set() {},
        async delete() {},
    };
}

function dependencies(): CliDependencies {
    return {
        async ensureDirectories() {},
        async loadConfig() {
            return DEFAULT_CONFIG;
        },
        async saveConfig() {},
        async createCredentials() {
            return credentialStore();
        },
        async discover() {
            return undefined;
        },
        async authorize() {},
        async exchangePairing(discoveredServer) {
            return {
                environmentId: discoveredServer.descriptor.environmentId,
                accessToken: "unused-test-token",
                expiresAt: "2099-01-01T00:00:00.000Z",
                scope: "orchestration:read",
            };
        },
        async promptPairingCredential() {
            return undefined;
        },
        async resolveT3Cli() {
            return undefined;
        },
        async runDaemon() {},
        async installStartup() {
            return {
                platform: "linux",
                installed: true,
                mechanism: "systemd",
                changed: false,
                registrationConflict: false,
            };
        },
        async getStartupStatus() {
            return {
                platform: "linux",
                installed: true,
                mechanism: "systemd",
                current: true,
                systemdAvailable: true,
                unit: "current",
                desktop: "missing",
                enabled: true,
                active: true,
            };
        },
        async uninstallStartup() {
            return {
                platform: "linux",
                unitRemoved: true,
                desktopRemoved: false,
                serviceDisabled: true,
                registrationConflict: false,
            };
        },
        async readStatus() {
            return undefined;
        },
        async inspectDaemon() {
            return { running: false };
        },
        async startDaemon() {
            return { outcome: "started", pid: 123 };
        },
        async stopDaemon() {
            return { outcome: "already-stopped" };
        },
        async removeTransientData() {},
        async purgeData() {
            return { credentialsRemoved: 0, directoriesRemoved: 4 };
        },
        async discordIpcAvailable() {
            return undefined;
        },
    };
}

function options(overrides: Partial<CliDependencies> = {}): RunCliOptions {
    return {
        paths: paths(),
        platform: "linux",
        cliEntrypoint: "/opt/t3-discord-presence/dist/cli.js",
        nodeExecutable: "/opt/node/bin/node",
        environment: {},
        dependencies: { ...dependencies(), ...overrides },
    };
}

function statusSnapshot(): DaemonStatusSnapshot {
    return {
        version: 1,
        pid: 222,
        nonce: "status-daemon-nonce",
        updatedAt: "2026-08-18T12:00:00.000Z",
        daemon: "running",
        t3: "connected",
        discord: "connected",
        auth: "valid",
        environmentId: "private-environment-id",
        serverVersion: "0.0.33",
    };
}

describe("cli", () => {
    it("shows help explicitly", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["--help"], stdout.stream, stderr.stream)).resolves.toBe(CLI_EXIT.success);
        expect(stdout.value()).toContain("t3-discord-presence [command]");
        expect(stderr.value()).toBe("");
    });

    it("uses stable usage errors for unknown commands and invalid options", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["wat"], stdout.stream, stderr.stream)).resolves.toBe(CLI_EXIT.usage);
        expect(stderr.value()).toContain("unknown command: wat");
        expect(stderr.value()).toContain("usage:");

        const optionError = writer();
        await expect(runCli(["start", "--purge"], stdout.stream, optionError.stream))
            .resolves.toBe(CLI_EXIT.usage);
        expect(optionError.value()).toContain("start does not accept --purge");
    });

    it("passes the exact installed entrypoint and Node executable to start", async () => {
        const stdout = writer();
        const stderr = writer();
        let received: unknown;

        await expect(runCli(["start"], stdout.stream, stderr.stream, options({
            async startDaemon(startOptions) {
                received = startOptions;
                return { outcome: "started", pid: 123 };
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(received).toMatchObject({
            paths: paths(),
            cliEntrypoint: "/opt/t3-discord-presence/dist/cli.js",
            nodeExecutable: "/opt/node/bin/node",
            environment: {},
        });
        expect(stdout.value()).toContain("daemon: started");
        expect(stderr.value()).toBe("");
    });

    it("uses idempotent setup by default and keeps explicit install available", async () => {
        const stdout = writer();
        const stderr = writer();
        let saved = 0;
        let authorized = 0;
        let started = 0;
        const cliOptions = options({
            async saveConfig() {
                saved += 1;
            },
            async discover() {
                return server();
            },
            async authorize() {
                authorized += 1;
            },
            async startDaemon() {
                started += 1;
                return started === 1
                    ? { outcome: "started", pid: 123 }
                    : { outcome: "already-running", pid: 123 };
            },
        });

        await expect(runCli([], stdout.stream, stderr.stream, cliOptions))
            .resolves.toBe(CLI_EXIT.success);
        await expect(runCli([], stdout.stream, stderr.stream, cliOptions))
            .resolves.toBe(CLI_EXIT.success);
        await expect(runCli(["install"], stdout.stream, stderr.stream, cliOptions))
            .resolves.toBe(CLI_EXIT.success);

        expect({ saved, authorized, started }).toEqual({ saved: 3, authorized: 3, started: 3 });
        expect(stdout.value()).toContain("startup: installed (systemd) (already current)");
        expect(stdout.value()).toContain("daemon: started");
        expect(stdout.value()).toContain("daemon: already running");
        expect(stderr.value()).toBe("");
    });

    it("completes default setup with authorization pending while T3 is closed", async () => {
        const stdout = writer();
        const stderr = writer();
        let discoveryAttempts = 0;

        await expect(runCli([], stdout.stream, stderr.stream, options({
            async discover() {
                discoveryAttempts += 1;
                return undefined;
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(discoveryAttempts).toBe(1);
        expect(stdout.value()).toContain("startup: installed");
        expect(stdout.value()).toContain("auth: pending");
        expect(stdout.value()).toContain("daemon: started");
        expect(stderr.value()).toBe("");
    });

    it("reports a safe Windows startup fallback and preserved foreign registration", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["install"], stdout.stream, stderr.stream, options({
            async installStartup() {
                return {
                    platform: "win32",
                    installed: true,
                    mechanism: "startup-folder",
                    changed: true,
                    schedulerError: "private raw scheduler failure",
                    registrationConflict: true,
                };
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(stdout.value()).toContain("startup: installed (startup-folder)");
        expect(stderr.value()).toContain("Task Scheduler was unavailable");
        expect(stderr.value()).toContain("foreign same-name registration was preserved");
        expect(stderr.value()).not.toContain("private raw scheduler failure");
    });

    it("prints useful status without identifiers or credentials", async () => {
        const stdout = writer();
        const stderr = writer();
        const snapshot = statusSnapshot();

        await expect(runCli(["status"], stdout.stream, stderr.stream, options({
            async inspectDaemon() {
                return {
                    running: true,
                    record: {
                        version: 1,
                        pid: snapshot.pid,
                        nonce: snapshot.nonce,
                        startedAt: snapshot.updatedAt,
                        heartbeatAt: snapshot.updatedAt,
                        entrypoint: "/opt/t3-discord-presence/dist/cli.js",
                    },
                };
            },
            async readStatus() {
                return snapshot;
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(stdout.value()).toContain("startup: installed (systemd)");
        expect(stdout.value()).toContain("daemon: running");
        expect(stdout.value()).toContain("t3: connected");
        expect(stdout.value()).toContain("discord: connected");
        expect(stdout.value()).toContain("auth: valid");
        expect(stdout.value()).not.toContain("private-environment-id");
        expect(stderr.value()).toBe("");
    });

    it("authorizes without printing the credential", async () => {
        const stdout = writer();
        const stderr = writer();
        const secret = "never-print-this-access-token";
        let stored: StoredCredential | undefined;
        const store = credentialStore();

        await expect(runCli(["auth"], stdout.stream, stderr.stream, options({
            async discover() {
                return server();
            },
            async createCredentials() {
                return store;
            },
            async authorize() {
                stored = {
                    environmentId: "environment-one",
                    accessToken: secret,
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    scope: "orchestration:read",
                };
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(stored?.accessToken).toBe(secret);
        expect(stdout.value()).toBe("auth: valid (keyring storage)\n");
        expect(`${stdout.value()}${stderr.value()}`).not.toContain(secret);
    });

    it("uses a hidden one-time pairing fallback without echoing either credential", async () => {
        const stdout = writer();
        const stderr = writer();
        const pairingCredential = "one-time-pairing-secret";
        const accessToken = "persistent-access-secret";
        let promptText = "";
        let persisted: StoredCredential | undefined;

        await expect(runCli(["auth"], stdout.stream, stderr.stream, options({
            async discover() {
                return server();
            },
            async createCredentials() {
                return {
                    mode: "file",
                    async get() {
                        return undefined;
                    },
                    async set(credential) {
                        persisted = credential;
                    },
                    async delete() {},
                };
            },
            async authorize() {
                throw new T3AuthError("automatic pairing unavailable", "pairing-unavailable");
            },
            async promptPairingCredential(prompt) {
                promptText = prompt;
                return pairingCredential;
            },
            async exchangePairing(_server, receivedPairingCredential) {
                expect(receivedPairingCredential).toBe(pairingCredential);
                return {
                    environmentId: "environment-one",
                    accessToken,
                    expiresAt: "2099-01-01T00:00:00.000Z",
                    scope: "orchestration:read",
                };
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(promptText).toContain('t3 pair --label "t3 discord presence"');
        expect(promptText).toContain("requests only orchestration:read");
        expect(promptText).toContain("input hidden");
        expect(persisted?.accessToken).toBe(accessToken);
        const visibleOutput = `${stdout.value()}${stderr.value()}${promptText}`;
        expect(visibleOutput).not.toContain(pairingCredential);
        expect(visibleOutput).not.toContain(accessToken);
    });

    it("never leaks a pasted pairing credential through an exchange error", async () => {
        const stdout = writer();
        const stderr = writer();
        const pairingCredential = "pairing-secret-in-error";

        await expect(runCli(["auth"], stdout.stream, stderr.stream, options({
            async discover() {
                return server();
            },
            async authorize() {
                throw new T3AuthError("automatic pairing unavailable", "pairing-unavailable");
            },
            async promptPairingCredential() {
                return pairingCredential;
            },
            async exchangePairing() {
                throw new Error(`exchange failed for ${pairingCredential}`);
            },
        }))).resolves.toBe(CLI_EXIT.failure);

        expect(`${stdout.value()}${stderr.value()}`).not.toContain(pairingCredential);
        expect(stderr.value()).toContain("operation failed unexpectedly");
    });

    it("returns an availability code when T3 is closed", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["auth"], stdout.stream, stderr.stream, options()))
            .resolves.toBe(CLI_EXIT.unavailable);
        expect(stderr.value()).toContain("T3 Code is not running");
    });

    it("prints only the configured log path", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["logs"], stdout.stream, stderr.stream, options()))
            .resolves.toBe(CLI_EXIT.success);
        expect(stdout.value()).toBe(`${paths().logFile}\n`);
        expect(stderr.value()).toBe("");
    });

    it("reports doctor checks without revealing ids or stored tokens", async () => {
        const stdout = writer();
        const stderr = writer();
        const secret = "doctor-must-not-print-this-token";

        await expect(runCli(["doctor"], stdout.stream, stderr.stream, options({
            async discover() {
                return server("doctor-private-environment");
            },
            async resolveT3Cli() {
                return { executable: "t3", argumentsPrefix: [] };
            },
            async createCredentials() {
                return {
                    mode: "keyring",
                    async get(environmentId) {
                        return {
                            environmentId,
                            accessToken: secret,
                            expiresAt: "2099-01-01T00:00:00.000Z",
                            scope: "orchestration:read",
                        };
                    },
                    async set() {},
                    async delete() {},
                };
            },
            async discordIpcAvailable() {
                return true;
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(stdout.value()).toContain("node: ok");
        expect(stdout.value()).toContain("startup: ok");
        expect(stdout.value()).toContain("t3 runtime: ok");
        expect(stdout.value()).toContain("t3 environment: ok");
        expect(stdout.value()).toContain("t3 cli: ok");
        expect(stdout.value()).toContain("auth: ok");
        expect(stdout.value()).toContain("discord ipc: ok");
        expect(stdout.value()).toContain("discord application: ok - built-in application configured");
        expect(stdout.value()).toContain("config: ok");
        expect(stdout.value()).not.toContain(secret);
        expect(stdout.value()).not.toContain("doctor-private-environment");
        expect(stderr.value()).toBe("");
    });

    it("purges only after shutdown and includes every currently known environment", async () => {
        const stdout = writer();
        const stderr = writer();
        let purgeOptions: PurgeAppDataOptions | undefined;

        await expect(runCli(["uninstall", "--purge"], stdout.stream, stderr.stream, options({
            async readStatus() {
                return statusSnapshot();
            },
            async discover() {
                return server("second-environment-id");
            },
            async purgeData(received) {
                purgeOptions = received;
                return { credentialsRemoved: 2, directoriesRemoved: 4 };
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(purgeOptions?.paths).toEqual(paths());
        expect(purgeOptions?.environmentIds).toEqual([
            "private-environment-id",
            "second-environment-id",
        ]);
        expect(stdout.value()).toContain("2 known authorization record(s)");
        expect(stdout.value()).toContain("T3 Code data was not changed");
        expect(stdout.value()).not.toContain("private-environment-id");
        expect(stderr.value()).toBe("");
    });

    it("preserves foreign startup registrations during uninstall", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["uninstall"], stdout.stream, stderr.stream, options({
            async uninstallStartup() {
                return {
                    platform: "linux",
                    unitRemoved: false,
                    desktopRemoved: false,
                    serviceDisabled: false,
                    registrationConflict: true,
                };
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(stdout.value()).toContain("foreign same-name registration preserved");
        expect(stderr.value()).toBe("");
    });

    it("fails safely when Task Scheduler removal cannot be confirmed", async () => {
        const stdout = writer();
        const stderr = writer();
        let transientDataRemoved = false;

        await expect(runCli(["uninstall"], stdout.stream, stderr.stream, options({
            async uninstallStartup() {
                return {
                    platform: "win32",
                    taskRemoved: false,
                    fallbackRemoved: true,
                    managedFilesRemoved: 2,
                    registrationConflict: false,
                    schedulerError: "private raw scheduler failure",
                };
            },
            async removeTransientData() {
                transientDataRemoved = true;
            },
        }))).resolves.toBe(CLI_EXIT.failure);

        expect(transientDataRemoved).toBe(true);
        expect(stderr.value()).toContain("Task Scheduler removal could not be confirmed");
        expect(stderr.value()).not.toContain("private raw scheduler failure");
    });

    it("passes --debug only to a foreground daemon", async () => {
        const stdout = writer();
        const stderr = writer();
        let received: unknown;

        await expect(runCli(["run", "--debug"], stdout.stream, stderr.stream, options({
            async runDaemon(daemonOptions) {
                received = daemonOptions;
            },
        }))).resolves.toBe(CLI_EXIT.success);

        expect(received).toMatchObject({
            paths: paths(),
            entrypoint: "/opt/t3-discord-presence/dist/cli.js",
            debug: true,
            handleProcessSignals: true,
        });
        expect(stdout.value()).toContain("foreground (debug)");
    });
});
