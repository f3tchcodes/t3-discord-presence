import { spawn } from "node:child_process";

import {
    CREDENTIAL_SCOPE,
    type CredentialStore,
    type StoredCredential,
} from "../config/credentials.js";
import { resolveT3CliCommand } from "./cli.js";
import type { DiscoveredT3Server } from "./types.js";

export const AUTH_CLIENT_LABEL = "t3 discord presence";
export const AUTH_CLIENT_DEVICE_TYPE = "bot";
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE =
    "urn:t3:params:oauth:token-type:environment-bootstrap";

const TOKEN_PATH = "/oauth/token";
const WEBSOCKET_TICKET_PATH = "/api/auth/websocket-ticket";
const WEBSOCKET_PATH = "/ws";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_EXPIRY_SKEW_MS = 30_000;
const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;

export type T3AuthErrorCode =
    | "invalid-input"
    | "request-failed"
    | "unauthorized"
    | "invalid-response"
    | "pairing-unavailable"
    | "pairing-failed";

export class T3AuthError extends Error {
    override readonly name = "T3AuthError";
    readonly code: T3AuthErrorCode;
    readonly status?: number;

    constructor(message: string, code: T3AuthErrorCode, status?: number) {
        super(message);
        this.code = code;
        if (status !== undefined) this.status = status;
    }
}

export interface ProcessResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface ProcessRunOptions {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
}

export interface ProcessAdapter {
    run(
        executable: string,
        arguments_: ReadonlyArray<string>,
        options: ProcessRunOptions,
    ): Promise<ProcessResult>;
}

export interface PairingOptions {
    readonly executable?: string;
    readonly argumentsPrefix?: ReadonlyArray<string>;
    readonly process?: ProcessAdapter;
    readonly env?: NodeJS.ProcessEnv;
    readonly label?: string;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
}

export interface AuthRequestOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

export interface ExchangeOptions extends AuthRequestOptions {
    readonly clientLabel?: string;
    readonly clientOs?: string;
}

export interface AuthorizeOptions extends ExchangeOptions, PairingOptions {
    readonly expirySkewMs?: number;
    readonly force?: boolean;
}

export interface WebSocketTicket {
    readonly ticket: string;
    readonly expiresAt: string;
}

export interface WebSocketAuthorization extends WebSocketTicket {
    readonly url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSecret(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value === value.trim()
        && value.length <= 65_536;
}

function authEndpoint(origin: string, path: string): URL {
    try {
        const base = new URL(origin);
        if (
            (base.protocol !== "http:" && base.protocol !== "https:")
            || base.username.length > 0
            || base.password.length > 0
        ) {
            throw new Error("invalid protocol");
        }
        return new URL(path, base.origin);
    } catch {
        throw new T3AuthError("T3 server origin is invalid", "invalid-input");
    }
}

function requestSignal(options: AuthRequestOptions): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    return options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal]);
}

async function cancelResponse(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
}

function responseError(response: Response, operation: string): T3AuthError {
    if (response.status === 401 || response.status === 403) {
        return new T3AuthError(`T3 rejected ${operation}`, "unauthorized", response.status);
    }
    return new T3AuthError(
        `T3 ${operation} failed with HTTP ${String(response.status)}`,
        "request-failed",
        response.status,
    );
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
    try {
        return await response.json() as unknown;
    } catch {
        throw new T3AuthError(`T3 returned an invalid ${operation} response`, "invalid-response");
    }
}

function expiryFromSeconds(expiresIn: unknown, now: number): string | undefined {
    if (
        typeof expiresIn !== "number"
        || !Number.isFinite(expiresIn)
        || expiresIn <= 0
    ) {
        return undefined;
    }
    const expiry = now + expiresIn * 1_000;
    if (!Number.isFinite(expiry) || expiry <= now) return undefined;
    try {
        return new Date(expiry).toISOString();
    } catch {
        return undefined;
    }
}

function parseAccessTokenResponse(
    value: unknown,
    environmentId: string,
    now: number,
): StoredCredential {
    if (!isRecord(value)) {
        throw new T3AuthError("T3 returned an invalid token response", "invalid-response");
    }
    const expiresAt = expiryFromSeconds(value.expires_in, now);
    const scopes = typeof value.scope === "string"
        ? value.scope.trim().split(/\s+/).filter(Boolean)
        : [];
    if (
        !validSecret(value.access_token)
        || value.issued_token_type !== ACCESS_TOKEN_TYPE
        || value.token_type !== "Bearer"
        || expiresAt === undefined
        || scopes.length !== 1
        || scopes[0] !== CREDENTIAL_SCOPE
    ) {
        throw new T3AuthError("T3 returned an invalid token response", "invalid-response");
    }
    return {
        environmentId,
        accessToken: value.access_token,
        expiresAt,
        scope: CREDENTIAL_SCOPE,
    };
}

