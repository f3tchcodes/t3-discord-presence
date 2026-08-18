import { readFile, rm } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { CredentialStore } from "../config/credentials.js";
import { APP_DIRECTORY_NAME, type AppPaths } from "../config/paths.js";

export interface PurgeFileSystem {
    readonly readTextFile: (filePath: string) => Promise<string | undefined>;
    readonly remove: (
        target: string,
        options: { readonly force: true; readonly recursive: boolean },
    ) => Promise<void>;
}

export interface PurgeAppDataOptions {
    readonly paths: AppPaths;
    readonly credentials: CredentialStore;
    readonly platform?: NodeJS.Platform;
    readonly environmentIds?: ReadonlyArray<string>;
    readonly fileSystem?: PurgeFileSystem;
}

export interface PurgeAppDataResult {
    readonly credentialsRemoved: number;
    readonly directoriesRemoved: number;
}

const nodePurgeFileSystem: PurgeFileSystem = {
    async readTextFile(filePath) {
        try {
            return await readFile(filePath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
    },
    async remove(target, options) {
        await rm(target, options);
    },
};

function validEnvironmentId(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value === value.trim()
        && value.length <= 512;
}

export function environmentIdsFromCredentialFile(contents: string | undefined): ReadonlyArray<string> {
    if (contents === undefined) return [];
    let value: unknown;
    try {
        value = JSON.parse(contents) as unknown;
    } catch {
        return [];
    }
    if (typeof value !== "object" || value === null || !("environments" in value)) return [];
    const { environments } = value;
    if (typeof environments !== "object" || environments === null || Array.isArray(environments)) {
        return [];
    }
    return Object.keys(environments).filter(validEnvironmentId);
}

function pathSegments(path: string, separator: string): ReadonlyArray<string> {
    return path.split(separator).filter(Boolean);
}

export function assertAppOwnedPaths(
    paths: AppPaths,
    platform: NodeJS.Platform = process.platform,
): void {
    const pathApi = platform === "win32" ? win32 : posix;
    const directories = [
        paths.configDirectory,
        paths.stateDirectory,
        paths.runtimeDirectory,
        paths.logDirectory,
    ];
    for (const directory of directories) {
        const normalized = pathApi.normalize(directory);
        const identity = platform === "win32" ? normalized.toLowerCase() : normalized;
        const appName = platform === "win32"
            ? APP_DIRECTORY_NAME.toLowerCase()
            : APP_DIRECTORY_NAME;
        if (
            !pathApi.isAbsolute(normalized)
            || normalized === pathApi.parse(normalized).root
            || !pathSegments(identity, pathApi.sep).includes(appName)
        ) {
            throw new Error("refusing to purge paths outside t3-discord-presence storage");
        }
    }

    const ownedFiles: ReadonlyArray<readonly [string, string]> = [
        [paths.configFile, paths.configDirectory],
        [paths.stateFile, paths.stateDirectory],
        [paths.credentialsFile, paths.stateDirectory],
        [paths.lockFile, paths.runtimeDirectory],
        [paths.stopFile, paths.runtimeDirectory],
        [paths.statusFile, paths.runtimeDirectory],
        [paths.logFile, paths.logDirectory],
    ];
    for (const [file, directory] of ownedFiles) {
        if (pathApi.dirname(pathApi.normalize(file)) !== pathApi.normalize(directory)) {
            throw new Error("refusing to purge an unexpected application file path");
        }
    }
}

export async function removeTransientDaemonData(
    paths: AppPaths,
    options: {
        readonly platform?: NodeJS.Platform;
        readonly fileSystem?: PurgeFileSystem;
    } = {},
): Promise<void> {
    assertAppOwnedPaths(paths, options.platform);
    const fileSystem = options.fileSystem ?? nodePurgeFileSystem;
    await Promise.all([
        fileSystem.remove(paths.stateFile, { force: true, recursive: false }),
        fileSystem.remove(paths.runtimeDirectory, { force: true, recursive: true }),
    ]);
}

export async function purgeAppData(options: PurgeAppDataOptions): Promise<PurgeAppDataResult> {
    assertAppOwnedPaths(options.paths, options.platform);
    const fileSystem = options.fileSystem ?? nodePurgeFileSystem;
    const credentialFile = await fileSystem.readTextFile(options.paths.credentialsFile);
    const environmentIds = new Set([
        ...environmentIdsFromCredentialFile(credentialFile),
        ...(options.environmentIds ?? []).filter(validEnvironmentId),
    ]);
    for (const environmentId of [...environmentIds].sort()) {
        await options.credentials.delete(environmentId);
    }
    const directories = new Set([
        options.paths.runtimeDirectory,
        options.paths.logDirectory,
        options.paths.stateDirectory,
        options.paths.configDirectory,
    ]);
    for (const directory of directories) {
        await fileSystem.remove(directory, { force: true, recursive: true });
    }
    return {
        credentialsRemoved: environmentIds.size,
        directoriesRemoved: directories.size,
    };
}
