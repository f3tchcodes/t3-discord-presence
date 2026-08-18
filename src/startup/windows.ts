import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { win32 } from "node:path";

import { writeFileAtomic } from "../utils/atomic-file.js";

export const WINDOWS_TASK_NAME = "t3-discord-presence";
export const WINDOWS_STARTUP_OWNERSHIP_MARKER = "T3_DISCORD_PRESENCE_STARTUP_V1";

const DEFAULT_DAEMON_ARGUMENTS = ["daemon"] as const;
const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;

export interface WindowsStartupPaths {
    readonly managedDirectory: string;
    readonly launcherPath: string;
    readonly taskXmlPath: string;
    readonly startupFolder: string;
    readonly fallbackLauncherPath: string;
    readonly schedulerExecutable: string;
    readonly scriptHostExecutable: string;
}

export interface ResolveWindowsStartupPathsOptions {
    /** A persistent directory owned by this application, normally its config directory. */
    readonly appDirectory: string;
    readonly roamingAppDataDirectory: string;
    readonly windowsDirectory: string;
    /** A known-folder lookup result. The AppData-derived path is only a fallback. */
    readonly startupFolder?: string;
}

export interface RenderWindowsLauncherOptions {
    readonly nodeExecutable: string;
    readonly cliEntrypoint: string;
    readonly daemonArguments?: ReadonlyArray<string>;
}

export interface RenderWindowsTaskXmlOptions {
    readonly launcherPath: string;
    readonly scriptHostExecutable: string;
    readonly workingDirectory: string;
    readonly fingerprint?: string;
    readonly taskName?: string;
    readonly userId?: string;
}

export interface WindowsStartupOptions {
    readonly cliEntrypoint: string;
    readonly paths: WindowsStartupPaths;
    readonly nodeExecutable?: string;
    readonly daemonArguments?: ReadonlyArray<string>;
    readonly taskName?: string;
    readonly userId?: string;
}

export interface WindowsCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export type WindowsCommandRunner = (
    executable: string,
    arguments_: ReadonlyArray<string>,
) => Promise<WindowsCommandResult>;

export interface WindowsStartupFileSystem {
    readonly ensureDirectory: (directory: string) => Promise<void>;
    readonly readTextFile: (filePath: string) => Promise<string | undefined>;
    readonly writeTextFile: (filePath: string, contents: string) => Promise<void>;
    readonly removeFile: (filePath: string) => Promise<void>;
}

export interface WindowsStartupDependencies {
    readonly runCommand?: WindowsCommandRunner;
    readonly fileSystem?: WindowsStartupFileSystem;
}

export type WindowsStartupMechanism = "task-scheduler" | "startup-folder";

export interface WindowsStartupInstallResult {
    readonly installed: true;
    readonly mechanism: WindowsStartupMechanism;
    readonly changed: boolean;
    readonly schedulerError?: string;
    readonly registrationConflict: boolean;
}

export type WindowsStartupRegistrationState =
    | "current"
    | "outdated"
    | "foreign"
    | "missing"
    | "unavailable";

export interface WindowsStartupStatus {
    readonly installed: boolean;
    readonly mechanism: WindowsStartupMechanism | "none";
    readonly current: boolean;
    readonly task: WindowsStartupRegistrationState;
    readonly fallback: "current" | "outdated" | "foreign" | "missing";
}

export interface WindowsStartupUninstallResult {
    readonly taskRemoved: boolean;
    readonly fallbackRemoved: boolean;
    readonly managedFilesRemoved: number;
    readonly registrationConflict: boolean;
    readonly schedulerError?: string;
}

interface PreparedWindowsStartup {
    readonly options: Required<Pick<WindowsStartupOptions, "cliEntrypoint" | "nodeExecutable" | "taskName">> & {
        readonly daemonArguments: ReadonlyArray<string>;
        readonly paths: WindowsStartupPaths;
        readonly userId?: string;
    };
    readonly launcher: string;
    readonly taskXml: string;
    readonly ownershipTag: string;
}

