import { spawn } from "node:child_process";
import { readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const BUNDLED_CLI_PARTS = [
    "app.asar.unpacked",
    "apps",
    "server",
    "dist",
    "bin.mjs",
] as const;
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024;
const VERSION_PATTERN = /^(?:t3\s+)?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i;

export interface T3CliCommand {
    readonly executable: string;
    readonly argumentsPrefix: ReadonlyArray<string>;
}

export interface T3CliProcessResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface T3CliProcessOptions {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
}

export interface T3CliProcessAdapter {
    run(
        executable: string,
        arguments_: ReadonlyArray<string>,
        options: T3CliProcessOptions,
    ): Promise<T3CliProcessResult>;
}

export interface T3CliFileSystemAdapter {
    isFile(path: string): Promise<boolean>;
    readLink(path: string): Promise<string | undefined>;
}

export interface ResolveT3CliOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly homeDir?: string;
    readonly nodeExecutable?: string;
    readonly currentExecutable?: string;
    readonly currentResourcesPath?: string;
    readonly runtimePid?: number;
    readonly resourceDirectories?: ReadonlyArray<string>;
    readonly fileSystem?: T3CliFileSystemAdapter;
    readonly process?: T3CliProcessAdapter;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

export const nodeT3CliFileSystemAdapter: T3CliFileSystemAdapter = {
    async isFile(path) {
        try {
            return (await stat(path)).isFile();
        } catch {
            return false;
        }
    },
    async readLink(path) {
        try {
            return await readlink(path);
        } catch {
            return undefined;
        }
    },
};

export const nodeT3CliProcessAdapter: T3CliProcessAdapter = {
    async run(executable, arguments_, options) {
        return new Promise<T3CliProcessResult>((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            let outputBytes = 0;
            let settled = false;
            const child = spawn(executable, [...arguments_], {
                env: options.env,
                shell: false,
                signal: options.signal,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(error);
            };
            const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
                outputBytes += chunk.byteLength;
                if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
                    fail(new Error("T3 CLI probe output exceeded its limit"));
                    return;
                }
                if (stream === "stdout") stdout += chunk.toString("utf8");
                else stderr += chunk.toString("utf8");
            };
            child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
            child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
            child.once("error", fail);
            child.once("close", code => {
                if (settled) return;
                settled = true;
                resolve({ exitCode: code ?? 1, stdout, stderr });
            });
        });
    },
};

