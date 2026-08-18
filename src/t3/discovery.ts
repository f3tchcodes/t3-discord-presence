import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import type {
    DiscoveredT3Server,
    T3EnvironmentCapabilities,
    T3EnvironmentDescriptor,
    T3PlatformArch,
    T3PlatformOs,
    T3RuntimeState,
} from "./types.js";

const environmentPath = "/.well-known/t3/environment";
const platformOs = new Set<T3PlatformOs>(["darwin", "linux", "windows", "unknown"]);
const platformArch = new Set<T3PlatformArch>(["arm64", "x64", "other"]);
const selfUpdateMethods = new Set(["boot-service", "respawn", "desktop-managed"]);

export interface DiscoveryOptions {
    readonly baseDirs?: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly fetch?: typeof globalThis.fetch;
    readonly homeDir?: string;
    readonly isPidAlive?: (pid: number) => boolean;
    readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
    const value = record[key];
    return value === undefined ? undefined : typeof value === "string" ? value : null;
}

export function parseRuntimeState(value: unknown): T3RuntimeState | undefined {
    if (!isRecord(value)) return undefined;
    const host = optionalString(value, "host");
    const devUrl = optionalString(value, "devUrl");
    if (host === null || devUrl === null) return undefined;
    if (
        value.version !== 1
        || !Number.isInteger(value.pid)
        || typeof value.pid !== "number"
        || value.pid <= 0
        || !Number.isInteger(value.port)
        || typeof value.port !== "number"
        || value.port < 1
        || value.port > 65_535
        || typeof value.origin !== "string"
        || typeof value.startedAt !== "string"
    ) {
        return undefined;
    }
    return {
        version: 1,
        pid: value.pid,
        ...(host === undefined ? {} : { host }),
        port: value.port,
        origin: value.origin,
        ...(devUrl === undefined ? {} : { devUrl }),
        startedAt: value.startedAt,
    };
}

function parseCapabilities(value: unknown): T3EnvironmentCapabilities | undefined {
    if (!isRecord(value) || typeof value.repositoryIdentity !== "boolean") return undefined;
    const optionalBooleans = [
        "connectionProbe",
        "pullRequests",
        "threadSettlement",
        "threadSnooze",
        "threadPinning",
        "threadPinReorder",
        "threadTitleRegeneration",
        "serverSelfUpdateProgress",
        "agentActivityPublishing",
    ] as const;
    for (const key of optionalBooleans) {
        if (value[key] !== undefined && typeof value[key] !== "boolean") return undefined;
    }
    if (
        value.serverSelfUpdate !== undefined
        && (typeof value.serverSelfUpdate !== "string"
            || !selfUpdateMethods.has(value.serverSelfUpdate))
    ) {
        return undefined;
    }
    return value as unknown as T3EnvironmentCapabilities;
}

export function parseEnvironmentDescriptor(value: unknown): T3EnvironmentDescriptor | undefined {
    if (!isRecord(value) || !isRecord(value.platform)) return undefined;
    if (
        typeof value.environmentId !== "string"
        || value.environmentId.trim().length === 0
        || typeof value.label !== "string"
        || value.label.trim().length === 0
        || typeof value.serverVersion !== "string"
        || value.serverVersion.trim().length === 0
        || typeof value.platform.os !== "string"
        || !platformOs.has(value.platform.os as T3PlatformOs)
        || typeof value.platform.arch !== "string"
        || !platformArch.has(value.platform.arch as T3PlatformArch)
    ) {
        return undefined;
    }
    const capabilities = parseCapabilities(value.capabilities);
    if (capabilities === undefined) return undefined;
    return {
        environmentId: value.environmentId,
        label: value.label,
        platform: {
            os: value.platform.os as T3PlatformOs,
            arch: value.platform.arch as T3PlatformArch,
        },
        serverVersion: value.serverVersion,
        capabilities,
    };
}

export function isRuntimeOriginValid(runtime: T3RuntimeState): boolean {
    try {
        const url = new URL(runtime.origin);
        if (
            (url.protocol !== "http:" && url.protocol !== "https:")
            || url.username.length > 0
            || url.password.length > 0
            || url.pathname !== "/"
            || url.search.length > 0
            || url.hash.length > 0
            || runtime.origin !== url.origin
        ) {
            return false;
        }
        const port = url.port.length > 0
            ? Number.parseInt(url.port, 10)
            : url.protocol === "https:"
                ? 443
                : 80;
        return port === runtime.port;
    } catch {
        return false;
    }
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}

