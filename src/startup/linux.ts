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
    type UnixCommandRunner,
    type UnixStartupDependencies,
    writeOwnedStartupFileIfChanged,
} from "./unix.js";

export const LINUX_SYSTEMD_UNIT_NAME = "t3-discord-presence.service";
export const LINUX_AUTOSTART_FILE_NAME = "t3-discord-presence.desktop";

const DEFAULT_DAEMON_ARGUMENTS = ["daemon"] as const;

export interface LinuxStartupPaths {
    readonly systemdUserDirectory: string;
    readonly unitPath: string;
    readonly autostartDirectory: string;
    readonly desktopPath: string;
    readonly systemctlExecutable: string;
}

export interface ResolveLinuxStartupPathsOptions {
    readonly homeDirectory: string;
    readonly configHome?: string;
    readonly systemctlExecutable?: string;
}

export interface RenderLinuxStartupOptions {
    readonly nodeExecutable: string;
    readonly cliEntrypoint: string;
    readonly daemonArguments?: ReadonlyArray<string>;
}

export interface LinuxStartupOptions {
    readonly nodeExecutable?: string;
    readonly cliEntrypoint: string;
    readonly daemonArguments?: ReadonlyArray<string>;
    readonly paths: LinuxStartupPaths;
}

export type LinuxStartupMechanism = "systemd" | "xdg-autostart";

export interface LinuxStartupInstallResult {
    readonly installed: true;
    readonly mechanism: LinuxStartupMechanism;
    readonly changed: boolean;
    readonly registrationConflict: boolean;
}

export interface LinuxStartupStatus {
    readonly installed: boolean;
    readonly mechanism: LinuxStartupMechanism | "none";
    readonly current: boolean;
    readonly systemdAvailable: boolean;
    readonly unit: OwnedStartupFileState;
    readonly desktop: OwnedStartupFileState;
    readonly enabled: boolean | undefined;
    readonly active: boolean | undefined;
}

export interface LinuxStartupUninstallResult {
    readonly unitRemoved: boolean;
    readonly desktopRemoved: boolean;
    readonly serviceDisabled: boolean;
    readonly registrationConflict: boolean;
}

interface PreparedLinuxStartup {
    readonly paths: LinuxStartupPaths;
    readonly unit: string;
    readonly desktop: string;
}

function requireExecutable(value: string, label: string): string {
    requireSingleLine(value, label);
    if (value.trim() === "" || (!posix.isAbsolute(value) && value.includes("/"))) {
        throw new Error(`${label} must be an executable name or absolute path: ${value}`);
    }
    return value;
}

export function resolveLinuxStartupPaths(
    options: ResolveLinuxStartupPathsOptions,
): LinuxStartupPaths {
    const homeDirectory = requireAbsolutePosixPath(options.homeDirectory, "home directory");
    const configHome = options.configHome === undefined
        ? posix.join(homeDirectory, ".config")
        : requireAbsolutePosixPath(options.configHome, "XDG config home");
    const systemdUserDirectory = posix.join(configHome, "systemd", "user");
    const autostartDirectory = posix.join(configHome, "autostart");
    return {
        systemdUserDirectory,
        unitPath: posix.join(systemdUserDirectory, LINUX_SYSTEMD_UNIT_NAME),
        autostartDirectory,
        desktopPath: posix.join(autostartDirectory, LINUX_AUTOSTART_FILE_NAME),
        systemctlExecutable: requireExecutable(
            options.systemctlExecutable ?? "systemctl",
            "systemctl executable",
        ),
    };
}

/** Quote one systemd ExecStart argument without invoking a shell. */
export function quoteSystemdExecArgument(argument: string): string {
    requireSingleLine(argument, "systemd argument");
    let quoted = "\"";
    for (const character of argument) {
        if (character === "\\") {
            quoted += "\\\\";
        } else if (character === "\"") {
            quoted += "\\\"";
        } else if (character === "%") {
            quoted += "%%";
        } else if (character === "$") {
            quoted += "$$";
        } else if (character === "\t") {
            quoted += "\\t";
        } else if (character.codePointAt(0)! < 0x20) {
            quoted += `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`;
        } else {
            quoted += character;
        }
    }
    return `${quoted}\"`;
}