function parseTicketResponse(value: unknown, now: number): WebSocketTicket {
    if (!isRecord(value) || !validSecret(value.ticket) || typeof value.expiresAt !== "string") {
        throw new T3AuthError("T3 returned an invalid WebSocket ticket response", "invalid-response");
    }
    const expiry = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) {
        throw new T3AuthError("T3 returned an expired WebSocket ticket", "invalid-response");
    }
    return {
        ticket: value.ticket,
        expiresAt: new Date(expiry).toISOString(),
    };
}

export const nodeProcessAdapter: ProcessAdapter = {
    async run(executable, arguments_, options) {
        return new Promise<ProcessResult>((resolve, reject) => {
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
            const fail = (message: string) => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(new T3AuthError(message, "pairing-failed"));
            };
            const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
                outputBytes += chunk.byteLength;
                if (outputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
                    fail("T3 CLI produced too much pairing output");
                    return;
                }
                if (stream === "stdout") stdout += chunk.toString("utf8");
                else stderr += chunk.toString("utf8");
            };
            child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
            child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
            child.once("error", () => fail("could not start the T3 CLI"));
            child.once("close", code => {
                if (settled) return;
                settled = true;
                resolve({ exitCode: code ?? 1, stdout, stderr });
            });
        });
    },
};

export function parsePairingJsonOutput(output: string, now = Date.now()): string {
    let value: unknown;
    try {
        value = JSON.parse(output) as unknown;
    } catch {
        throw new T3AuthError("T3 CLI returned invalid pairing JSON", "pairing-failed");
    }
    if (
        !isRecord(value)
        || !validSecret(value.credential)
        || !Array.isArray(value.scopes)
        || !value.scopes.includes(CREDENTIAL_SCOPE)
        || typeof value.expiresAt !== "string"
        || !Number.isFinite(Date.parse(value.expiresAt))
        || Date.parse(value.expiresAt) <= now
    ) {
        throw new T3AuthError("T3 CLI returned an invalid pairing credential", "pairing-failed");
    }
    return value.credential;
}

export function parsePairTokenOutput(output: string): string {
    const tokens = [...output.matchAll(/^Token:[ \t]+([^\s]+)[ \t]*\r?$/gm)];
    const token = tokens.length === 1 ? tokens[0]?.[1] : undefined;
    if (!validSecret(token)) {
        throw new T3AuthError("T3 CLI did not return one valid Token line", "pairing-failed");
    }
    return token;
}