function expandBaseDir(input: string, homeDir: string, cwd: string): string {
    const trimmed = input.trim();
    if (trimmed === "~") return homeDir;
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
        return resolve(homeDir, trimmed.slice(2));
    }
    return isAbsolute(trimmed) ? normalize(trimmed) : resolve(cwd, trimmed);
}

async function findLinkedWorktreeRoot(cwd: string): Promise<string | undefined> {
    let directory = resolve(cwd);
    for (;;) {
        const gitPath = join(directory, ".git");
        try {
            const info = await stat(gitPath);
            if (info.isDirectory()) return undefined;
            if (!info.isFile()) return undefined;
            const contents = await readFile(gitPath, "utf8");
            const gitDir = contents
                .split(/\r?\n/)
                .map(line => line.trim())
                .find(line => line.startsWith("gitdir:"))
                ?.slice("gitdir:".length)
                .trim();
            if (gitDir === undefined) return undefined;
            const segments = normalize(gitDir.replaceAll("\\", "/"))
                .split(/[/\\]/)
                .filter(Boolean);
            return segments.length >= 3 && segments.at(-2) === "worktrees"
                ? directory
                : undefined;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                return undefined;
            }
        }
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}

export async function resolveT3BaseDirs(options: DiscoveryOptions = {}): Promise<ReadonlyArray<string>> {
    const home = options.homeDir ?? homedir();
    const cwd = options.cwd ?? process.cwd();
    if (options.baseDirs !== undefined) {
        return [...new Set(options.baseDirs.map(base => expandBaseDir(base, home, cwd)))];
    }
    const worktreeRoot = await findLinkedWorktreeRoot(cwd);
    const environment = options.env ?? process.env;
    const configuredHome = environment.T3CODE_HOME;
    const bases = [
        ...(worktreeRoot === undefined ? [] : [join(worktreeRoot, ".t3")]),
        expandBaseDir(configuredHome?.trim() ? configuredHome : join(home, ".t3"), home, cwd),
    ];
    return [...new Set(bases)];
}

export function runtimePathsForBase(baseDir: string): ReadonlyArray<{
    readonly baseDir: string;
    readonly runtimePath: string;
    readonly variant: "userdata" | "dev";
}> {
    return (["userdata", "dev"] as const).map(variant => ({
        baseDir,
        variant,
        runtimePath: join(baseDir, variant, "server-runtime.json"),
    }));
}

async function readRuntimeState(runtimePath: string): Promise<T3RuntimeState | undefined> {
    try {
        const contents = await readFile(runtimePath, "utf8");
        if (contents.trim().length === 0) return undefined;
        return parseRuntimeState(JSON.parse(contents) as unknown);
    } catch {
        return undefined;
    }
}

async function probeEnvironment(
    runtime: T3RuntimeState,
    fetchImpl: typeof globalThis.fetch,
    timeoutMs: number,
): Promise<T3EnvironmentDescriptor | undefined> {
    if (!isRuntimeOriginValid(runtime)) return undefined;
    try {
        const response = await fetchImpl(new URL(environmentPath, runtime.origin), {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return undefined;
        return parseEnvironmentDescriptor(await response.json());
    } catch {
        return undefined;
    }
}

export async function discoverT3Server(
    options: DiscoveryOptions = {},
): Promise<DiscoveredT3Server | undefined> {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const pidAlive = options.isPidAlive ?? isProcessAlive;
    const baseDirs = await resolveT3BaseDirs(options);
    for (const baseDir of baseDirs) {
        for (const candidate of runtimePathsForBase(baseDir)) {
            const runtime = await readRuntimeState(candidate.runtimePath);
            if (runtime === undefined || !pidAlive(runtime.pid)) continue;
            const descriptor = await probeEnvironment(runtime, fetchImpl, options.timeoutMs ?? 2_500);
            if (descriptor === undefined) continue;
            return { ...candidate, runtime, descriptor };
        }
    }
    return undefined;
}