function requireAbsoluteWindowsPath(value: string, label: string): string {
    if (!win32.isAbsolute(value)) {
        throw new Error(`${label} must be an absolute Windows path: ${value}`);
    }
    if (value.includes("\0") || /[\r\n]/u.test(value)) {
        throw new Error(`${label} contains an invalid character`);
    }
    return win32.normalize(value);
}

function requireSingleLine(value: string, label: string): void {
    if (value.includes("\0") || /[\r\n]/u.test(value)) {
        throw new Error(`${label} must be a single line`);
    }
}

function requireTaskName(value: string): string {
    requireSingleLine(value, "task name");
    if (value.trim() === "" || value.includes("\\") || value.includes("/")) {
        throw new Error("task name must be a non-empty root task name");
    }
    return value;
}

export function resolveWindowsUserId(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
    const username = environment.USERNAME?.trim();
    if (username === undefined || username === "") {
        return undefined;
    }
    const domain = environment.USERDOMAIN?.trim();
    return domain === undefined || domain === "" ? username : `${domain}\\${username}`;
}

export function resolveWindowsStartupPaths(
    options: ResolveWindowsStartupPathsOptions,
): WindowsStartupPaths {
    const appDirectory = requireAbsoluteWindowsPath(options.appDirectory, "app directory");
    const roamingAppDataDirectory = requireAbsoluteWindowsPath(
        options.roamingAppDataDirectory,
        "roaming AppData directory",
    );
    const windowsDirectory = requireAbsoluteWindowsPath(
        options.windowsDirectory,
        "Windows directory",
    );
    const managedDirectory = win32.join(appDirectory, "startup");
    const startupFolder = options.startupFolder === undefined
        ? win32.join(
            roamingAppDataDirectory,
            "Microsoft",
            "Windows",
            "Start Menu",
            "Programs",
            "Startup",
        )
        : requireAbsoluteWindowsPath(options.startupFolder, "Startup folder");

    return {
        managedDirectory,
        launcherPath: win32.join(managedDirectory, "launch-daemon.vbs"),
        taskXmlPath: win32.join(managedDirectory, "task.xml"),
        startupFolder,
        fallbackLauncherPath: win32.join(startupFolder, `${WINDOWS_TASK_NAME}.vbs`),
        schedulerExecutable: win32.join(windowsDirectory, "System32", "schtasks.exe"),
        scriptHostExecutable: win32.join(windowsDirectory, "System32", "wscript.exe"),
    };
}

/**
 * Quote one argument using the CommandLineToArgvW/Visual C++ parsing rules.
 * Arguments are always quoted so cmd metacharacters never acquire shell meaning.
 */
export function quoteWindowsCommandLineArgument(argument: string): string {
    requireSingleLine(argument, "Windows command-line argument");
    let result = "\"";
    let backslashes = 0;

    for (const character of argument) {
        if (character === "\\") {
            backslashes += 1;
            continue;
        }
        if (character === "\"") {
            result += "\\".repeat(backslashes * 2 + 1);
            result += "\"";
            backslashes = 0;
            continue;
        }
        result += "\\".repeat(backslashes);
        result += character;
        backslashes = 0;
    }

    result += "\\".repeat(backslashes * 2);
    return `${result}\"`;
}

export function renderWindowsCommandLine(
    executable: string,
    arguments_: ReadonlyArray<string>,
): string {
    return [executable, ...arguments_]
        .map(quoteWindowsCommandLineArgument)
        .join(" ");
}

function vbScriptStringLiteral(value: string): string {
    requireSingleLine(value, "VBScript string");
    return `\"${value.replaceAll("\"", "\"\"")}\"`;
}

export function renderWindowsLauncherVbs(options: RenderWindowsLauncherOptions): string {
    const daemonArguments = options.daemonArguments ?? DEFAULT_DAEMON_ARGUMENTS;
    const commandLine = renderWindowsCommandLine(
        options.nodeExecutable,
        [options.cliEntrypoint, ...daemonArguments],
    );

    return [
        `' ${WINDOWS_STARTUP_OWNERSHIP_MARKER}`,
        "Option Explicit",
        "",
        "Dim shell",
        'Set shell = CreateObject("WScript.Shell")',
        `WScript.Quit shell.Run(${vbScriptStringLiteral(commandLine)}, 0, True)`,
        "",
    ].join("\r\n");
}