export function renderLinuxSystemdUnit(options: RenderLinuxStartupOptions): string {
    const nodeExecutable = requireAbsolutePosixPath(options.nodeExecutable, "Node executable");
    const cliEntrypoint = requireAbsolutePosixPath(options.cliEntrypoint, "CLI entrypoint");
    const arguments_ = [nodeExecutable, cliEntrypoint, ...(options.daemonArguments ?? DEFAULT_DAEMON_ARGUMENTS)];
    const commandLine = arguments_.map(quoteSystemdExecArgument).join(" ");

    return [
        `# ${UNIX_STARTUP_OWNERSHIP_MARKER}`,
        "[Unit]",
        "Description=T3 Discord Presence",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${commandLine}`,
        "Restart=on-failure",
        "RestartSec=5s",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

/** Quote one freedesktop Desktop Entry Exec argument, including both escaping layers. */
export function quoteDesktopExecArgument(argument: string): string {
    requireSingleLine(argument, "desktop Exec argument");
    let quoted = "\"";
    for (const character of argument) {
        if (character === "\\") {
            quoted += "\\\\\\\\";
        } else if (character === "\"") {
            quoted += "\\\\\"";
        } else if (character === "$") {
            quoted += "\\\\$";
        } else if (character === "`") {
            quoted += "\\\\`";
        } else if (character === "%") {
            quoted += "%%";
        } else if (character === "\t") {
            quoted += "\\t";
        } else if (character.codePointAt(0)! < 0x20) {
            throw new Error("desktop Exec argument contains an unsupported control character");
        } else {
            quoted += character;
        }
    }
    return `${quoted}\"`;
}

export function renderLinuxAutostartDesktop(options: RenderLinuxStartupOptions): string {
    const nodeExecutable = requireAbsolutePosixPath(options.nodeExecutable, "Node executable");
    const cliEntrypoint = requireAbsolutePosixPath(options.cliEntrypoint, "CLI entrypoint");
    const arguments_ = [nodeExecutable, cliEntrypoint, ...(options.daemonArguments ?? DEFAULT_DAEMON_ARGUMENTS)];
    const commandLine = arguments_.map(quoteDesktopExecArgument).join(" ");

    return [
        `# ${UNIX_STARTUP_OWNERSHIP_MARKER}`,
        "[Desktop Entry]",
        "Version=1.0",
        "Type=Application",
        "Name=T3 Discord Presence",
        "Comment=Start T3 Discord Presence in the background",
        `Exec=${commandLine}`,
        "Terminal=false",
        "NoDisplay=true",
        "X-GNOME-Autostart-enabled=true",
        "",
    ].join("\n");
}

function prepareLinuxStartup(options: LinuxStartupOptions): PreparedLinuxStartup {
    const paths: LinuxStartupPaths = {
        systemdUserDirectory: requireAbsolutePosixPath(
            options.paths.systemdUserDirectory,
            "systemd user directory",
        ),
        unitPath: requireAbsolutePosixPath(options.paths.unitPath, "systemd unit path"),
        autostartDirectory: requireAbsolutePosixPath(
            options.paths.autostartDirectory,
            "XDG autostart directory",
        ),
        desktopPath: requireAbsolutePosixPath(options.paths.desktopPath, "XDG desktop path"),
        systemctlExecutable: requireExecutable(
            options.paths.systemctlExecutable,
            "systemctl executable",
        ),
    };
    const renderOptions: RenderLinuxStartupOptions = {
        nodeExecutable: options.nodeExecutable ?? process.execPath,
        cliEntrypoint: options.cliEntrypoint,
        ...(options.daemonArguments === undefined
            ? {}
            : { daemonArguments: options.daemonArguments }),
    };
    return {
        paths,
        unit: renderLinuxSystemdUnit(renderOptions),
        desktop: renderLinuxAutostartDesktop(renderOptions),
    };
}

