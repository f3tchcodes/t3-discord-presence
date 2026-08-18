import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
    type AppConfig,
    ConfigError,
    loadConfig,
    saveConfig,
} from "../config/config.js";
import {
    createCredentialStore,
    type CredentialStore,
    type StoredCredential,
} from "../config/credentials.js";
import {
    type AppPaths,
    ensureAppDirectories,
    resolveAppPaths,
} from "../config/paths.js";
import {
    runDaemon,
    type RunDaemonOptions,
} from "../daemon/daemon.js";
import { DuplicateDaemonError } from "../daemon/lock.js";
import {
    type DaemonStatusSnapshot,
    readDaemonStatus,
} from "../daemon/status.js";
import { DISCORD_APPLICATION_ID } from "../discord/application.js";
import {
    getStartupStatus,
    installStartup,
    type StartupInstallResult,
    type StartupOptions,
    type StartupStatus,
    type StartupUninstallResult,
    uninstallStartup,
} from "../startup/index.js";
import {
    authorizeT3Server,
    exchangePairingCredential,
    isCredentialUsable,
    T3AuthError,
} from "../t3/auth.js";
import {
    resolveT3CliCommand,
    type T3CliCommand,
} from "../t3/cli.js";
import { discoverT3Server } from "../t3/discovery.js";
import type { DiscoveredT3Server } from "../t3/types.js";
import { discordIpcAvailable, supportedNodeVersion } from "./diagnostics.js";
import { commandNames, helpText } from "./help.js";
import {
    inspectDaemon,
    startDaemon,
    type StartDaemonOptions,
    type StartDaemonResult,
    stopDaemon,
    type StopDaemonOptions,
    type StopDaemonResult,
} from "./lifecycle.js";
import { promptForSecret } from "./prompt.js";
import {
    purgeAppData,
    type PurgeAppDataOptions,
    type PurgeAppDataResult,
    removeTransientDaemonData,
} from "./purge.js";

export const CLI_EXIT = Object.freeze({
    success: 0,
    failure: 1,
    usage: 2,
    unavailable: 3,
} as const);

interface PackageMetadata {
    readonly version: string;
}

export interface CliWriter {
    write(chunk: string): unknown;
}

export interface CliDependencies {
    readonly ensureDirectories: (paths: AppPaths) => Promise<void>;
    readonly loadConfig: (configFile: string) => Promise<AppConfig>;
    readonly saveConfig: (config: AppConfig, configFile: string) => Promise<void>;
    readonly createCredentials: (credentialsFile: string) => Promise<CredentialStore>;
    readonly discover: (environment: NodeJS.ProcessEnv) => Promise<DiscoveredT3Server | undefined>;
    readonly authorize: (
        server: DiscoveredT3Server,
        credentials: CredentialStore,
        environment: NodeJS.ProcessEnv,
    ) => Promise<void>;
    readonly exchangePairing: (
        server: DiscoveredT3Server,
        pairingCredential: string,
        environment: NodeJS.ProcessEnv,
    ) => Promise<StoredCredential>;
    readonly promptPairingCredential: (prompt: string) => Promise<string | undefined>;
    readonly resolveT3Cli: (
        environment: NodeJS.ProcessEnv,
        runtimePid?: number,
    ) => Promise<T3CliCommand | undefined>;
    readonly runDaemon: (options: RunDaemonOptions) => Promise<void>;
    readonly installStartup: (options: StartupOptions) => Promise<StartupInstallResult>;
    readonly getStartupStatus: (options: StartupOptions) => Promise<StartupStatus>;
    readonly uninstallStartup: (options: StartupOptions) => Promise<StartupUninstallResult>;
    readonly readStatus: (statusFile: string) => Promise<DaemonStatusSnapshot | undefined>;
    readonly inspectDaemon: typeof inspectDaemon;
    readonly startDaemon: (options: StartDaemonOptions) => Promise<StartDaemonResult>;
    readonly stopDaemon: (options: StopDaemonOptions) => Promise<StopDaemonResult>;
    readonly removeTransientData: (
        paths: AppPaths,
        platform: NodeJS.Platform,
    ) => Promise<void>;
    readonly purgeData: (options: PurgeAppDataOptions) => Promise<PurgeAppDataResult>;
    readonly discordIpcAvailable: (
        environment: NodeJS.ProcessEnv,
        platform: NodeJS.Platform,
    ) => Promise<boolean | undefined>;
}

