import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const APP_DIRECTORY_NAME = "t3-discord-presence";

export interface AppPaths {
    readonly configDirectory: string;
    readonly configFile: string;
    readonly stateDirectory: string;
    readonly stateFile: string;
    readonly credentialsFile: string;
    readonly runtimeDirectory: string;
    readonly lockFile: string;
    readonly statusFile: string;
    readonly logDirectory: string;
    readonly logFile: string;
}

export interface ResolveAppPathsOptions {
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDirectory?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
}

function resolveHomeDirectory(
    platform: NodeJS.Platform,
    env: Readonly<Record<string, string | undefined>>,
    suppliedHome: string | undefined,
): string {
    const path = platform === "win32" ? win32 : posix;
    const home = nonEmpty(suppliedHome)
        ?? nonEmpty(platform === "win32" ? env.USERPROFILE : env.HOME)
        ?? homedir();

    if (!path.isAbsolute(home)) {
        throw new Error(`home directory must be absolute: ${home}`);
    }
    return path.normalize(home);
}

function absoluteEnvironmentPath(
    value: string | undefined,
    isAbsolute: (path: string) => boolean,
): string | undefined {
    const candidate = nonEmpty(value);
    return candidate !== undefined && isAbsolute(candidate) ? candidate : undefined;
}

function buildPaths(
    configDirectory: string,
    stateDirectory: string,
    runtimeDirectory: string,
    logDirectory: string,
    join: (...paths: Array<string>) => string,
): AppPaths {
    return {
        configDirectory,
        configFile: join(configDirectory, "config.json"),
        stateDirectory,
        stateFile: join(stateDirectory, "state.json"),
        credentialsFile: join(stateDirectory, "credentials.json"),
        runtimeDirectory,
        lockFile: join(runtimeDirectory, "daemon.lock"),
        statusFile: join(runtimeDirectory, "status.json"),
        logDirectory,
        logFile: join(logDirectory, "daemon.log"),
    };
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const path = platform === "win32" ? win32 : posix;
    const home = resolveHomeDirectory(platform, env, options.homeDirectory);

    if (platform === "win32") {
        const roamingRoot = absoluteEnvironmentPath(env.APPDATA, path.isAbsolute)
            ?? path.join(home, "AppData", "Roaming");
        const localRoot = absoluteEnvironmentPath(env.LOCALAPPDATA, path.isAbsolute)
            ?? path.join(home, "AppData", "Local");
        const localAppDirectory = path.join(localRoot, APP_DIRECTORY_NAME);

        return buildPaths(
            path.join(roamingRoot, APP_DIRECTORY_NAME),
            path.join(localAppDirectory, "state"),
            path.join(localAppDirectory, "runtime"),
            path.join(localAppDirectory, "logs"),
            path.join,
        );
    }

    if (platform === "darwin") {
        const applicationSupport = path.join(home, "Library", "Application Support", APP_DIRECTORY_NAME);
        return buildPaths(
            path.join(applicationSupport, "config"),
            path.join(applicationSupport, "state"),
            path.join(applicationSupport, "runtime"),
            path.join(home, "Library", "Logs", APP_DIRECTORY_NAME),
            path.join,
        );
    }

    if (platform === "linux") {
        const configRoot = absoluteEnvironmentPath(env.XDG_CONFIG_HOME, path.isAbsolute)
            ?? path.join(home, ".config");
        const stateRoot = absoluteEnvironmentPath(env.XDG_STATE_HOME, path.isAbsolute)
            ?? path.join(home, ".local", "state");
        const stateDirectory = path.join(stateRoot, APP_DIRECTORY_NAME);
        const runtimeRoot = absoluteEnvironmentPath(env.XDG_RUNTIME_DIR, path.isAbsolute);

        return buildPaths(
            path.join(configRoot, APP_DIRECTORY_NAME),
            stateDirectory,
            runtimeRoot === undefined
                ? path.join(stateDirectory, "runtime")
                : path.join(runtimeRoot, APP_DIRECTORY_NAME),
            path.join(stateDirectory, "logs"),
            path.join,
        );
    }

    throw new Error(`unsupported platform: ${platform}`);
}

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
    const directories = new Set([
        paths.configDirectory,
        paths.stateDirectory,
        paths.runtimeDirectory,
        paths.logDirectory,
    ]);
    await Promise.all([...directories].map(async directory => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
    }));
}