function escapeXml(value: string): string {
    requireSingleLine(value, "XML value");
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&apos;");
}

export function createWindowsStartupFingerprint(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function renderWindowsTaskSchedulerXml(
    options: RenderWindowsTaskXmlOptions,
): string {
    const taskName = requireTaskName(options.taskName ?? WINDOWS_TASK_NAME);
    const fingerprint = options.fingerprint
        ?? createWindowsStartupFingerprint(JSON.stringify({
            launcherPath: options.launcherPath,
            scriptHostExecutable: options.scriptHostExecutable,
            workingDirectory: options.workingDirectory,
            userId: options.userId ?? null,
        }));
    if (!/^[a-f\d]{64}$/u.test(fingerprint)) {
        throw new Error("Windows startup fingerprint must be a SHA-256 digest");
    }
    const ownershipTag = `${WINDOWS_STARTUP_OWNERSHIP_MARKER}:${fingerprint}`;
    const scriptArguments = renderWindowsCommandLine("//B", ["//NoLogo", options.launcherPath]);
    const userIdElements = options.userId === undefined
        ? []
        : [`      <UserId>${escapeXml(options.userId)}</UserId>`];

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        "  <RegistrationInfo>",
        `    <Description>${escapeXml(`Managed by t3-discord-presence (${ownershipTag})`)}</Description>`,
        `    <URI>\\${escapeXml(taskName)}</URI>`,
        "  </RegistrationInfo>",
        "  <Triggers>",
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        ...userIdElements,
        "    </LogonTrigger>",
        "  </Triggers>",
        "  <Principals>",
        '    <Principal id="Author">',
        ...userIdElements,
        "      <LogonType>InteractiveToken</LogonType>",
        "      <RunLevel>LeastPrivilege</RunLevel>",
        "    </Principal>",
        "  </Principals>",
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <AllowHardTerminate>true</AllowHardTerminate>",
        "    <StartWhenAvailable>true</StartWhenAvailable>",
        "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
        "    <AllowStartOnDemand>true</AllowStartOnDemand>",
        "    <Enabled>true</Enabled>",
        "    <Hidden>true</Hidden>",
        "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
        "    <WakeToRun>false</WakeToRun>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "    <Priority>7</Priority>",
        "    <RestartOnFailure>",
        "      <Interval>PT1M</Interval>",
        "      <Count>999</Count>",
        "    </RestartOnFailure>",
        "  </Settings>",
        '  <Actions Context="Author">',
        "    <Exec>",
        `      <Command>${escapeXml(options.scriptHostExecutable)}</Command>`,
        `      <Arguments>${escapeXml(scriptArguments)}</Arguments>`,
        `      <WorkingDirectory>${escapeXml(options.workingDirectory)}</WorkingDirectory>`,
        "    </Exec>",
        "  </Actions>",
        "</Task>",
        "",
    ].join("\r\n");
}

export function isOwnedWindowsStartupContent(contents: string): boolean {
    return contents.includes(WINDOWS_STARTUP_OWNERSHIP_MARKER);
}

function appendCommandOutput(current: string, chunk: Buffer | string): string {
    if (current.length >= COMMAND_OUTPUT_LIMIT) {
        return current;
    }
    const remaining = COMMAND_OUTPUT_LIMIT - current.length;
    return current + chunk.toString().slice(0, remaining);
}

/** Run an executable directly. No command shell or npm shim is involved. */
export async function runWindowsCommand(
    executable: string,
    arguments_: ReadonlyArray<string>,
    timeoutMs = 15_000,
): Promise<WindowsCommandResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn(executable, [...arguments_], {
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer | string) => {
            stdout = appendCommandOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
            stderr = appendCommandOutput(stderr, chunk);
        });
        child.once("error", error => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", exitCode => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`Windows startup command timed out after ${timeoutMs} ms`));
                return;
            }
            resolve({
                exitCode: exitCode ?? -1,
                stdout,
                stderr,
            });
        });
    });
}