export interface RunCliOptions {
    readonly paths?: AppPaths;
    readonly cliEntrypoint?: string;
    readonly nodeExecutable?: string;
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly nodeVersion?: string;
    readonly dependencies?: Partial<CliDependencies>;
}

class CliUsageError extends Error {
    override readonly name = "CliUsageError";
}

interface CliContext {
    readonly paths: AppPaths;
    readonly cliEntrypoint: string;
    readonly nodeExecutable: string;
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly nodeVersion: string;
    readonly output: CliWriter;
    readonly errorOutput: CliWriter;
    readonly dependencies: CliDependencies;
}

interface ParsedCommand {
    readonly name: string;
    readonly debug: boolean;
    readonly purge: boolean;
}

function defaultDependencies(): CliDependencies {
    return {
        ensureDirectories: ensureAppDirectories,
        loadConfig,
        saveConfig,
        createCredentials: async credentialsFile => createCredentialStore({ credentialsFile }),
        discover: async environment => discoverT3Server({ env: environment }),
        authorize: async (server, credentials, environment) => {
            await authorizeT3Server(server, credentials, { env: environment });
        },
        exchangePairing: async (server, pairingCredential) => (
            exchangePairingCredential(server, pairingCredential)
        ),
        promptPairingCredential: async prompt => promptForSecret({ prompt }),
        resolveT3Cli: async (environment, runtimePid) => resolveT3CliCommand({
            env: environment,
            ...(runtimePid === undefined ? {} : { runtimePid }),
        }),
        runDaemon,
        installStartup,
        getStartupStatus,
        uninstallStartup,
        readStatus: readDaemonStatus,
        inspectDaemon,
        startDaemon,
        stopDaemon,
        removeTransientData: async (paths, platform) => {
            await removeTransientDaemonData(paths, { platform });
        },
        purgeData: purgeAppData,
        discordIpcAvailable: async (environment, platform) => (
            discordIpcAvailable({ environment, platform })
        ),
    };
}

async function readVersion(): Promise<string> {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const value: unknown = JSON.parse(await readFile(packageUrl, "utf8"));
    if (
        typeof value !== "object"
        || value === null
        || !("version" in value)
        || typeof value.version !== "string"
    ) {
        throw new Error("package version is missing");
    }
    return (value as PackageMetadata).version;
}

function defaultCliEntrypoint(): string {
    return fileURLToPath(new URL("../cli.js", import.meta.url));
}

function startupOptions(context: CliContext): StartupOptions {
    return {
        cliEntrypoint: context.cliEntrypoint,
        nodeExecutable: context.nodeExecutable,
        paths: context.paths,
        platform: context.platform,
        environment: context.environment,
    };
}

function writeLine(writer: CliWriter, line: string): void {
    writer.write(`${line}\n`);
}

function parseCommand(arguments_: ReadonlyArray<string>): ParsedCommand | "help" | "version" {
    const command = arguments_[0];
    if (command === undefined) {
        return { name: "install", debug: false, purge: false };
    }
    if (command === "help" || command === "--help" || command === "-h") {
        if (arguments_.length > 1) throw new CliUsageError("help does not accept arguments");
        return "help";
    }
    if (command === "--version" || command === "-v") {
        if (arguments_.length > 1) throw new CliUsageError("version does not accept arguments");
        return "version";
    }
    const publicCommand = (commandNames as ReadonlyArray<string>).includes(command);
    if (!publicCommand && command !== "daemon") {
        throw new CliUsageError(`unknown command: ${command}`);
    }
    const options = arguments_.slice(1);
    if (options.includes("--help") || options.includes("-h")) return "help";
    const allowed = command === "uninstall"
        ? new Set(["--purge"])
        : command === "run" || command === "daemon"
            ? new Set(["--debug"])
            : new Set<string>();
    const invalid = options.find(option => !allowed.has(option));
    if (invalid !== undefined) {
        throw new CliUsageError(`${command} does not accept ${invalid}`);
    }
    if (new Set(options).size !== options.length) {
        throw new CliUsageError(`${command} received a duplicate option`);
    }
    return {
        name: command,
        debug: options.includes("--debug"),
        purge: options.includes("--purge"),
    };
}

