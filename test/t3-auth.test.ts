import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    ACCESS_TOKEN_TYPE,
    AUTH_CLIENT_DEVICE_TYPE,
    AUTH_CLIENT_LABEL,
    buildWebSocketUrl,
    ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
    exchangePairingCredential,
    isAuthorizationRejected,
    mintPairingCredential,
    parsePairTokenOutput,
    type ProcessAdapter,
    requestWebSocketAuthorization,
    requestWebSocketTicket,
    TOKEN_EXCHANGE_GRANT_TYPE,
} from "../src/t3/auth.js";
import type { DiscoveredT3Server } from "../src/t3/types.js";

const NOW = Date.parse("2026-08-18T10:00:00.000Z");

type RequestHandler = (
    request: IncomingMessage,
    response: ServerResponse,
) => Promise<void> | void;

async function requestBody(request: IncomingMessage): Promise<string> {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

function target(origin: string, variant: "userdata" | "dev" = "userdata"): DiscoveredT3Server {
    const url = new URL(origin);
    return {
        baseDir: "C:\\T3 Home",
        variant,
        runtimePath: `C:\\T3 Home\\${variant}\\server-runtime.json`,
        runtime: {
            version: 1,
            pid: 123,
            port: Number.parseInt(url.port, 10),
            origin,
            ...(variant === "dev" ? { devUrl: "http://127.0.0.1:5173" } : {}),
            startedAt: "2026-08-18T09:00:00.000Z",
        },
        descriptor: {
            environmentId: "environment-1",
            label: "local t3",
            platform: { os: "windows", arch: "x64" },
            serverVersion: "0.0.33",
            capabilities: { repositoryIdentity: true },
        },
    };
}

describe("T3 HTTP authentication", () => {
    let server: Server;
    let origin: string;
    let handler: RequestHandler;

    beforeEach(async () => {
        handler = (_request, response) => sendJson(response, 500, { error: "missing handler" });
        server = createServer((request, response) => {
            void Promise.resolve(handler(request, response)).catch(() => {
                response.destroy();
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing server port");
        origin = `http://127.0.0.1:${String(address.port)}`;
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it("exchanges a pairing credential with the exact read-only request shape", async () => {
        let capturedBody = "";
        let capturedRequest: IncomingMessage | undefined;
        handler = async (request, response) => {
            capturedRequest = request;
            capturedBody = await requestBody(request);
            sendJson(response, 200, {
                access_token: "saved-bearer-token",
                issued_token_type: ACCESS_TOKEN_TYPE,
                token_type: "Bearer",
                expires_in: 3_600,
                scope: "orchestration:read",
            });
        };

        const result = await exchangePairingCredential(
            target(origin),
            "one-time-pairing-token",
            { now: () => NOW, clientOs: "windows" },
        );

        const form = new URLSearchParams(capturedBody);
        expect(capturedRequest?.method).toBe("POST");
        expect(capturedRequest?.url).toBe("/oauth/token");
        expect(capturedRequest?.headers["content-type"]).toBe(
            "application/x-www-form-urlencoded",
        );
        expect(Object.fromEntries(form)).toEqual({
            grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
            subject_token: "one-time-pairing-token",
            subject_token_type: ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
            requested_token_type: ACCESS_TOKEN_TYPE,
            scope: "orchestration:read",
            client_label: AUTH_CLIENT_LABEL,
            client_device_type: AUTH_CLIENT_DEVICE_TYPE,
            client_os: "windows",
        });
        expect([...form.values()]).not.toContain("orchestration:operate");
        expect(result).toEqual({
            environmentId: "environment-1",
            accessToken: "saved-bearer-token",
            expiresAt: "2026-08-18T11:00:00.000Z",
            scope: "orchestration:read",
        });
    });

    it("treats 401 as revoked without carrying credentials or response output", async () => {
        const pairingToken = "pairing-secret-that-must-not-leak";
        handler = async (request, response) => {
            await requestBody(request);
            sendJson(response, 401, {
                error: "invalid_grant",
                credential: pairingToken,
            });
        };

        let captured: unknown;
        try {
            await exchangePairingCredential(target(origin), pairingToken);
        } catch (error) {
            captured = error;
        }

        expect(isAuthorizationRejected(captured)).toBe(true);
        expect(`${String(captured)}\n${captured instanceof Error ? captured.stack : ""}`)
            .not.toContain(pairingToken);
    });

    it("rejects expired or over-scoped token responses without leaking the bearer", async () => {
        const responseToken = "response-bearer-that-must-not-leak";
        handler = async (request, response) => {
            await requestBody(request);
            sendJson(response, 200, {
                access_token: responseToken,
                issued_token_type: ACCESS_TOKEN_TYPE,
                token_type: "Bearer",
                expires_in: 0,
                scope: "orchestration:read orchestration:operate",
            });
        };

        let captured: unknown;
        try {
            await exchangePairingCredential(target(origin), "pairing-token", { now: () => NOW });
        } catch (error) {
            captured = error;
        }

        expect(captured).toMatchObject({ code: "invalid-response" });
        expect(`${String(captured)}\n${captured instanceof Error ? captured.stack : ""}`)
            .not.toContain(responseToken);
    });

    it("requests a short-lived WebSocket ticket with bearer header and no body", async () => {
        let capturedBody = "not read";
        let capturedRequest: IncomingMessage | undefined;
        handler = async (request, response) => {
            capturedRequest = request;
            capturedBody = await requestBody(request);
            sendJson(response, 200, {
                ticket: "short+ticket/value",
                expiresAt: "2026-08-18T10:01:00.000Z",
            });
        };

        const authorization = await requestWebSocketAuthorization(
            target(origin),
            "long-lived-bearer",
            { now: () => NOW },
        );

        expect(capturedRequest?.method).toBe("POST");
        expect(capturedRequest?.url).toBe("/api/auth/websocket-ticket");
        expect(capturedRequest?.headers.authorization).toBe("Bearer long-lived-bearer");
        expect(capturedRequest?.headers["content-type"]).toBeUndefined();
        expect(capturedBody).toBe("");
        expect(authorization).toEqual({
            ticket: "short+ticket/value",
            expiresAt: "2026-08-18T10:01:00.000Z",
            url: `${origin.replace("http:", "ws:")}/ws?wsTicket=short%2Bticket%2Fvalue`,
        });
    });

    it("reports a revoked bearer without including it in the error", async () => {
        const bearer = "revoked-bearer-that-must-not-leak";
        handler = async (request, response) => {
            await requestBody(request);
            sendJson(response, 401, { token: bearer });
        };

        let captured: unknown;
        try {
            await requestWebSocketTicket(target(origin), bearer);
        } catch (error) {
            captured = error;
        }

        expect(isAuthorizationRejected(captured)).toBe(true);
        expect(`${String(captured)}\n${captured instanceof Error ? captured.stack : ""}`)
            .not.toContain(bearer);
    });

    it("builds secure WebSocket URLs for HTTPS origins", () => {
        expect(buildWebSocketUrl("https://example.test:443", "ticket/value"))
            .toBe("wss://example.test/ws?wsTicket=ticket%2Fvalue");
    });
});

describe("official T3 CLI pairing", () => {
    it("targets verified userdata with T3CODE_HOME and parses JSON", async () => {
        const calls: Array<{
            readonly executable: string;
            readonly arguments_: ReadonlyArray<string>;
            readonly env: NodeJS.ProcessEnv;
        }> = [];
        const processAdapter: ProcessAdapter = {
            async run(executable, arguments_, options) {
                calls.push({ executable, arguments_, env: options.env });
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({
                        id: "pairing-1",
                        credential: "json-pairing-token",
                        scopes: ["orchestration:read", "orchestration:operate"],
                        expiresAt: "2026-08-18T10:05:00.000Z",
                    }),
                    stderr: "",
                };
            },
        };

        await expect(mintPairingCredential(target("http://127.0.0.1:41773"), {
            process: processAdapter,
            env: { PATH: "test-path", T3CODE_HOME: "wrong-home" },
            now: () => NOW,
        })).resolves.toBe("json-pairing-token");

        expect(calls).toEqual([{
            executable: "t3",
            arguments_: [
                "auth",
                "pairing",
                "create",
                "--json",
                "--label",
                "t3 discord presence",
            ],
            env: { PATH: "test-path", T3CODE_HOME: "C:\\T3 Home" },
        }]);
    });

    it("uses discovery-aware t3 pair for dev and only parses an anchored Token line", async () => {
        let arguments_: ReadonlyArray<string> = [];
        const processAdapter: ProcessAdapter = {
            async run(_executable, suppliedArguments) {
                arguments_ = suppliedArguments;
                return {
                    exitCode: 0,
                    stdout: [
                        "Pairing URL: http://127.0.0.1/pair#token=decoy",
                        "Token: dev-pairing-token",
                        "Expires: 2026-08-18T10:05:00.000Z",
                    ].join("\n"),
                    stderr: "",
                };
            },
        };

        await expect(mintPairingCredential(
            target("http://127.0.0.1:41773", "dev"),
            { process: processAdapter },
        )).resolves.toBe("dev-pairing-token");
        expect(arguments_).toEqual([
            "pair",
            "--base-dir",
            "C:\\T3 Home",
            "--label",
            "t3 discord presence",
        ]);
        expect(() => parsePairTokenOutput("prefix Token: inline-secret"))
            .toThrow("one valid Token line");
        expect(() => parsePairTokenOutput("Token: first\nToken: second"))
            .toThrow("one valid Token line");
    });

    it("never carries captured T3 CLI output into an error", async () => {
        const secret = "captured-pairing-secret";
        const failedProcess: ProcessAdapter = {
            async run() {
                return {
                    exitCode: 1,
                    stdout: `Token: ${secret}`,
                    stderr: `failed for ${secret}`,
                };
            },
        };

        let captured: unknown;
        try {
            await mintPairingCredential(target("http://127.0.0.1:41773"), {
                process: failedProcess,
            });
        } catch (error) {
            captured = error;
        }

        expect(captured).toMatchObject({ code: "pairing-failed" });
        expect(`${String(captured)}\n${captured instanceof Error ? captured.stack : ""}`)
            .not.toContain(secret);
    });
});