function processResourcesPath(): string | undefined {
    const value = (process as NodeJS.Process & { readonly resourcesPath?: unknown }).resourcesPath;
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function environmentValue(
    environment: NodeJS.ProcessEnv,
    name: string,
    platform: NodeJS.Platform,
): string | undefined {
    const exact = environment[name];
    if (exact !== undefined || platform !== "win32") return exact;
    const matched = Object.entries(environment)
        .find(([key]) => key.toLowerCase() === name.toLowerCase());
    return matched?.[1];
}

function validVersionOutput(result: T3CliProcessResult): boolean {
    if (result.exitCode !== 0) return false;
    return `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .some(line => VERSION_PATTERN.test(line.trim()));
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function probeCommand(
    command: T3CliCommand,
    processAdapter: T3CliProcessAdapter,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
): Promise<boolean> {
    try {
        return validVersionOutput(await processAdapter.run(
            command.executable,
            [...command.argumentsPrefix, "--version"],
            { env: environment, signal },
        ));
    } catch {
        return false;
    }
}

function resourceDirectoryForExecutable(
    executable: string,
    platform: NodeJS.Platform,
): string | undefined {
    const pathApi = platform === "win32" ? win32 : posix;
    if (!pathApi.isAbsolute(executable)) return undefined;
    if (platform === "darwin") {
        const contentsDirectory = posix.dirname(posix.dirname(executable));
        return posix.join(contentsDirectory, "Resources");
    }
    return pathApi.join(pathApi.dirname(executable), "resources");
}

function stableResourceDirectories(
    platform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    homeDirectory: string,
): ReadonlyArray<string> {
    if (platform === "win32") {
        const localAppData = environmentValue(environment, "LOCALAPPDATA", platform)
            ?? win32.join(homeDirectory, "AppData", "Local");
        const programFiles = environmentValue(environment, "ProgramFiles", platform);
        const programFilesX86 = environmentValue(environment, "ProgramFiles(x86)", platform);
        return [
            win32.join(localAppData, "Programs", "t3code", "resources"),
            win32.join(localAppData, "Programs", "T3 Code", "resources"),
            ...(programFiles === undefined
                ? []
                : [win32.join(programFiles, "t3code", "resources")]),
            ...(programFilesX86 === undefined
                ? []
                : [win32.join(programFilesX86, "t3code", "resources")]),
        ];
    }
    if (platform === "darwin") {
        return [
            "/Applications/T3 Code.app/Contents/Resources",
            "/Applications/T3 Code (Alpha).app/Contents/Resources",
            posix.join(homeDirectory, "Applications", "T3 Code.app", "Contents", "Resources"),
            posix.join(
                homeDirectory,
                "Applications",
                "T3 Code (Alpha).app",
                "Contents",
                "Resources",
            ),
        ];
    }
    return [
        "/opt/t3code/resources",
        "/opt/T3 Code/resources",
        "/usr/lib/t3code/resources",
        "/usr/local/lib/t3code/resources",
        "/usr/share/t3code/resources",
    ];
}

function uniqueAbsoluteDirectories(
    directories: ReadonlyArray<string | undefined>,
    platform: NodeJS.Platform,
): ReadonlyArray<string> {
    const pathApi = platform === "win32" ? win32 : posix;
    const seen = new Set<string>();
    const result: Array<string> = [];
    for (const directory of directories) {
        if (directory === undefined || !pathApi.isAbsolute(directory)) continue;
        const normalized = pathApi.normalize(directory);
        const identity = platform === "win32" ? normalized.toLowerCase() : normalized;
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(normalized);
    }
    return result;
}

async function runtimeExecutablePath(
    pid: number | undefined,
    platform: NodeJS.Platform,
    fileSystem: T3CliFileSystemAdapter,
    processAdapter: T3CliProcessAdapter,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
): Promise<string | undefined> {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (platform === "linux") {
        return fileSystem.readLink(`/proc/${String(pid)}/exe`);
    }
    const executable = platform === "win32" ? "powershell.exe" : "/bin/ps";
    const arguments_ = platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${String(pid)} -ErrorAction Stop).Path`,
        ]
        : ["-p", String(pid), "-o", "comm="];
    try {
        const result = await processAdapter.run(executable, arguments_, {
            env: environment,
            signal,
        });
        if (result.exitCode !== 0) return undefined;
        const pathApi = platform === "win32" ? win32 : posix;
        const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        return lines.length === 1 && pathApi.isAbsolute(lines[0] ?? "")
            ? lines[0]
            : undefined;
    } catch {
        return undefined;
    }
}

export async function resolveT3CliCommand(
    options: ResolveT3CliOptions = {},
): Promise<T3CliCommand | undefined> {
    const platform = options.platform ?? process.platform;
    const environment = options.env ?? process.env;
    const processAdapter = options.process ?? nodeT3CliProcessAdapter;
    const fileSystem = options.fileSystem ?? nodeT3CliFileSystemAdapter;
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const pathCommand = { executable: "t3", argumentsPrefix: [] } satisfies T3CliCommand;
    if (await probeCommand(
        pathCommand,
        processAdapter,
        environment,
        combineSignal(options.signal, timeoutMs),
    )) return pathCommand;

    const runtimeExecutable = await runtimeExecutablePath(
        options.runtimePid,
        platform,
        fileSystem,
        processAdapter,
        environment,
        combineSignal(options.signal, timeoutMs),
    );
    const resourceDirectories = uniqueAbsoluteDirectories([
        ...(options.resourceDirectories ?? []),
        options.currentResourcesPath ?? processResourcesPath(),
        resourceDirectoryForExecutable(
            options.currentExecutable ?? process.execPath,
            platform,
        ),
        resourceDirectoryForExecutable(runtimeExecutable ?? "", platform),
        ...stableResourceDirectories(platform, environment, options.homeDir ?? homedir()),
    ], platform);
    const pathApi = platform === "win32" ? win32 : posix;
    const nodeExecutable = options.nodeExecutable ?? process.execPath;
    for (const resourceDirectory of resourceDirectories) {
        const bundledCli = pathApi.join(resourceDirectory, ...BUNDLED_CLI_PARTS);
        if (!await fileSystem.isFile(bundledCli)) continue;
        const command = {
            executable: nodeExecutable,
            argumentsPrefix: [bundledCli],
        } satisfies T3CliCommand;
        if (await probeCommand(
            command,
            processAdapter,
            environment,
            combineSignal(options.signal, timeoutMs),
        )) return command;
    }
    return undefined;
}
