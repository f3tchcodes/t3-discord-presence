import { posix } from "node:path";

import {
    getOwnedStartupFileState,
    type OwnedStartupFileState,
    removeOwnedStartupFile,
    requireAbsolutePosixPath,
    requireSingleLine,
    resolveUnixStartupDependencies,
    runRequiredStartupCommand,
    UNIX_STARTUP_OWNERSHIP_MARKER,
    type UnixStartupDependencies,
    writeOwnedStartupFileIfChanged,
} from "./unix.js";

export const MACOS_LAUNCH_AGENT_LABEL = "com.f3tchcodes.t3-discord-presence";

const DEFAULT_DAEMON_ARGUMENTS = ["daemon"] as const;

export interface MacosStartupPaths {
    readonly launchAgentsDirectory: string;
    readonly plistPath: string;
    readonly logDirectory: string;
    readonly standardOutPath: string;
    readonly standardErrorPath: string;
    readonly launchctlExecutable: string;
}

export interface ResolveMacosStartupPathsOptions {
    readonly homeDirectory: string;
    readonly logDirectory: string;
    readonly launchctlExecutable?: string;
}

export interface RenderMacosLaunchAgentOptions {
    readonly nodeExecutable: string;
    readonly cliEntrypoint: string;
    readonly daemonArguments?: ReadonlyArray<string>;
    readonly standardOutPath: string;
    readonly standardErrorPath: string;
}

export interface MacosStartupOptions {
    readonly nodeExecutable?: string;
    readonly cliEntrypoint: string;
    readonly daemonArguments?: ReadonlyArray<string>;
    readonly paths: MacosStartupPaths;
    readonly uid?: number;
}

export interface MacosStartupInstallResult {
    readonly installed: true;
    readonly changed: boolean;
    readonly loaded: true;
}

export interface MacosStartupStatus {
    readonly installed: boolean;
    readonly current: boolean;
    readonly file: OwnedStartupFileState;
    readonly registration: "loaded" | "unloaded" | "unavailable";
}

export interface MacosStartupUninstallResult {
    readonly removed: boolean;
    readonly unloaded: boolean;
    readonly registrationConflict: boolean;
}

interface PreparedMacosStartup {
    readonly paths: MacosStartupPaths;
    readonly plist: string;
    readonly domain: string;
    readonly serviceTarget: string;
}

export function resolveMacosStartupPaths(
    options: ResolveMacosStartupPathsOptions,
): MacosStartupPaths {
    const homeDirectory = requireAbsolutePosixPath(options.homeDirectory, "home directory");
    const logDirectory = requireAbsolutePosixPath(options.logDirectory, "log directory");
    const launchAgentsDirectory = posix.join(homeDirectory, "Library", "LaunchAgents");
    return {
        launchAgentsDirectory,
        plistPath: posix.join(launchAgentsDirectory, `${MACOS_LAUNCH_AGENT_LABEL}.plist`),
        logDirectory,
        standardOutPath: posix.join(logDirectory, "launchd.stdout.log"),
        standardErrorPath: posix.join(logDirectory, "launchd.stderr.log"),
        launchctlExecutable: requireAbsolutePosixPath(
            options.launchctlExecutable ?? "/bin/launchctl",
            "launchctl executable",
        ),
    };
}

function escapeXmlText(value: string): string {
    requireSingleLine(value, "launchd value");
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&apos;");
}

