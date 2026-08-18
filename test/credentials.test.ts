import { readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
    createCredentialStore,
    type KeyringAdapter,
    type KeyringEntryAdapter,
    type StoredCredential,
} from "../src/config/credentials.js";
import { useTempDirectory } from "./utils/temp-directory.js";

function credential(environmentId: string, token: string): StoredCredential {
    return {
        environmentId,
        accessToken: token,
        expiresAt: "2026-09-18T00:00:00.000Z",
        scope: "orchestration:read",
    };
}

function memoryKeyring(
    values = new Map<string, string>(),
): { readonly keyring: KeyringAdapter; readonly values: Map<string, string> } {
    class Entry implements KeyringEntryAdapter {
        readonly #key: string;

        constructor(service: string, username: string) {
            this.#key = `${service}:${username}`;
        }

        async getPassword(): Promise<string | undefined> {
            return values.get(this.#key);
        }

        async setPassword(password: string): Promise<void> {
            values.set(this.#key, password);
        }

        async deleteCredential(): Promise<boolean> {
            return values.delete(this.#key);
        }
    }
    return { keyring: { AsyncEntry: Entry }, values };
}

describe("credential storage", () => {
    const temp = useTempDirectory();

    it("uses an atomic, restrictive JSON fallback keyed by environment id", async () => {
        const credentialsFile = temp.path("state", "credentials.json");
        const store = await createCredentialStore({
            credentialsFile,
            keyringLoader: async () => undefined,
        });

        await Promise.all([
            store.set(credential("environment-a", "bearer-a")),
            store.set(credential("environment-b", "bearer-b")),
        ]);

        expect(store.mode).toBe("file");
        await expect(store.get("environment-a")).resolves.toEqual(
            credential("environment-a", "bearer-a"),
        );
        await expect(store.get("environment-b")).resolves.toEqual(
            credential("environment-b", "bearer-b"),
        );
        const parsed = JSON.parse(await readFile(credentialsFile, "utf8")) as {
            environments: Record<string, unknown>;
        };
        expect(Object.keys(parsed.environments).sort()).toEqual([
            "environment-a",
            "environment-b",
        ]);
        if (process.platform !== "win32") {
            expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
            expect((await stat(temp.path("state"))).mode & 0o777).toBe(0o700);
        }
    });

    it("uses the optional OS keyring without creating the fallback file", async () => {
        const credentialsFile = temp.path("state", "credentials.json");
        const memory = memoryKeyring();
        const store = await createCredentialStore({
            credentialsFile,
            keyringLoader: async () => memory.keyring,
        });

        await store.set(credential("environment-a", "keyring-bearer"));

        expect(store.mode).toBe("keyring");
        await expect(store.get("environment-a")).resolves.toEqual(
            credential("environment-a", "keyring-bearer"),
        );
        expect(memory.values.size).toBe(1);
        await expect(readFile(credentialsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("falls back to the file if the loaded keyring is unusable", async () => {
        class BrokenEntry implements KeyringEntryAdapter {
            async getPassword(): Promise<string | undefined> {
                throw new Error("keyring unavailable");
            }

            async setPassword(): Promise<void> {
                throw new Error("keyring unavailable");
            }

            async deleteCredential(): Promise<boolean> {
                throw new Error("keyring unavailable");
            }
        }
        const credentialsFile = temp.path("state", "credentials.json");
        const store = await createCredentialStore({
            credentialsFile,
            keyringLoader: async () => ({ AsyncEntry: BrokenEntry }),
        });

        await store.set(credential("environment-a", "fallback-bearer"));

        expect(store.mode).toBe("file");
        await expect(store.get("environment-a")).resolves.toEqual(
            credential("environment-a", "fallback-bearer"),
        );
    });

    it("deletes one environment without affecting another", async () => {
        const store = await createCredentialStore({
            credentialsFile: temp.path("credentials.json"),
            keyringLoader: async () => undefined,
        });
        await store.set(credential("environment-a", "bearer-a"));
        await store.set(credential("environment-b", "bearer-b"));

        await store.delete("environment-a");

        await expect(store.get("environment-a")).resolves.toBeUndefined();
        await expect(store.get("environment-b")).resolves.toEqual(
            credential("environment-b", "bearer-b"),
        );
    });
});
