import type { SetActivity } from "@xhayper/discord-rpc";

export type DiscordActivity = SetActivity;

export type DiscordConnectionState = "waiting" | "connecting" | "connected" | "stopped";

export interface DiscordPresenceClient {
    login(): Promise<void>;
    setActivity(activity: DiscordActivity): Promise<void>;
    clearActivity(): Promise<void>;
    destroy(): Promise<void>;
    onDisconnected(listener: () => void): () => void;
}
