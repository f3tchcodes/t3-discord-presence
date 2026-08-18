export interface T3RuntimeState {
    readonly version: 1;
    readonly pid: number;
    readonly host?: string;
    readonly port: number;
    readonly origin: string;
    readonly devUrl?: string;
    readonly startedAt: string;
}

export type T3PlatformOs = "darwin" | "linux" | "windows" | "unknown";
export type T3PlatformArch = "arm64" | "x64" | "other";

export interface T3EnvironmentCapabilities {
    readonly repositoryIdentity: boolean;
    readonly connectionProbe?: boolean;
    readonly pullRequests?: boolean;
    readonly threadSettlement?: boolean;
    readonly threadSnooze?: boolean;
    readonly threadPinning?: boolean;
    readonly threadPinReorder?: boolean;
    readonly threadTitleRegeneration?: boolean;
    readonly serverSelfUpdate?: "boot-service" | "respawn" | "desktop-managed";
    readonly serverSelfUpdateProgress?: boolean;
    readonly agentActivityPublishing?: boolean;
}

export interface T3EnvironmentDescriptor {
    readonly environmentId: string;
    readonly label: string;
    readonly platform: {
        readonly os: T3PlatformOs;
        readonly arch: T3PlatformArch;
    };
    readonly serverVersion: string;
    readonly capabilities: T3EnvironmentCapabilities;
}

export interface DiscoveredT3Server {
    readonly baseDir: string;
    readonly variant: "userdata" | "dev";
    readonly runtimePath: string;
    readonly runtime: T3RuntimeState;
    readonly descriptor: T3EnvironmentDescriptor;
}
