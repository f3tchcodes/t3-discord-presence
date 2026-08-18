import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    discoverT3Server,
    isRuntimeOriginValid,
    parseRuntimeState,
    resolveT3BaseDirs,
} from "../src/t3/discovery.js";
import type { T3RuntimeState } from "../src/t3/types.js";
import { useTempDirectory } from "./utils/temp-directory.js";

const descriptor = {
    environmentId: "environment-1",
    label: "local t3",
    platform: { os: "windows", arch: "x64" },
    serverVersion: "0.0.33",
    capabilities: { repositoryIdentity: true },
};

function runtime(overrides: Partial<T3RuntimeState> = {}): T3RuntimeState {
    return {
        version: 1,
        pid: 123,
        port: 41_773,
        origin: "http://127.0.0.1:41773",
        startedAt: "2026-08-18T00:00:00.000Z",
        ...overrides,
    };
}

async function writeRuntime(baseDir: string, value: unknown, variant = "userdata") {
    const stateDir = join(baseDir, variant);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "server-runtime.json"), JSON.stringify(value));
}

describe("t3 runtime discovery", () => {
    const temp = useTempDirectory();

    it("discovers a valid custom-port runtime and verifies its descriptor", async () => {
        const baseDir = temp.path("custom-home");
        await writeRuntime(baseDir, runtime());
        const requests: Array<string> = [];

        const result = await discoverT3Server({
            baseDirs: [baseDir],
            isPidAlive: () => true,
            fetch: async input => {
                requests.push(String(input));
                return Response.json(descriptor);
            },
        });

        expect(result?.runtime.port).toBe(41_773);
        expect(result?.descriptor.environmentId).toBe("environment-1");
        expect(requests).toEqual(["http://127.0.0.1:41773/.well-known/t3/environment"]);
    });

    it("returns undefined for a missing runtime file", async () => {
        await expect(discoverT3Server({
            baseDirs: [temp.path("missing")],
            isPidAlive: () => true,
            fetch: async () => Response.json(descriptor),
        })).resolves.toBeUndefined();
    });

    it("ignores malformed runtime JSON", async () => {
        const baseDir = temp.path("malformed");
        const stateDir = join(baseDir, "userdata");
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(stateDir, "server-runtime.json"), "not json");

        await expect(discoverT3Server({
            baseDirs: [baseDir],
            isPidAlive: () => true,
            fetch: async () => Response.json(descriptor),
        })).resolves.toBeUndefined();
    });

    it("rejects a stale pid before probing HTTP", async () => {
        const baseDir = temp.path("stale");
        await writeRuntime(baseDir, runtime());
        let probed = false;

        const result = await discoverT3Server({
            baseDirs: [baseDir],
            isPidAlive: () => false,
            fetch: async () => {
                probed = true;
                return Response.json(descriptor);
            },
        });

        expect(result).toBeUndefined();
        expect(probed).toBe(false);
    });

    it("accepts only canonical loopback origins with matching ports", () => {
        expect(isRuntimeOriginValid(runtime())).toBe(true);
        expect(isRuntimeOriginValid(runtime({ origin: "http://localhost:41773" }))).toBe(true);
        expect(isRuntimeOriginValid(runtime({ origin: "http://127.255.255.254:41773" })))
            .toBe(true);
        expect(isRuntimeOriginValid(runtime({ origin: "http://[::1]:41773" }))).toBe(true);
        expect(isRuntimeOriginValid(runtime({ origin: "http://127.0.0.1:1234" }))).toBe(false);
        expect(isRuntimeOriginValid(runtime({ origin: "http://127.0.0.1:41773/not-t3" }))).toBe(false);
        expect(isRuntimeOriginValid(runtime({ origin: "file:///tmp/t3", port: 80 }))).toBe(false);
        expect(isRuntimeOriginValid(runtime({ origin: "http://0.0.0.0:41773" }))).toBe(false);
        expect(isRuntimeOriginValid(runtime({ origin: "http://192.168.1.20:41773" }))).toBe(false);
        expect(isRuntimeOriginValid(runtime({ origin: "https://example.test:41773" }))).toBe(false);
    });

    it("rejects a non-loopback runtime before making a descriptor request", async () => {
        const baseDir = temp.path("remote-origin");
        await writeRuntime(baseDir, runtime({ origin: "http://192.168.1.20:41773" }));
        let probed = false;

        await expect(discoverT3Server({
            baseDirs: [baseDir],
            isPidAlive: () => true,
            fetch: async () => {
                probed = true;
                return Response.json(descriptor);
            },
        })).resolves.toBeUndefined();
        expect(probed).toBe(false);
    });

    it("rejects a non-T3 HTTP service", async () => {
        const baseDir = temp.path("other-http");
        await writeRuntime(baseDir, runtime());

        await expect(discoverT3Server({
            baseDirs: [baseDir],
            isPidAlive: () => true,
            fetch: async () => Response.json({ name: "another service" }),
        })).resolves.toBeUndefined();
    });

    it("respects T3CODE_HOME", async () => {
        const baseDir = temp.path("environment-home");
        await expect(resolveT3BaseDirs({
            cwd: temp.path(),
            env: { T3CODE_HOME: baseDir },
            homeDir: temp.path("ignored-home"),
        })).resolves.toEqual([baseDir]);
    });

    it("accepts dev runtime state", async () => {
        const baseDir = temp.path("dev-home");
        await writeRuntime(baseDir, runtime({ devUrl: "http://127.0.0.1:5173" }), "dev");

        const result = await discoverT3Server({
            baseDirs: [baseDir],
            isPidAlive: () => true,
            fetch: async () => Response.json(descriptor),
        });

        expect(result?.variant).toBe("dev");
    });

    it("validates runtime field types", () => {
        expect(parseRuntimeState(runtime())).toEqual(runtime());
        expect(parseRuntimeState({ ...runtime(), port: "41773" })).toBeUndefined();
        expect(parseRuntimeState({ ...runtime(), pid: -1 })).toBeUndefined();
    });
});