function safePublicError(error: unknown): string {
    if (
        error instanceof CliUsageError
        || error instanceof ConfigError
        || error instanceof T3AuthError
        || error instanceof DuplicateDaemonError
        || error instanceof RangeError
    ) {
        return error.message
            .replace(/([?&]wsTicket=)[^&\s]+/giu, "$1[redacted]")
            .replace(/\b(Bearer|access_token|subject_token)\s*[:=]?\s*\S+/giu, "$1 [redacted]")
            .slice(0, 1_024);
    }
    return "the operation failed unexpectedly; run `t3-discord-presence doctor`";
}

async function authorizeCurrentT3(context: CliContext): Promise<{
    readonly server?: DiscoveredT3Server;
    readonly credentials?: CredentialStore;
}> {
    await context.dependencies.ensureDirectories(context.paths);
    const server = await context.dependencies.discover(context.environment);
    if (server === undefined) return {};
    const credentials = await context.dependencies.createCredentials(context.paths.credentialsFile);
    try {
        await context.dependencies.authorize(server, credentials, context.environment);
    } catch (error) {
        if (
            !(error instanceof T3AuthError)
            || (error.code !== "pairing-unavailable" && error.code !== "pairing-failed")
        ) {
            throw error;
        }
        const pairingCredential = await context.dependencies.promptPairingCredential(
            "Automatic T3 CLI pairing is unavailable.\n"
            + "Run `t3 pair --label \"t3 discord presence\"` and paste its Token value.\n"
            + "The exchanged stored credential requests only orchestration:read.\n"
            + "Token (input hidden): ",
        );
        if (pairingCredential === undefined) {
            throw new T3AuthError(
                "automatic pairing is unavailable; run auth from an interactive terminal to paste a one-time credential",
                "pairing-unavailable",
            );
        }
        const credential = await context.dependencies.exchangePairing(
            server,
            pairingCredential,
            context.environment,
        );
        await credentials.set(credential);
    }
    return { server, credentials };
}

async function startCommand(context: CliContext): Promise<number> {
    await context.dependencies.ensureDirectories(context.paths);
    const result = await context.dependencies.startDaemon({
        paths: context.paths,
        cliEntrypoint: context.cliEntrypoint,
        nodeExecutable: context.nodeExecutable,
        environment: context.environment,
    });
    writeLine(
        context.output,
        result.outcome === "started" ? "daemon: started" : "daemon: already running",
    );
    return CLI_EXIT.success;
}

async function stopCommand(context: CliContext): Promise<number> {
    const result = await context.dependencies.stopDaemon({ paths: context.paths });
    if (result.outcome === "timed-out") {
        writeLine(context.errorOutput, "daemon: stop request timed out; no process was killed");
        return CLI_EXIT.failure;
    }
    writeLine(
        context.output,
        result.outcome === "stopped" ? "daemon: stopped" : "daemon: already stopped",
    );
    return CLI_EXIT.success;
}

async function restartCommand(context: CliContext): Promise<number> {
    const stopped = await stopCommand(context);
    if (stopped !== CLI_EXIT.success) return stopped;
    return startCommand(context);
}

function startupMechanism(status: StartupStatus): string {
    if ("mechanism" in status && status.mechanism !== "none") return status.mechanism;
    return status.platform === "darwin" ? "launch-agent" : status.platform;
}

async function statusCommand(context: CliContext): Promise<number> {
    let startup: StartupStatus | undefined;
    try {
        startup = await context.dependencies.getStartupStatus(startupOptions(context));
    } catch {
        startup = undefined;
    }
    const inspection = await context.dependencies.inspectDaemon(context.paths);
    const status = await context.dependencies.readStatus(context.paths.statusFile)
        .catch(() => undefined);
    const currentStatus = inspection.running
        ? status?.nonce === inspection.record?.nonce ? status : undefined
        : status?.daemon === "stopped" ? status : undefined;
    writeLine(
        context.output,
        startup === undefined
            ? "startup: unavailable"
            : startup.installed
                ? `startup: installed (${startupMechanism(startup)})`
                : "startup: not installed",
    );
    writeLine(context.output, `daemon: ${inspection.running ? "running" : "stopped"}`);
    writeLine(context.output, `t3: ${currentStatus?.t3 ?? "waiting"}`);
    writeLine(context.output, `discord: ${currentStatus?.discord ?? "inactive"}`);
    writeLine(context.output, `auth: ${currentStatus?.auth ?? "unknown"}`);
    if (!inspection.running) {
        writeLine(context.output, "hint: run `t3-discord-presence start`");
    } else if (currentStatus?.t3 === "waiting") {
        writeLine(context.output, "hint: open T3 Code; the daemon will reconnect automatically");
    } else if (currentStatus?.discord === "waiting") {
        writeLine(context.output, "hint: open Discord Desktop; the daemon will reconnect automatically");
    } else if (currentStatus?.auth === "required" || currentStatus?.auth === "expired") {
        writeLine(context.output, "hint: run `t3-discord-presence auth`");
    }
    return startup === undefined ? CLI_EXIT.failure : CLI_EXIT.success;
}

