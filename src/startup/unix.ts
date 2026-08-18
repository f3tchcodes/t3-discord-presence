import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { posix } from "node:path";

import { writeFileAtomic } from "../utils/atomic-file.js";

export const UNIX_STARTUP_OWNERSHIP_MARKER = "T3_DISCORD_PRESENCE_STARTUP_V1";

const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;

export interface UnixCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export type UnixCommandRunner = (
    executable: string,
    arguments_: ReadonlyArray<string>,
) => Promise<UnixCommandResult>;

export interface UnixStartupFileSystem {
    readonly ensureDirectory: (directory: string) => Promise<void>;
    readonly readTextFile: (filePath: string) => Promise<string | undefined>;
    readonly writeTextFile: (filePath: string, contents: string) => Promise<void>;
    readonly removeFile: (filePath: string) => Promise<void>;
}

export interface UnixStartupDependencies {
    readonly runCommand?: UnixCommandRunner;
    readonly fileSystem?: UnixStartupFileSystem;
}

export type OwnedStartupFileState = "current" | "outdated" | "foreign" | "missing";

export function requireAbsolutePosixPath(value: string, label: string): string {
    requireSingleLine(value, label);
    if (!posix.isAbsolute(value)) {
        throw new Error(`${label} must be an absolute path: ${value}`);
    }
    return posix.normalize(value);
}

export function requireSingleLine(value: string, label: string): void {
    if (value.includes("\0") || /[\r\n]/u.test(value)) {
        throw new Error(`${label} must be a single line`);
    }
}

export function isOwnedUnixStartupContent(contents: string): boolean {
    return contents.includes(UNIX_STARTUP_OWNERSHIP_MARKER);
}

function appendCommandOutput(current: string, chunk: Buffer | string): string {
    if (current.length >= COMMAND_OUTPUT_LIMIT) {
        return current;
    }
    const remaining = COMMAND_OUTPUT_LIMIT - current.length;
    return current + chunk.toString().slice(0, remaining);
}

/** Run an executable directly without invoking a command shell. */
export async function runUnixCommand(
    executable: string,
    arguments_: ReadonlyArray<string>,
    timeoutMs = 15_000,
): Promise<UnixCommandResult> {
    return await new Promise((resolve, reject) => {
        const child = spawn(executable, [...arguments_], {
            shell: false,
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
                reject(new Error(`startup command timed out after ${timeoutMs} ms`));
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

const defaultFileSystem: UnixStartupFileSystem = {
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

export function resolveUnixStartupDependencies(overrides: UnixStartupDependencies): {
    readonly runCommand: UnixCommandRunner;
    readonly fileSystem: UnixStartupFileSystem;
} {
    return {
        runCommand: overrides.runCommand ?? runUnixCommand,
        fileSystem: overrides.fileSystem ?? defaultFileSystem,
    };
}

export function getOwnedStartupFileState(
    contents: string | undefined,
    desiredContents: string,
): OwnedStartupFileState {
    if (contents === undefined) {
        return "missing";
    }
    if (!isOwnedUnixStartupContent(contents)) {
        return "foreign";
    }
    return contents === desiredContents ? "current" : "outdated";
}

export async function writeOwnedStartupFileIfChanged(
    fileSystem: UnixStartupFileSystem,
    filePath: string,
    desiredContents: string,
): Promise<boolean> {
    const currentContents = await fileSystem.readTextFile(filePath);
    if (currentContents === desiredContents) {
        return false;
    }
    if (currentContents !== undefined && !isOwnedUnixStartupContent(currentContents)) {
        throw new Error(`refusing to replace an unowned startup file: ${filePath}`);
    }
    await fileSystem.writeTextFile(filePath, desiredContents);
    return true;
}

export async function removeOwnedStartupFile(
    fileSystem: UnixStartupFileSystem,
    filePath: string,
): Promise<boolean> {
    const currentContents = await fileSystem.readTextFile(filePath);
    if (currentContents === undefined || !isOwnedUnixStartupContent(currentContents)) {
        return false;
    }
    await fileSystem.removeFile(filePath);
    return true;
}

export async function runRequiredStartupCommand(
    runCommand: UnixCommandRunner,
    executable: string,
    arguments_: ReadonlyArray<string>,
    action: string,
): Promise<UnixCommandResult> {
    let result: UnixCommandResult;
    try {
        result = await runCommand(executable, arguments_);
    } catch (error) {
        throw new Error(`unable to ${action}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    }
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
        throw new Error(`unable to ${action}: ${detail}`);
    }
    return result;
}