export async function mintPairingCredential(
    server: DiscoveredT3Server,
    options: PairingOptions = {},
): Promise<string> {
    const processAdapter = options.process ?? nodeProcessAdapter;
    const label = options.label ?? AUTH_CLIENT_LABEL;
    if (label.trim().length === 0 || label.length > 256) {
        throw new T3AuthError("pairing label is invalid", "invalid-input");
    }
    const env = {
        ...(options.env ?? process.env),
        T3CODE_HOME: server.baseDir,
    };
    const pairingArguments = server.variant === "userdata"
        ? ["auth", "pairing", "create", "--json", "--label", label]
        : ["pair", "--base-dir", server.baseDir, "--label", label];
    let command: {
        readonly executable: string;
        readonly argumentsPrefix: ReadonlyArray<string>;
    } | undefined;
    if (
        options.executable !== undefined
        || options.argumentsPrefix !== undefined
        || options.process !== undefined
    ) {
        command = {
            executable: options.executable ?? "t3",
            argumentsPrefix: options.argumentsPrefix ?? [],
        };
    } else {
        command = await resolveT3CliCommand({
            env,
            runtimePid: server.runtime.pid,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }
    if (command === undefined) {
        throw new T3AuthError("could not find a supported T3 CLI", "pairing-unavailable");
    }
    const arguments_ = [...command.argumentsPrefix, ...pairingArguments];
    let result: ProcessResult;
    try {
        result = await processAdapter.run(
            command.executable,
            arguments_,
            {
                env,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
        );
    } catch {
        throw new T3AuthError("could not run the T3 CLI for pairing", "pairing-unavailable");
    }
    if (result.exitCode !== 0) {
        throw new T3AuthError("T3 CLI pairing failed", "pairing-failed");
    }
    return server.variant === "userdata"
        ? parsePairingJsonOutput(result.stdout, (options.now ?? Date.now)())
        : parsePairTokenOutput(result.stdout);
}

export async function exchangePairingCredential(
    server: DiscoveredT3Server,
    pairingCredential: string,
    options: ExchangeOptions = {},
): Promise<StoredCredential> {
    if (!validSecret(pairingCredential)) {
        throw new T3AuthError("pairing credential is invalid", "invalid-input");
    }
    const form = new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
        subject_token: pairingCredential,
        subject_token_type: ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
        requested_token_type: ACCESS_TOKEN_TYPE,
        scope: CREDENTIAL_SCOPE,
        client_label: options.clientLabel ?? AUTH_CLIENT_LABEL,
        client_device_type: AUTH_CLIENT_DEVICE_TYPE,
        client_os: options.clientOs ?? process.platform,
    });
    let response: Response;
    try {
        response = await (options.fetch ?? globalThis.fetch)(
            authEndpoint(server.runtime.origin, TOKEN_PATH),
            {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: form,
                signal: requestSignal(options),
            },
        );
    } catch {
        throw new T3AuthError("could not reach T3 for token exchange", "request-failed");
    }
    if (!response.ok) {
        await cancelResponse(response);
        throw responseError(response, "the pairing credential");
    }
    return parseAccessTokenResponse(
        await responseJson(response, "token"),
        server.descriptor.environmentId,
        (options.now ?? Date.now)(),
    );
}

export function isCredentialUsable(
    credential: StoredCredential,
    options: { readonly now?: number; readonly expirySkewMs?: number } = {},
): boolean {
    const expiry = Date.parse(credential.expiresAt);
    return credential.scope === CREDENTIAL_SCOPE
        && Number.isFinite(expiry)
        && expiry > (options.now ?? Date.now()) + (options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS);
}

export async function authorizeT3Server(
    server: DiscoveredT3Server,
    store: CredentialStore,
    options: AuthorizeOptions = {},
): Promise<StoredCredential> {
    const now = (options.now ?? Date.now)();
    const existing = await store.get(server.descriptor.environmentId);
    if (
        options.force !== true
        && existing !== undefined
        && isCredentialUsable(existing, {
            now,
            ...(options.expirySkewMs === undefined
                ? {}
                : { expirySkewMs: options.expirySkewMs }),
        })
    ) {
        return existing;
    }
    if (existing !== undefined) await store.delete(server.descriptor.environmentId);
    const pairingCredential = await mintPairingCredential(server, options);
    const credential = await exchangePairingCredential(server, pairingCredential, options);
    await store.set(credential);
    return credential;
}

export async function requestWebSocketTicket(
    server: DiscoveredT3Server,
    accessToken: string,
    options: AuthRequestOptions = {},
): Promise<WebSocketTicket> {
    if (!validSecret(accessToken)) {
        throw new T3AuthError("bearer credential is invalid", "invalid-input");
    }
    let response: Response;
    try {
        response = await (options.fetch ?? globalThis.fetch)(
            authEndpoint(server.runtime.origin, WEBSOCKET_TICKET_PATH),
            {
                method: "POST",
                headers: { authorization: `Bearer ${accessToken}` },
                signal: requestSignal(options),
            },
        );
    } catch {
        throw new T3AuthError("could not reach T3 for WebSocket authorization", "request-failed");
    }
    if (!response.ok) {
        await cancelResponse(response);
        throw responseError(response, "the bearer credential");
    }
    return parseTicketResponse(
        await responseJson(response, "WebSocket ticket"),
        (options.now ?? Date.now)(),
    );
}

export function buildWebSocketUrl(origin: string, ticket: string): string {
    if (!validSecret(ticket)) {
        throw new T3AuthError("WebSocket ticket is invalid", "invalid-input");
    }
    const url = authEndpoint(origin, WEBSOCKET_PATH);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    return url.toString();
}

export async function requestWebSocketAuthorization(
    server: DiscoveredT3Server,
    accessToken: string,
    options: AuthRequestOptions = {},
): Promise<WebSocketAuthorization> {
    const authorization = await requestWebSocketTicket(server, accessToken, options);
    return {
        ...authorization,
        url: buildWebSocketUrl(server.runtime.origin, authorization.ticket),
    };
}

export function isAuthorizationRejected(error: unknown): error is T3AuthError {
    return error instanceof T3AuthError && error.code === "unauthorized";
}
