import { chmod, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { writeFileAtomic } from "../utils/atomic-file.js";
import { resolveAppPaths } from "./paths.js";

export const CREDENTIAL_SERVICE = "t3-discord-presence";
export const CREDENTIAL_SCOPE = "orchestration:read" as const;

export interface StoredCredential {
    readonly environmentId: string;
    readonly accessToken: string;
    readonly expiresAt: string;
    readonly scope: typeof CREDENTIAL_SCOPE;
}

export type CredentialStorageMode = "keyring" | "file";

export interface CredentialStore {
    readonly mode: CredentialStorageMode;
    get(environmentId: string): Promise<StoredCredential | undefined>;
    set(credential: StoredCredential): Promise<void>;
    delete(environmentId: string): Promise<void>;
}

export interface KeyringEntryAdapter {
    getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
    setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
    deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

export interface KeyringAdapter {
    readonly AsyncEntry: new (service: string, username: string) => KeyringEntryAdapter;
}

export type KeyringLoader = () => Promise<KeyringAdapter | undefined>;

export interface CredentialStoreOptions {
    readonly credentialsFile?: string;
    readonly keyringLoader?: KeyringLoader;
    readonly service?: string;
}

interface SerializedCredential {
    readonly accessToken: string;
    readonly expiresAt: string;
    readonly scope: typeof CREDENTIAL_SCOPE;
}

interface CredentialFile {
    readonly version: 1;
    readonly environments: Readonly<Record<string, SerializedCredential>>;
}

const mutationQueues = new Map<string, Promise<void>>();

export class CredentialStoreError extends Error {
    override readonly name = "CredentialStoreError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEnvironmentId(environmentId: string): void {
    if (
        environmentId.length === 0
        || environmentId !== environmentId.trim()
        || environmentId.length > 512
    ) {
        throw new CredentialStoreError("environment id is invalid");
    }
}

function parseSerializedCredential(value: unknown): SerializedCredential | undefined {
    if (!isRecord(value)) return undefined;
    if (
        typeof value.accessToken !== "string"
        || value.accessToken.length === 0
        || value.accessToken !== value.accessToken.trim()
        || value.accessToken.length > 65_536
        || typeof value.expiresAt !== "string"
        || !Number.isFinite(Date.parse(value.expiresAt))
        || value.scope !== CREDENTIAL_SCOPE
    ) {
        return undefined;
    }
    return {
        accessToken: value.accessToken,
        expiresAt: new Date(value.expiresAt).toISOString(),
        scope: CREDENTIAL_SCOPE,
    };
}

function serializeCredential(credential: StoredCredential): SerializedCredential {
    validateEnvironmentId(credential.environmentId);
    const parsed = parseSerializedCredential(credential);
    if (parsed === undefined) {
        throw new CredentialStoreError("credential record is invalid");
    }
    return parsed;
}

function parseCredentialFile(contents: string): CredentialFile {
    let value: unknown;
    try {
        value = JSON.parse(contents) as unknown;
    } catch {
        throw new CredentialStoreError("credential storage contains invalid data");
    }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.environments)) {
        throw new CredentialStoreError("credential storage contains invalid data");
    }
    const environments: Record<string, SerializedCredential> = Object.create(null) as Record<
        string,
        SerializedCredential
    >;
    for (const [environmentId, candidate] of Object.entries(value.environments)) {
        const credential = parseSerializedCredential(candidate);
        try {
            validateEnvironmentId(environmentId);
        } catch {
            throw new CredentialStoreError("credential storage contains invalid data");
        }
        if (credential === undefined) {
            throw new CredentialStoreError("credential storage contains invalid data");
        }
        environments[environmentId] = credential;
    }
    return { version: 1, environments };
}

function keyringPayload(credential: StoredCredential): string {
    return JSON.stringify({
        version: 1,
        ...serializeCredential(credential),
    });
}

function parseKeyringPayload(environmentId: string, contents: string): StoredCredential {
    let value: unknown;
    try {
        value = JSON.parse(contents) as unknown;
    } catch {
        throw new CredentialStoreError("the OS credential entry contains invalid data");
    }
    if (!isRecord(value) || value.version !== 1) {
        throw new CredentialStoreError("the OS credential entry contains invalid data");
    }
    const credential = parseSerializedCredential(value);
    if (credential === undefined) {
        throw new CredentialStoreError("the OS credential entry contains invalid data");
    }
    return { environmentId, ...credential };
}

async function defaultKeyringLoader(): Promise<KeyringAdapter | undefined> {
    try {
        const loaded: unknown = await import("@napi-rs/keyring");
        if (!isRecord(loaded) || typeof loaded.AsyncEntry !== "function") return undefined;
        return loaded as unknown as KeyringAdapter;
    } catch {
        return undefined;
    }
}