async function authCommand(context: CliContext): Promise<number> {
    const authorization = await authorizeCurrentT3(context);
    if (authorization.server === undefined || authorization.credentials === undefined) {
        writeLine(context.errorOutput, "auth: T3 Code is not running or its local server is unavailable");
        return CLI_EXIT.unavailable;
    }
    writeLine(context.output, `auth: valid (${authorization.credentials.mode} storage)`);
    return CLI_EXIT.success;
}

interface DoctorCheck {
    readonly label: string;
    readonly level: "ok" | "warning" | "error";
    readonly detail: string;
}

function printDoctorCheck(output: CliWriter, check: DoctorCheck): void {
    writeLine(output, `${check.label}: ${check.level} - ${check.detail}`);
}

async function doctorCommand(context: CliContext): Promise<number> {
    const checks: Array<DoctorCheck> = [];
    const nodeSupported = supportedNodeVersion(context.nodeVersion);
    checks.push({
        label: "node",
        level: nodeSupported ? "ok" : "error",
        detail: nodeSupported
            ? `${context.nodeVersion} is supported`
            : `${context.nodeVersion} is unsupported; Node.js 22 or newer is required`,
    });

    let startup: StartupStatus | undefined;
    try {
        startup = await context.dependencies.getStartupStatus(startupOptions(context));
        checks.push({
            label: "startup",
            level: startup.installed && startup.current ? "ok" : "warning",
            detail: startup.installed
                ? startup.current
                    ? `installed (${startupMechanism(startup)})`
                    : "installed registration needs repair; rerun t3-discord-presence"
                : "not installed; run t3-discord-presence",
        });
    } catch {
        checks.push({ label: "startup", level: "error", detail: "could not inspect registration" });
    }

    let inspection: Awaited<ReturnType<typeof inspectDaemon>> | undefined;
    try {
        inspection = await context.dependencies.inspectDaemon(context.paths);
        checks.push({
            label: "daemon",
            level: inspection.running ? "ok" : "warning",
            detail: inspection.running ? "running" : "not running",
        });
    } catch {
        checks.push({ label: "daemon", level: "error", detail: "could not inspect daemon state" });
    }
    const storedDaemonStatus = inspection?.running
        ? await context.dependencies.readStatus(context.paths.statusFile).catch(() => undefined)
        : undefined;
    const daemonStatus = storedDaemonStatus?.nonce === inspection?.record?.nonce
        ? storedDaemonStatus
        : undefined;

    let server: DiscoveredT3Server | undefined;
    try {
        server = await context.dependencies.discover(context.environment);
        checks.push({
            label: "t3 runtime",
            level: server === undefined ? "warning" : "ok",
            detail: server === undefined ? "no verified local T3 server found" : "verified local server found",
        });
        checks.push({
            label: "t3 environment",
            level: server === undefined ? "warning" : "ok",
            detail: server === undefined
                ? "descriptor unavailable while T3 is closed"
                : `descriptor verified (server ${server.descriptor.serverVersion})`,
        });
    } catch {
        checks.push({ label: "t3 runtime", level: "error", detail: "discovery failed" });
        checks.push({ label: "t3 environment", level: "error", detail: "descriptor check failed" });
    }

    let cli: T3CliCommand | undefined;
    try {
        cli = await context.dependencies.resolveT3Cli(context.environment, server?.runtime.pid);
        checks.push({
            label: "t3 cli",
            level: cli === undefined ? "warning" : "ok",
            detail: cli === undefined
                ? "not found on PATH or in the T3 Desktop installation"
                : "supported CLI found",
        });
    } catch {
        checks.push({ label: "t3 cli", level: "warning", detail: "availability check failed" });
    }

    if (server === undefined) {
        checks.push({
            label: "auth",
            level: "warning",
            detail: "cannot check without a running T3 environment",
        });
    } else {
        try {
            const credentials = await context.dependencies.createCredentials(context.paths.credentialsFile);
            const credential = await credentials.get(server.descriptor.environmentId);
            const usable = credential !== undefined && isCredentialUsable(credential);
            checks.push({
                label: "auth",
                level: usable ? "ok" : "warning",
                detail: usable
                    ? `valid (${credentials.mode} storage)`
                    : cli === undefined
                        ? "authorization missing and no supported T3 CLI was found"
                        : "authorization missing or expired; run auth",
            });
        } catch {
            checks.push({ label: "auth", level: "error", detail: "credential storage unavailable" });
        }
    }

    const builtInDiscordApplication = DISCORD_APPLICATION_ID.trim().length > 0;
    checks.push({
        label: "discord application",
        level: builtInDiscordApplication ? "ok" : "error",
        detail: builtInDiscordApplication
            ? "built-in application configured"
            : "built-in application is unavailable",
    });
    try {
        await context.dependencies.loadConfig(context.paths.configFile);
        checks.push({ label: "config", level: "ok", detail: "privacy and image settings are valid" });
    } catch (error) {
        checks.push({
            label: "config",
            level: "error",
            detail: error instanceof ConfigError ? "config file is invalid" : "configuration check failed",
        });
    }

    try {
        const connected = daemonStatus?.discord === "connected"
            ? true
            : await context.dependencies.discordIpcAvailable(
                context.environment,
                context.platform,
            );
        checks.push({
            label: "discord ipc",
            level: connected === false ? "warning" : "ok",
            detail: connected === true
                ? "available"
                : connected === false
                    ? "not found; open Discord Desktop"
                    : "checked by the daemon when Discord connects",
        });
    } catch {
        checks.push({ label: "discord ipc", level: "warning", detail: "availability check failed" });
    }

    for (const check of checks) printDoctorCheck(context.output, check);
    return checks.some(check => check.level === "error")
        ? CLI_EXIT.failure
        : CLI_EXIT.success;
}

