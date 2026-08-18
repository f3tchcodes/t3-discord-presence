import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import type { AppPaths } from "../config/paths.js";
import {
    getLinuxStartupStatus,
    installLinuxStartup,
    type LinuxStartupInstallResult,
    type LinuxStartupOptions,
    type LinuxStartupStatus,
    type LinuxStartupUninstallResult,
    resolveLinuxStartupPaths,
    uninstallLinuxStartup,
} from "./linux.js";
import {
    getMacosStartupStatus,
    installMacosStartup,
    type MacosStartupInstallResult,
    type MacosStartupOptions,
    type MacosStartupStatus,
    type MacosStartupUninstallResult,
    resolveMacosStartupPaths,
    uninstallMacosStartup,
} from "./macos.js";
import type { UnixStartupDependencies } from "./unix.js";
import {
    getWindowsStartupStatus,
    installWindowsStartup,
    resolveWindowsStartupFolder,
    resolveWindowsStartupPaths,
    resolveWindowsUserId,
    uninstallWindowsStartup,
    type WindowsStartupDependencies,
    type WindowsStartupInstallResult,
    type WindowsStartupOptions,
    type WindowsStartupStatus,
    type WindowsStartupUninstallResult,
} from "./windows.js";

export interface StartupOptions {
    readonly cliEntrypoint: string;
    readonly paths: AppPaths;
    readonly nodeExecutable?: string;
    readonly platform?: NodeJS.Platform;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
    readonly uid?: number;
}

export interface StartupDependencies {
    readonly windows?: WindowsStartupDependencies;
    readonly unix?: UnixStartupDependencies;
}

export type StartupInstallResult =
    | ({ readonly platform: "win32" } & WindowsStartupInstallResult)
    | ({ readonly platform: "darwin" } & MacosStartupInstallResult)
    | ({ readonly platform: "linux" } & LinuxStartupInstallResult);

export type StartupStatus =
    | ({ readonly platform: "win32" } & WindowsStartupStatus)
    | ({ readonly platform: "darwin" } & MacosStartupStatus)
    | ({ readonly platform: "linux" } & LinuxStartupStatus);

export type StartupUninstallResult =
    | ({ readonly platform: "win32" } & WindowsStartupUninstallResult)
    | ({ readonly platform: "darwin" } & MacosStartupUninstallResult)
    | ({ readonly platform: "linux" } & LinuxStartupUninstallResult);

function environmentValue(
    environment: Readonly<Record<string, string | undefined>>,
    ...names: ReadonlyArray<string>
): string | undefined {
    for (const name of names) {
        const value = environment[name]?.trim();
        if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
}

async function windowsOptions(
    options: StartupOptions,
    dependencies: WindowsStartupDependencies = {},
): Promise<WindowsStartupOptions> {
    const environment = options.environment ?? process.env;
    const windowsDirectory = environmentValue(environment, "SystemRoot", "WINDIR");
    if (windowsDirectory === undefined) {
        throw new Error("the Windows directory could not be resolved");
    }
    const roamingAppDataDirectory = environmentValue(environment, "APPDATA")
        ?? win32.dirname(options.paths.configDirectory);
    let startupFolder: string | undefined;
    try {
        startupFolder = await resolveWindowsStartupFolder(
            windowsDirectory,
            dependencies.runCommand,
        );
    } catch {
        startupFolder = undefined;
    }
    const userId = resolveWindowsUserId(environment);
    return {
        cliEntrypoint: options.cliEntrypoint,
        ...(options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable }),
        paths: resolveWindowsStartupPaths({
            appDirectory: win32.dirname(options.paths.stateDirectory),
            roamingAppDataDirectory,
            windowsDirectory,
            ...(startupFolder === undefined ? {} : { startupFolder }),
        }),
        ...(userId === undefined ? {} : { userId }),
    };
}

function macosOptions(options: StartupOptions): MacosStartupOptions {
    const environment = options.environment ?? process.env;
    return {
        cliEntrypoint: options.cliEntrypoint,
        ...(options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable }),
        paths: resolveMacosStartupPaths({
            homeDirectory: options.homeDirectory
                ?? environmentValue(environment, "HOME")
                ?? homedir(),
            logDirectory: options.paths.logDirectory,
        }),
        ...(options.uid === undefined ? {} : { uid: options.uid }),
    };
}

function linuxOptions(options: StartupOptions): LinuxStartupOptions {
    const environment = options.environment ?? process.env;
    return {
        cliEntrypoint: options.cliEntrypoint,
        ...(options.nodeExecutable === undefined ? {} : { nodeExecutable: options.nodeExecutable }),
        paths: resolveLinuxStartupPaths({
            homeDirectory: options.homeDirectory
                ?? environmentValue(environment, "HOME")
                ?? homedir(),
            configHome: posix.dirname(options.paths.configDirectory),
        }),
    };
}

function platformOf(options: StartupOptions): NodeJS.Platform {
    return options.platform ?? process.platform;
}

export async function installStartup(
    options: StartupOptions,
    dependencies: StartupDependencies = {},
): Promise<StartupInstallResult> {
    const platform = platformOf(options);
    if (platform === "win32") {
        return {
            platform,
            ...await installWindowsStartup(
                await windowsOptions(options, dependencies.windows),
                dependencies.windows,
            ),
        };
    }
    if (platform === "darwin") {
        return {
            platform,
            ...await installMacosStartup(macosOptions(options), dependencies.unix),
        };
    }
    if (platform === "linux") {
        return {
            platform,
            ...await installLinuxStartup(linuxOptions(options), dependencies.unix),
        };
    }
    throw new Error(`startup is not supported on ${platform}`);
}

export async function getStartupStatus(
    options: StartupOptions,
    dependencies: StartupDependencies = {},
): Promise<StartupStatus> {
    const platform = platformOf(options);
    if (platform === "win32") {
        return {
            platform,
            ...await getWindowsStartupStatus(
                await windowsOptions(options, dependencies.windows),
                dependencies.windows,
            ),
        };
    }
    if (platform === "darwin") {
        return {
            platform,
            ...await getMacosStartupStatus(macosOptions(options), dependencies.unix),
        };
    }
    if (platform === "linux") {
        return {
            platform,
            ...await getLinuxStartupStatus(linuxOptions(options), dependencies.unix),
        };
    }
    throw new Error(`startup is not supported on ${platform}`);
}

export async function uninstallStartup(
    options: StartupOptions,
    dependencies: StartupDependencies = {},
): Promise<StartupUninstallResult> {
    const platform = platformOf(options);
    if (platform === "win32") {
        return {
            platform,
            ...await uninstallWindowsStartup(
                await windowsOptions(options, dependencies.windows),
                dependencies.windows,
            ),
        };
    }
    if (platform === "darwin") {
        return {
            platform,
            ...await uninstallMacosStartup(macosOptions(options), dependencies.unix),
        };
    }
    if (platform === "linux") {
        return {
            platform,
            ...await uninstallLinuxStartup(linuxOptions(options), dependencies.unix),
        };
    }
    throw new Error(`startup is not supported on ${platform}`);
}