export function renderMacosLaunchAgentPlist(
    options: RenderMacosLaunchAgentOptions,
): string {
    const nodeExecutable = requireAbsolutePosixPath(options.nodeExecutable, "Node executable");
    const cliEntrypoint = requireAbsolutePosixPath(options.cliEntrypoint, "CLI entrypoint");
    const standardOutPath = requireAbsolutePosixPath(
        options.standardOutPath,
        "launchd standard output path",
    );
    const standardErrorPath = requireAbsolutePosixPath(
        options.standardErrorPath,
        "launchd standard error path",
    );
    const arguments_ = [nodeExecutable, cliEntrypoint, ...(options.daemonArguments ?? DEFAULT_DAEMON_ARGUMENTS)];
    for (const argument of arguments_) {
        requireSingleLine(argument, "launchd argument");
    }

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        `<!-- ${UNIX_STARTUP_OWNERSHIP_MARKER} -->`,
        '<plist version="1.0">',
        "<dict>",
        "    <key>Label</key>",
        `    <string>${MACOS_LAUNCH_AGENT_LABEL}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        ...arguments_.map(argument => `        <string>${escapeXmlText(argument)}</string>`),
        "    </array>",
        "    <key>RunAtLoad</key>",
        "    <true/>",
        "    <key>KeepAlive</key>",
        "    <dict>",
        "        <key>SuccessfulExit</key>",
        "        <false/>",
        "    </dict>",
        "    <key>ProcessType</key>",
        "    <string>Background</string>",
        "    <key>ThrottleInterval</key>",
        "    <integer>10</integer>",
        "    <key>StandardOutPath</key>",
        `    <string>${escapeXmlText(standardOutPath)}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${escapeXmlText(standardErrorPath)}</string>`,
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
}

function requireUid(uid: number | undefined): number {
    const resolvedUid = uid ?? process.getuid?.();
    if (resolvedUid === undefined || !Number.isSafeInteger(resolvedUid) || resolvedUid < 0) {
        throw new Error("a valid macOS user id is required");
    }
    return resolvedUid;
}

function prepareMacosStartup(options: MacosStartupOptions): PreparedMacosStartup {
    const uid = requireUid(options.uid);
    const paths: MacosStartupPaths = {
        launchAgentsDirectory: requireAbsolutePosixPath(
            options.paths.launchAgentsDirectory,
            "LaunchAgents directory",
        ),
        plistPath: requireAbsolutePosixPath(options.paths.plistPath, "LaunchAgent plist path"),
        logDirectory: requireAbsolutePosixPath(options.paths.logDirectory, "log directory"),
        standardOutPath: requireAbsolutePosixPath(
            options.paths.standardOutPath,
            "launchd standard output path",
        ),
        standardErrorPath: requireAbsolutePosixPath(
            options.paths.standardErrorPath,
            "launchd standard error path",
        ),
        launchctlExecutable: requireAbsolutePosixPath(
            options.paths.launchctlExecutable,
            "launchctl executable",
        ),
    };
    const plist = renderMacosLaunchAgentPlist({
        nodeExecutable: options.nodeExecutable ?? process.execPath,
        cliEntrypoint: options.cliEntrypoint,
        standardOutPath: paths.standardOutPath,
        standardErrorPath: paths.standardErrorPath,
        ...(options.daemonArguments === undefined
            ? {}
            : { daemonArguments: options.daemonArguments }),
    });
    const domain = `gui/${uid}`;
    return {
        paths,
        plist,
        domain,
        serviceTarget: `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`,
    };
}

async function launchAgentIsLoaded(
    prepared: PreparedMacosStartup,
    runCommand: NonNullable<UnixStartupDependencies["runCommand"]>,
): Promise<boolean> {
    const result = await runCommand(prepared.paths.launchctlExecutable, [
        "print",
        prepared.serviceTarget,
    ]);
    return result.exitCode === 0;
}

export async function installMacosStartup(
    options: MacosStartupOptions,
    dependencyOverrides: UnixStartupDependencies = {},
): Promise<MacosStartupInstallResult> {
    const prepared = prepareMacosStartup(options);
    const { fileSystem, runCommand } = resolveUnixStartupDependencies(dependencyOverrides);
    await Promise.all([
        fileSystem.ensureDirectory(prepared.paths.launchAgentsDirectory),
        fileSystem.ensureDirectory(prepared.paths.logDirectory),
    ]);
    const fileChanged = await writeOwnedStartupFileIfChanged(
        fileSystem,
        prepared.paths.plistPath,
        prepared.plist,
    );

    let wasLoaded = false;
    try {
        wasLoaded = await launchAgentIsLoaded(prepared, runCommand);
    } catch {
        // bootstrap below reports a direct, actionable launchctl error
    }

    if (wasLoaded && fileChanged) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.launchctlExecutable,
            ["bootout", prepared.serviceTarget],
            "unload the previous macOS LaunchAgent",
        );
    }
    if (!wasLoaded || fileChanged) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.launchctlExecutable,
            ["bootstrap", prepared.domain, prepared.paths.plistPath],
            "load the macOS LaunchAgent",
        );
    }
    await runRequiredStartupCommand(
        runCommand,
        prepared.paths.launchctlExecutable,
        ["enable", prepared.serviceTarget],
        "enable the macOS LaunchAgent",
    );
    await runRequiredStartupCommand(
        runCommand,
        prepared.paths.launchctlExecutable,
        ["kickstart", "-k", prepared.serviceTarget],
        "start the macOS LaunchAgent",
    );

    return {
        installed: true,
        changed: fileChanged || !wasLoaded,
        loaded: true,
    };
}

export async function getMacosStartupStatus(
    options: MacosStartupOptions,
    dependencyOverrides: UnixStartupDependencies = {},
): Promise<MacosStartupStatus> {
    const prepared = prepareMacosStartup(options);
    const { fileSystem, runCommand } = resolveUnixStartupDependencies(dependencyOverrides);
    const file = getOwnedStartupFileState(
        await fileSystem.readTextFile(prepared.paths.plistPath),
        prepared.plist,
    );
    let registration: MacosStartupStatus["registration"];
    try {
        registration = await launchAgentIsLoaded(prepared, runCommand) ? "loaded" : "unloaded";
    } catch {
        registration = "unavailable";
    }
    const installed = file === "current" || file === "outdated";
    return {
        installed,
        current: file === "current" && registration === "loaded",
        file,
        registration,
    };
}

export async function uninstallMacosStartup(
    options: MacosStartupOptions,
    dependencyOverrides: UnixStartupDependencies = {},
): Promise<MacosStartupUninstallResult> {
    const prepared = prepareMacosStartup(options);
    const { fileSystem, runCommand } = resolveUnixStartupDependencies(dependencyOverrides);
    const contents = await fileSystem.readTextFile(prepared.paths.plistPath);
    const file = getOwnedStartupFileState(contents, prepared.plist);
    if (file === "foreign") {
        return {
            removed: false,
            unloaded: false,
            registrationConflict: true,
        };
    }
    if (file === "missing") {
        return {
            removed: false,
            unloaded: false,
            registrationConflict: false,
        };
    }

    let loaded: boolean;
    try {
        loaded = await launchAgentIsLoaded(prepared, runCommand);
    } catch (error) {
        throw new Error("unable to inspect the macOS LaunchAgent before uninstalling", {
            cause: error,
        });
    }
    if (loaded) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.launchctlExecutable,
            ["bootout", prepared.serviceTarget],
            "unload the macOS LaunchAgent",
        );
    }
    const removed = await removeOwnedStartupFile(fileSystem, prepared.paths.plistPath);
    return {
        removed,
        unloaded: loaded,
        registrationConflict: false,
    };
}