async function installCommand(context: CliContext): Promise<number> {
    await context.dependencies.ensureDirectories(context.paths);
    const config = await context.dependencies.loadConfig(context.paths.configFile);
    await context.dependencies.saveConfig(config, context.paths.configFile);
    const startup = await context.dependencies.installStartup(startupOptions(context));
    const detail = "mechanism" in startup ? ` (${startup.mechanism})` : "";
    writeLine(
        context.output,
        `startup: installed${detail}${startup.changed ? "" : " (already current)"}`,
    );
    if ("schedulerError" in startup && startup.schedulerError !== undefined) {
        writeLine(
            context.errorOutput,
            "startup: Task Scheduler was unavailable; using the per-user startup folder",
        );
    }
    if ("registrationConflict" in startup && startup.registrationConflict) {
        writeLine(
            context.errorOutput,
            "startup: a foreign same-name registration was preserved",
        );
    }
    try {
        const authorization = await authorizeCurrentT3(context);
        writeLine(
            context.output,
            authorization.server === undefined
                ? "auth: pending (open T3 Code and run `t3-discord-presence auth`)"
                : `auth: valid (${authorization.credentials?.mode ?? "secure"} storage)`,
        );
    } catch (error) {
        writeLine(context.output, `auth: pending (${safePublicError(error)})`);
    }
    return startCommand(context);
}

async function knownEnvironmentIds(context: CliContext): Promise<ReadonlyArray<string>> {
    const environmentIds = new Set<string>();
    const status = await context.dependencies.readStatus(context.paths.statusFile).catch(() => undefined);
    if (status?.environmentId !== undefined) environmentIds.add(status.environmentId);
    const server = await context.dependencies.discover(context.environment).catch(() => undefined);
    if (server !== undefined) environmentIds.add(server.descriptor.environmentId);
    return [...environmentIds];
}