export async function systemdUserIsAvailable(
    runCommand: UnixCommandRunner,
    executable = "systemctl",
): Promise<boolean> {
    try {
        const result = await runCommand(executable, ["--user", "show-environment"]);
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

async function systemdBooleanQuery(
    executable: string,
    runCommand: UnixCommandRunner,
    operation: "is-active" | "is-enabled",
): Promise<boolean> {
    try {
        const result = await runCommand(executable, [
            "--user",
            operation,
            "--quiet",
            LINUX_SYSTEMD_UNIT_NAME,
        ]);
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

async function installXdgFallback(
    prepared: PreparedLinuxStartup,
    dependencies: ReturnType<typeof resolveUnixStartupDependencies>,
): Promise<LinuxStartupInstallResult> {
    const { fileSystem } = dependencies;
    await fileSystem.ensureDirectory(prepared.paths.autostartDirectory);
    const desktopChanged = await writeOwnedStartupFileIfChanged(
        fileSystem,
        prepared.paths.desktopPath,
        prepared.desktop,
    );
    const unitContents = await fileSystem.readTextFile(prepared.paths.unitPath);
    const registrationConflict = unitContents !== undefined
        && !unitContents.includes(UNIX_STARTUP_OWNERSHIP_MARKER);
    const unitRemoved = await removeOwnedStartupFile(fileSystem, prepared.paths.unitPath);
    return {
        installed: true,
        mechanism: "xdg-autostart",
        changed: desktopChanged || unitRemoved,
        registrationConflict,
    };
}

export async function installLinuxStartup(
    options: LinuxStartupOptions,
    dependencyOverrides: UnixStartupDependencies = {},
): Promise<LinuxStartupInstallResult> {
    const prepared = prepareLinuxStartup(options);
    const dependencies = resolveUnixStartupDependencies(dependencyOverrides);
    const { fileSystem, runCommand } = dependencies;
    const systemdAvailable = await systemdUserIsAvailable(
        runCommand,
        prepared.paths.systemctlExecutable,
    );
    if (!systemdAvailable) {
        return await installXdgFallback(prepared, dependencies);
    }

    const wasEnabled = await systemdBooleanQuery(
        prepared.paths.systemctlExecutable,
        runCommand,
        "is-enabled",
    );
    const wasActive = await systemdBooleanQuery(
        prepared.paths.systemctlExecutable,
        runCommand,
        "is-active",
    );
    await fileSystem.ensureDirectory(prepared.paths.systemdUserDirectory);
    const unitChanged = await writeOwnedStartupFileIfChanged(
        fileSystem,
        prepared.paths.unitPath,
        prepared.unit,
    );
    if (unitChanged) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.systemctlExecutable,
            ["--user", "daemon-reload"],
            "reload the systemd user manager",
        );
    }
    await runRequiredStartupCommand(
        runCommand,
        prepared.paths.systemctlExecutable,
        ["--user", "enable", "--now", LINUX_SYSTEMD_UNIT_NAME],
        "enable the systemd user service",
    );
    if (unitChanged && wasActive) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.systemctlExecutable,
            ["--user", "restart", LINUX_SYSTEMD_UNIT_NAME],
            "restart the updated systemd user service",
        );
    }

    const desktopContents = await fileSystem.readTextFile(prepared.paths.desktopPath);
    const registrationConflict = desktopContents !== undefined
        && !desktopContents.includes(UNIX_STARTUP_OWNERSHIP_MARKER);
    const desktopRemoved = await removeOwnedStartupFile(fileSystem, prepared.paths.desktopPath);
    return {
        installed: true,
        mechanism: "systemd",
        changed: unitChanged || desktopRemoved || !wasEnabled || !wasActive,
        registrationConflict,
    };
}