async function queueMutation(filePath: string, operation: () => Promise<void>): Promise<void> {
    const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    const previous = mutationQueues.get(key) ?? Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(operation);
    const tail = current.catch(() => undefined);
    mutationQueues.set(key, tail);
    void tail.then(() => {
        if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
    });
    return current;
}

class FileCredentialStore implements CredentialStore {
    readonly mode = "file" as const;
    readonly #filePath: string;

    constructor(filePath: string) {
        this.#filePath = resolve(filePath);
    }

    async #read(): Promise<CredentialFile> {
        try {
            const contents = await readFile(this.#filePath, "utf8");
            return parseCredentialFile(contents);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                return { version: 1, environments: {} };
            }
            if (error instanceof CredentialStoreError) throw error;
            throw new CredentialStoreError("could not read credential storage");
        }
    }

    async #write(file: CredentialFile): Promise<void> {
        try {
            await writeFileAtomic(
                this.#filePath,
                `${JSON.stringify(file, null, 4)}\n`,
                { mode: 0o600, directoryMode: 0o700 },
            );
            if (process.platform !== "win32") {
                await Promise.all([
                    chmod(dirname(this.#filePath), 0o700),
                    chmod(this.#filePath, 0o600),
                ]);
            }
        } catch {
            throw new CredentialStoreError("could not write credential storage");
        }
    }

    async get(environmentId: string): Promise<StoredCredential | undefined> {
        validateEnvironmentId(environmentId);
        const credential = (await this.#read()).environments[environmentId];
        return credential === undefined ? undefined : { environmentId, ...credential };
    }

    async set(credential: StoredCredential): Promise<void> {
        const serialized = serializeCredential(credential);
        await queueMutation(this.#filePath, async () => {
            const file = await this.#read();
            await this.#write({
                version: 1,
                environments: {
                    ...file.environments,
                    [credential.environmentId]: serialized,
                },
            });
        });
    }

    async delete(environmentId: string): Promise<void> {
        validateEnvironmentId(environmentId);
        await queueMutation(this.#filePath, async () => {
            const file = await this.#read();
            if (file.environments[environmentId] === undefined) return;
            const environments: Record<string, SerializedCredential> = Object.create(null) as Record<
                string,
                SerializedCredential
            >;
            for (const [key, value] of Object.entries(file.environments)) {
                if (key !== environmentId) environments[key] = value;
            }
            await this.#write({ version: 1, environments });
        });
    }
}

class KeyringCredentialStore implements CredentialStore {
    readonly #fallback: FileCredentialStore;
    readonly #service: string;
    #keyring: KeyringAdapter | undefined;

    constructor(keyring: KeyringAdapter, fallback: FileCredentialStore, service: string) {
        this.#keyring = keyring;
        this.#fallback = fallback;
        this.#service = service;
    }

    get mode(): CredentialStorageMode {
        return this.#keyring === undefined ? "file" : "keyring";
    }

    #entry(environmentId: string): KeyringEntryAdapter {
        const KeyringEntry = this.#keyring?.AsyncEntry;
        if (KeyringEntry === undefined) {
            throw new CredentialStoreError("OS credential storage is unavailable");
        }
        return new KeyringEntry(this.#service, environmentId);
    }

    #useFallback(): void {
        this.#keyring = undefined;
    }

    async get(environmentId: string): Promise<StoredCredential | undefined> {
        validateEnvironmentId(environmentId);
        let contents: string | undefined;
        try {
            contents = await this.#entry(environmentId).getPassword();
        } catch {
            this.#useFallback();
            return this.#fallback.get(environmentId);
        }
        if (contents === undefined) return this.#fallback.get(environmentId);
        return parseKeyringPayload(environmentId, contents);
    }

    async set(credential: StoredCredential): Promise<void> {
        const payload = keyringPayload(credential);
        try {
            await this.#entry(credential.environmentId).setPassword(payload);
        } catch {
            this.#useFallback();
            await this.#fallback.set(credential);
            return;
        }
        await this.#fallback.delete(credential.environmentId);
    }

    async delete(environmentId: string): Promise<void> {
        validateEnvironmentId(environmentId);
        try {
            const entry = this.#entry(environmentId);
            if (await entry.getPassword() !== undefined) await entry.deleteCredential();
        } catch {
            this.#useFallback();
        }
        await this.#fallback.delete(environmentId);
    }
}

export async function createCredentialStore(
    options: CredentialStoreOptions = {},
): Promise<CredentialStore> {
    const fallback = new FileCredentialStore(
        options.credentialsFile ?? resolveAppPaths().credentialsFile,
    );
    let keyring: KeyringAdapter | undefined;
    try {
        keyring = await (options.keyringLoader ?? defaultKeyringLoader)();
    } catch {
        keyring = undefined;
    }
    return keyring === undefined
        ? fallback
        : new KeyringCredentialStore(
            keyring,
            fallback,
            options.service ?? CREDENTIAL_SERVICE,
        );
}
