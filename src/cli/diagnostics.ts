import { stat } from "node:fs/promises";
import { posix } from "node:path";

export interface DiscordIpcDependencies {
    readonly isSocket: (filePath: string) => Promise<boolean>;
}

const nodeDependencies: DiscordIpcDependencies = {
    async isSocket(filePath) {
        try {
            return (await stat(filePath)).isSocket();
        } catch {
            return false;
        }
    },
};

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function unixSocketRoots(
    environment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
): ReadonlyArray<string> {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return [...new Set([
        nonEmpty(environment.XDG_RUNTIME_DIR),
        nonEmpty(environment.TMPDIR),
        nonEmpty(environment.TMP),
        nonEmpty(environment.TEMP),
        platform === "linux" && uid !== undefined ? `/run/user/${String(uid)}` : undefined,
        "/tmp",
    ].filter((value): value is string => value !== undefined && posix.isAbsolute(value)))];
}

export async function discordIpcAvailable(
    options: {
        readonly environment?: NodeJS.ProcessEnv;
        readonly platform?: NodeJS.Platform;
        readonly dependencies?: Partial<DiscordIpcDependencies>;
    } = {},
): Promise<boolean | undefined> {
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
        // probing a windows named pipe requires connecting to it, which would interfere with discord rpc.
        return undefined;
    }
    const environment = options.environment ?? process.env;
    const dependencies = { ...nodeDependencies, ...options.dependencies };
    const subdirectories = ["", "app/com.discordapp.Discord", "snap.discord"];
    for (const root of unixSocketRoots(environment, platform)) {
        for (const subdirectory of subdirectories) {
            for (let index = 0; index < 10; index += 1) {
                const socket = posix.join(root, subdirectory, `discord-ipc-${String(index)}`);
                if (await dependencies.isSocket(socket)) return true;
            }
        }
    }
    return false;
}

export function supportedNodeVersion(version: string): boolean {
    const match = /^v?(\d+)\./.exec(version);
    return match !== null && Number(match[1]) >= 22;
}