export async function getLinuxStartupStatus(
    options: LinuxStartupOptions,
    dependencyOverrides: UnixStartupDependencies = {},
): Promise<LinuxStartupStatus> {
    const prepared = prepareLinuxStartup(options);
    const { fileSystem, runCommand } = resolveUnixStartupDependencies(dependencyOverrides);
    const [unitContents, desktopContents] = await Promise.all([
        fileSystem.readTextFile(prepared.paths.unitPath),
        fileSystem.readTextFile(prepared.paths.desktopPath),
    ]);
    const unit = getOwnedStartupFileState(unitContents, prepared.unit);
    const desktop = getOwnedStartupFileState(desktopContents, prepared.desktop);
    const systemdAvailable = await systemdUserIsAvailable(
        runCommand,
        prepared.paths.systemctlExecutable,
    );
    const enabled = systemdAvailable
        ? await systemdBooleanQuery(
            prepared.paths.systemctlExecutable,
            runCommand,
            "is-enabled",
        )
        : undefined;
    const active = systemdAvailable
        ? await systemdBooleanQuery(
            prepared.paths.systemctlExecutable,
            runCommand,
            "is-active",
        )
        : undefined;
    const unitInstalled = unit === "current" || unit === "outdated";
    const desktopInstalled = desktop === "current" || desktop === "outdated";
    const mechanism: LinuxStartupStatus["mechanism"] = unitInstalled
        ? "systemd"
        : desktopInstalled
            ? "xdg-autostart"
            : "none";
    return {
        installed: unitInstalled || desktopInstalled,
        mechanism,
        current: mechanism === "systemd"
            ? unit === "current" && enabled === true
            : mechanism === "xdg-autostart" && desktop === "current",
        systemdAvailable,
        unit,
        desktop,
        enabled,
        active,
    };
}

export async function uninstallLinuxStartup(
    options: LinuxStartupOptions,
    dependencyOverrides: UnixStartupDependencies = {},
): Promise<LinuxStartupUninstallResult> {
    const prepared = prepareLinuxStartup(options);
    const { fileSystem, runCommand } = resolveUnixStartupDependencies(dependencyOverrides);
    const [unitContents, desktopContents] = await Promise.all([
        fileSystem.readTextFile(prepared.paths.unitPath),
        fileSystem.readTextFile(prepared.paths.desktopPath),
    ]);
    const unitOwned = unitContents !== undefined
        && unitContents.includes(UNIX_STARTUP_OWNERSHIP_MARKER);
    const desktopOwned = desktopContents !== undefined
        && desktopContents.includes(UNIX_STARTUP_OWNERSHIP_MARKER);
    let serviceDisabled = false;
    if (unitOwned && await systemdUserIsAvailable(runCommand, prepared.paths.systemctlExecutable)) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.systemctlExecutable,
            ["--user", "disable", "--now", LINUX_SYSTEMD_UNIT_NAME],
            "disable the systemd user service",
        );
        serviceDisabled = true;
    }
    const unitRemoved = unitOwned
        ? await removeOwnedStartupFile(fileSystem, prepared.paths.unitPath)
        : false;
    if (unitRemoved && serviceDisabled) {
        await runRequiredStartupCommand(
            runCommand,
            prepared.paths.systemctlExecutable,
            ["--user", "daemon-reload"],
            "reload the systemd user manager",
        );
    }
    const desktopRemoved = desktopOwned
        ? await removeOwnedStartupFile(fileSystem, prepared.paths.desktopPath)
        : false;
    return {
        unitRemoved,
        desktopRemoved,
        serviceDisabled,
        registrationConflict: (unitContents !== undefined && !unitOwned)
            || (desktopContents !== undefined && !desktopOwned),
    };
}