export async function resolveWindowsStartupFolder(
    windowsDirectory: string,
    runCommand: WindowsCommandRunner = runWindowsCommand,
): Promise<string> {
    const root = requireAbsoluteWindowsPath(windowsDirectory, "Windows directory");
    const powershell = win32.join(
        root,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
    const result = await runCommand(powershell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)",
    ]);
    if (result.exitCode !== 0) {
        throw new Error(
            `could not resolve the per-user Startup folder: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
    }
    const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1) {
        throw new Error("could not resolve the per-user Startup folder");
    }
    return requireAbsoluteWindowsPath(lines[0] ?? "", "Startup folder");
}

const defaultFileSystem: WindowsStartupFileSystem = {
    async ensureDirectory(directory) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
    },
    async readTextFile(filePath) {
        try {
            return await readFile(filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    },
    async writeTextFile(filePath, contents) {
        await writeFileAtomic(filePath, contents, { mode: 0o600 });
    },
    async removeFile(filePath) {
        await rm(filePath, { force: true });
    },
};

function dependencies(overrides: WindowsStartupDependencies): {
    readonly runCommand: WindowsCommandRunner;
    readonly fileSystem: WindowsStartupFileSystem;
} {
    return {
        runCommand: overrides.runCommand ?? runWindowsCommand,
        fileSystem: overrides.fileSystem ?? defaultFileSystem,
    };
}

function prepareWindowsStartup(options: WindowsStartupOptions): PreparedWindowsStartup {
    const nodeExecutable = requireAbsoluteWindowsPath(
        options.nodeExecutable ?? process.execPath,
        "Node executable",
    );
    const cliEntrypoint = requireAbsoluteWindowsPath(options.cliEntrypoint, "CLI entrypoint");
    const taskName = requireTaskName(options.taskName ?? WINDOWS_TASK_NAME);
    const userId = options.userId ?? resolveWindowsUserId();
    if (userId !== undefined) {
        requireSingleLine(userId, "Windows user ID");
        if (userId.trim() === "") {
            throw new Error("Windows user ID must not be empty");
        }
    }
    const paths: WindowsStartupPaths = {
        managedDirectory: requireAbsoluteWindowsPath(
            options.paths.managedDirectory,
            "managed startup directory",
        ),
        launcherPath: requireAbsoluteWindowsPath(options.paths.launcherPath, "launcher path"),
        taskXmlPath: requireAbsoluteWindowsPath(options.paths.taskXmlPath, "task XML path"),
        startupFolder: requireAbsoluteWindowsPath(options.paths.startupFolder, "Startup folder"),
        fallbackLauncherPath: requireAbsoluteWindowsPath(
            options.paths.fallbackLauncherPath,
            "fallback launcher path",
        ),
        schedulerExecutable: requireAbsoluteWindowsPath(
            options.paths.schedulerExecutable,
            "Task Scheduler executable",
        ),
        scriptHostExecutable: requireAbsoluteWindowsPath(
            options.paths.scriptHostExecutable,
            "Windows Script Host executable",
        ),
    };
    const daemonArguments = options.daemonArguments ?? DEFAULT_DAEMON_ARGUMENTS;
    for (const argument of daemonArguments) {
        requireSingleLine(argument, "daemon argument");
    }
    const launcher = renderWindowsLauncherVbs({
        nodeExecutable,
        cliEntrypoint,
        daemonArguments,
    });
    const fingerprint = createWindowsStartupFingerprint(JSON.stringify({
        version: 1,
        nodeExecutable,
        cliEntrypoint,
        daemonArguments,
        launcherPath: paths.launcherPath,
        taskXmlPath: paths.taskXmlPath,
        scriptHostExecutable: paths.scriptHostExecutable,
        workingDirectory: paths.managedDirectory,
        taskName,
        userId: userId ?? null,
    }));
    const taskXml = renderWindowsTaskSchedulerXml({
        launcherPath: paths.launcherPath,
        scriptHostExecutable: paths.scriptHostExecutable,
        workingDirectory: paths.managedDirectory,
        fingerprint,
        taskName,
        ...(userId === undefined ? {} : { userId }),
    });

    return {
        options: {
            cliEntrypoint,
            nodeExecutable,
            daemonArguments,
            paths,
            taskName,
            ...(userId === undefined ? {} : { userId }),
        },
        launcher,
        taskXml,
        ownershipTag: `${WINDOWS_STARTUP_OWNERSHIP_MARKER}:${fingerprint}`,
    };
}

async function writeOwnedFileIfChanged(
    fileSystem: WindowsStartupFileSystem,
    filePath: string,
    desiredContents: string,
): Promise<boolean> {
    const currentContents = await fileSystem.readTextFile(filePath);
    if (currentContents === desiredContents) {
        return false;
    }
    if (currentContents !== undefined && !isOwnedWindowsStartupContent(currentContents)) {
        throw new Error(`refusing to replace an unowned Windows startup file: ${filePath}`);
    }
    await fileSystem.writeTextFile(filePath, desiredContents);
    return true;
}

async function removeOwnedFile(
    fileSystem: WindowsStartupFileSystem,
    filePath: string,
): Promise<boolean> {
    const currentContents = await fileSystem.readTextFile(filePath);
    if (currentContents === undefined || !isOwnedWindowsStartupContent(currentContents)) {
        return false;
    }
    await fileSystem.removeFile(filePath);
    return true;
}

async function queryTask(
    prepared: PreparedWindowsStartup,
    runCommand: WindowsCommandRunner,
): Promise<WindowsCommandResult> {
    return await runCommand(prepared.options.paths.schedulerExecutable, [
        "/Query",
        "/TN",
        prepared.options.taskName,
        "/XML",
        "ONE",
    ]);
}

function schedulerFailure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function installStartupFolderFallback(
    prepared: PreparedWindowsStartup,
    fileSystem: WindowsStartupFileSystem,
    schedulerError: string,
    changedBeforeFallback: boolean,
    registrationConflict: boolean,
): Promise<WindowsStartupInstallResult> {
    await fileSystem.ensureDirectory(prepared.options.paths.startupFolder);
    const fallbackChanged = await writeOwnedFileIfChanged(
        fileSystem,
        prepared.options.paths.fallbackLauncherPath,
        prepared.launcher,
    );
    return {
        installed: true,
        mechanism: "startup-folder",
        changed: changedBeforeFallback || fallbackChanged,
        schedulerError,
        registrationConflict,
    };
}

export async function installWindowsStartup(
    options: WindowsStartupOptions,
    dependencyOverrides: WindowsStartupDependencies = {},
): Promise<WindowsStartupInstallResult> {
    const prepared = prepareWindowsStartup(options);
    const { fileSystem, runCommand } = dependencies(dependencyOverrides);
    await fileSystem.ensureDirectory(prepared.options.paths.managedDirectory);
    const launcherChanged = await writeOwnedFileIfChanged(
        fileSystem,
        prepared.options.paths.launcherPath,
        prepared.launcher,
    );
    const xmlChanged = await writeOwnedFileIfChanged(
        fileSystem,
        prepared.options.paths.taskXmlPath,
        prepared.taskXml,
    );
    let changed = launcherChanged || xmlChanged;

    let query: WindowsCommandResult | undefined;
    let queryError: string | undefined;
    try {
        query = await queryTask(prepared, runCommand);
    } catch (error) {
        queryError = schedulerFailure(error);
    }

    if (query?.exitCode === 0 && !isOwnedWindowsStartupContent(query.stdout)) {
        return await installStartupFolderFallback(
            prepared,
            fileSystem,
            "a same-named Task Scheduler registration is not owned by this application",
            changed,
            true,
        );
    }

    const currentTask = query?.exitCode === 0 && query.stdout.includes(prepared.ownershipTag);
    if (!currentTask) {
        let create: WindowsCommandResult | undefined;
        let createError: string | undefined;
        try {
            create = await runCommand(prepared.options.paths.schedulerExecutable, [
                "/Create",
                "/TN",
                prepared.options.taskName,
                "/XML",
                prepared.options.paths.taskXmlPath,
                "/F",
            ]);
        } catch (error) {
            createError = schedulerFailure(error);
        }
        if (create?.exitCode !== 0) {
            const reason = createError
                ?? create?.stderr.trim()
                ?? queryError
                ?? "Task Scheduler registration failed";
            return await installStartupFolderFallback(
                prepared,
                fileSystem,
                reason === "" ? "Task Scheduler registration failed" : reason,
                changed,
                false,
            );
        }
        changed = true;
    }

    const fallbackRemoved = await removeOwnedFile(
        fileSystem,
        prepared.options.paths.fallbackLauncherPath,
    );
    changed ||= fallbackRemoved;
    return {
        installed: true,
        mechanism: "task-scheduler",
        changed,
        registrationConflict: false,
    };
}

function fallbackState(contents: string | undefined, prepared: PreparedWindowsStartup): WindowsStartupStatus["fallback"] {
    if (contents === undefined) {
        return "missing";
    }
    if (!isOwnedWindowsStartupContent(contents)) {
        return "foreign";
    }
    return contents === prepared.launcher ? "current" : "outdated";
}

export async function getWindowsStartupStatus(
    options: WindowsStartupOptions,
    dependencyOverrides: WindowsStartupDependencies = {},
): Promise<WindowsStartupStatus> {
    const prepared = prepareWindowsStartup(options);
    const { fileSystem, runCommand } = dependencies(dependencyOverrides);
    const fallback = fallbackState(
        await fileSystem.readTextFile(prepared.options.paths.fallbackLauncherPath),
        prepared,
    );
    let task: WindowsStartupRegistrationState;
    try {
        const query = await queryTask(prepared, runCommand);
        if (query.exitCode !== 0) {
            task = "missing";
        } else if (!isOwnedWindowsStartupContent(query.stdout)) {
            task = "foreign";
        } else {
            task = query.stdout.includes(prepared.ownershipTag) ? "current" : "outdated";
        }
    } catch {
        task = "unavailable";
    }

    const taskInstalled = task === "current" || task === "outdated";
    const fallbackInstalled = fallback === "current" || fallback === "outdated";
    return {
        installed: taskInstalled || fallbackInstalled,
        mechanism: taskInstalled
            ? "task-scheduler"
            : fallbackInstalled
                ? "startup-folder"
                : "none",
        current: task === "current" || (!taskInstalled && fallback === "current"),
        task,
        fallback,
    };
}

export async function uninstallWindowsStartup(
    options: WindowsStartupOptions,
    dependencyOverrides: WindowsStartupDependencies = {},
): Promise<WindowsStartupUninstallResult> {
    const prepared = prepareWindowsStartup(options);
    const { fileSystem, runCommand } = dependencies(dependencyOverrides);
    let query: WindowsCommandResult | undefined;
    let queryError: string | undefined;
    try {
        query = await queryTask(prepared, runCommand);
    } catch (error) {
        queryError = schedulerFailure(error);
    }

    const taskOwned = query?.exitCode === 0 && isOwnedWindowsStartupContent(query.stdout);
    const registrationConflict = query?.exitCode === 0 && !taskOwned;
    let taskRemoved = false;
    if (taskOwned) {
        const deletion = await runCommand(prepared.options.paths.schedulerExecutable, [
            "/Delete",
            "/TN",
            prepared.options.taskName,
            "/F",
        ]);
        if (deletion.exitCode !== 0) {
            throw new Error(
                `unable to remove the Windows startup task: ${deletion.stderr.trim() || `exit ${deletion.exitCode}`}`,
            );
        }
        taskRemoved = true;
    }

    const fallbackRemoved = await removeOwnedFile(
        fileSystem,
        prepared.options.paths.fallbackLauncherPath,
    );
    const managedFilesRemoved = Number(await removeOwnedFile(
        fileSystem,
        prepared.options.paths.launcherPath,
    )) + Number(await removeOwnedFile(
        fileSystem,
        prepared.options.paths.taskXmlPath,
    ));

    return {
        taskRemoved,
        fallbackRemoved,
        managedFilesRemoved,
        registrationConflict,
        ...(queryError === undefined ? {} : { schedulerError: queryError }),
    };
}