async function uninstallCommand(context: CliContext, purge: boolean): Promise<number> {
    const environmentIds = purge ? await knownEnvironmentIds(context) : [];
    const stopped = await context.dependencies.stopDaemon({ paths: context.paths });
    if (stopped.outcome === "timed-out") {
        writeLine(context.errorOutput, "daemon: stop request timed out; no process was killed");
    } else {
        writeLine(
            context.output,
            stopped.outcome === "stopped" ? "daemon: stopped" : "daemon: already stopped",
        );
    }
    const startup = await context.dependencies.uninstallStartup(startupOptions(context));
    const schedulerUnconfirmed = startup.platform === "win32"
        && startup.schedulerError !== undefined;
    if (schedulerUnconfirmed) {
        writeLine(
            context.errorOutput,
            "startup: owned files were removed, but Task Scheduler removal could not be confirmed",
        );
    } else if (startup.registrationConflict) {
        writeLine(
            context.output,
            "startup: foreign same-name registration preserved; only owned files were removed",
        );
    } else {
        writeLine(context.output, "startup: removed this app's registration");
    }
    if (stopped.outcome === "timed-out") {
        writeLine(
            context.errorOutput,
            "data: preserved because the running daemon did not confirm shutdown",
        );
        return CLI_EXIT.failure;
    }
    if (purge) {
        const credentials = await context.dependencies.createCredentials(context.paths.credentialsFile);
        const result = await context.dependencies.purgeData({
            paths: context.paths,
            credentials,
            platform: context.platform,
            environmentIds,
        });
        writeLine(
            context.output,
            `data: purged this app's config, logs, state, and ${String(result.credentialsRemoved)} known authorization record(s)`,
        );
        writeLine(context.output, "T3 Code data was not changed");
    } else {
        await context.dependencies.removeTransientData(context.paths, context.platform);
        writeLine(context.output, "data: config and stored authorization preserved");
    }
    return schedulerUnconfirmed ? CLI_EXIT.failure : CLI_EXIT.success;
}

async function foregroundCommand(context: CliContext, debug: boolean): Promise<number> {
    writeLine(
        context.output,
        debug ? "daemon: running in foreground (debug)" : "daemon: running in foreground",
    );
    await context.dependencies.runDaemon({
        paths: context.paths,
        entrypoint: context.cliEntrypoint,
        handleProcessSignals: true,
        debug,
    });
    return CLI_EXIT.success;
}

async function internalDaemonCommand(context: CliContext, debug: boolean): Promise<number> {
    try {
        await context.dependencies.runDaemon({
            paths: context.paths,
            entrypoint: context.cliEntrypoint,
            handleProcessSignals: true,
            debug,
        });
        return CLI_EXIT.success;
    } catch (error) {
        if (error instanceof DuplicateDaemonError) return CLI_EXIT.success;
        throw error;
    }
}

async function dispatch(command: ParsedCommand, context: CliContext): Promise<number> {
    switch (command.name) {
        case "install": return installCommand(context);
        case "uninstall": return uninstallCommand(context, command.purge);
        case "start": return startCommand(context);
        case "stop": return stopCommand(context);
        case "restart": return restartCommand(context);
        case "status": return statusCommand(context);
        case "auth": return authCommand(context);
        case "doctor": return doctorCommand(context);
        case "logs":
            writeLine(context.output, context.paths.logFile);
            return CLI_EXIT.success;
        case "run": return foregroundCommand(context, command.debug);
        case "daemon": return internalDaemonCommand(context, command.debug);
        default: throw new CliUsageError(`unknown command: ${command.name}`);
    }
}

export async function runCli(
    arguments_: ReadonlyArray<string>,
    output: CliWriter = process.stdout,
    errorOutput: CliWriter = process.stderr,
    options: RunCliOptions = {},
): Promise<number> {
    try {
        const parsed = parseCommand(arguments_);
        if (parsed === "help") {
            output.write(helpText);
            return CLI_EXIT.success;
        }
        if (parsed === "version") {
            writeLine(output, await readVersion());
            return CLI_EXIT.success;
        }
        const platform = options.platform ?? process.platform;
        const environment = { ...(options.environment ?? process.env) };
        const context: CliContext = {
            paths: options.paths ?? resolveAppPaths({ platform, env: environment }),
            cliEntrypoint: options.cliEntrypoint ?? defaultCliEntrypoint(),
            nodeExecutable: options.nodeExecutable ?? process.execPath,
            platform,
            environment,
            nodeVersion: options.nodeVersion ?? process.version,
            output,
            errorOutput,
            dependencies: { ...defaultDependencies(), ...options.dependencies },
        };
        return await dispatch(parsed, context);
    } catch (error) {
        const usage = error instanceof CliUsageError;
        writeLine(
            errorOutput,
            usage
                ? `${safePublicError(error)}\n\n${helpText.trimEnd()}`
                : `error: ${safePublicError(error)}`,
        );
        return usage ? CLI_EXIT.usage : CLI_EXIT.failure;
    }
}
