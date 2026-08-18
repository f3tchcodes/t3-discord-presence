import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileLogger } from "../src/logging/logger.js";

interface RecordedLog {
    readonly timestamp: string;
    readonly level: string;
    readonly message: string;
    readonly metadata?: Record<string, unknown>;
}

const temporaryDirectories: Array<string> = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "t3-presence-logger-"));
    temporaryDirectories.push(directory);
    return directory;
}

async function readLogs(filePath: string): Promise<Array<RecordedLog>> {
    const contents = await readFile(filePath, "utf8");
    return contents.trim().split("\n").map(line => JSON.parse(line) as RecordedLog);
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async directory => {
        await rm(directory, { recursive: true, force: true });
    }));
});

describe("FileLogger", () => {
    it("writes structured entries and respects the configured level", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "logs", "daemon.log");
        const logger = new FileLogger({
            filePath,
            level: "info",
            now: () => new Date("2026-08-18T10:00:00.000Z"),
        });

        await logger.debug("not written");
        await logger.info("daemon started", { pid: 42 });
        await logger.close();

        expect(await readLogs(filePath)).toEqual([{
            timestamp: "2026-08-18T10:00:00.000Z",
            level: "info",
            message: "daemon started",
            metadata: { pid: 42 },
        }]);
    });

    it("redacts secrets, authorization values, prompts, and raw commands", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "daemon.log");
        const logger = new FileLogger({ filePath });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        await logger.error(
            "request failed authorization: Bearer message-secret; access_token=query-secret token=plain-secret wsTicket=socket-secret at C:\\private\\source.ts and /home/ada/private/source.ts",
            {
                authorization: "Bearer header-secret",
                accessToken: "access-secret",
                auth_token: "auth-secret",
                nested: {
                    refresh_token: "refresh-secret",
                    prompt: "private prompt",
                    rawCommand: "rm private-file",
                    safe: "Authorization=Basic basic-secret",
                },
                cyclic,
                path: "D:\\customer\\workspace",
            },
        );
        await logger.close();

        const contents = await readFile(filePath, "utf8");
        for (const secret of [
            "message-secret",
            "query-secret",
            "plain-secret",
            "header-secret",
            "access-secret",
            "auth-secret",
            "refresh-secret",
            "private prompt",
            "rm private-file",
            "basic-secret",
            "socket-secret",
            "C:\\private\\source.ts",
            "/home/ada/private/source.ts",
            "D:\\customer\\workspace",
        ]) {
            expect(contents).not.toContain(secret);
        }
        expect(contents).toContain("[redacted]");
        expect(contents).toContain("[circular]");
    });

    it("redacts spaced Windows paths and arbitrary absolute POSIX paths", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "daemon.log");
        const logger = new FileLogger({ filePath });

        await logger.warn("failed at C:\\Users\\Ada Lovelace\\Client Work\\source.ts");
        await logger.warn("failed at /mnt/customer work/private/source.ts");
        await logger.close();

        const contents = await readFile(filePath, "utf8");
        expect(contents).not.toContain("Ada Lovelace");
        expect(contents).not.toContain("Client Work");
        expect(contents).not.toContain("/mnt/customer");
        expect(contents).toContain("[path]");
    });

    it("serializes concurrent writes in call order", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "daemon.log");
        const logger = new FileLogger({ filePath, maxBytes: 1024 * 1024 });

        await Promise.all(Array.from({ length: 100 }, (_, index) => (
            logger.info(`entry ${index}`, { index })
        )));
        await logger.close();

        const entries = await readLogs(filePath);
        expect(entries).toHaveLength(100);
        expect(entries.map(entry => entry.message)).toEqual(
            Array.from({ length: 100 }, (_, index) => `entry ${index}`),
        );
    });

    it("rotates logs within the configured file and size bounds", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "daemon.log");
        const logger = new FileLogger({
            filePath,
            maxBytes: 256,
            maxFiles: 2,
        });

        for (let index = 0; index < 40; index += 1) {
            await logger.info(`presence changed ${index}`, { project: "cardel" });
        }
        await logger.close();

        for (const logPath of [filePath, `${filePath}.1`, `${filePath}.2`]) {
            expect((await stat(logPath)).size).toBeLessThanOrEqual(256);
            for (const entry of await readLogs(logPath)) {
                expect(entry.level).toBe("info");
            }
        }
        await expect(access(`${filePath}.3`)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("bounds a single oversized log entry", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "daemon.log");
        const logger = new FileLogger({ filePath, maxBytes: 256 });

        await logger.info("x".repeat(20_000), { data: "y".repeat(20_000) });
        await logger.close();

        expect((await stat(filePath)).size).toBeLessThanOrEqual(256);
        expect((await readLogs(filePath))[0]?.message).toContain("[truncated]");
    });

    it("waits for queued writes when closed and rejects later writes", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "daemon.log");
        const logger = new FileLogger({ filePath });
        const pending = logger.info("last entry");

        await logger.close();

        await expect(pending).resolves.toBeUndefined();
        await expect(logger.info("too late")).rejects.toThrow("logger is closed");
        expect((await readLogs(filePath)).map(entry => entry.message)).toEqual(["last entry"]);
    });

    it("validates bounds before accepting writes", async () => {
        const root = await temporaryDirectory();
        expect(() => new FileLogger({
            filePath: join(root, "daemon.log"),
            maxBytes: 127,
        })).toThrow("maxBytes");
        expect(() => new FileLogger({
            filePath: join(root, "daemon.log"),
            maxFiles: 0,
        })).toThrow("maxFiles");
    });
});
