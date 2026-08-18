import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
    acquireDaemonLock,
    consumeStopRequest,
    DuplicateDaemonError,
    readDaemonLock,
    requestDaemonStop,
} from "../src/daemon/lock.js";
import { useTempDirectory } from "./utils/temp-directory.js";

describe("daemon lock", () => {
    const temp = useTempDirectory();

    it("prevents a duplicate while a fresh owner process is alive", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        const first = await acquireDaemonLock({
            lockFile,
            pid: 100,
            nonce: () => "first-owner-nonce",
            now: () => 1_000,
            processIsRunning: () => true,
        });

        await expect(acquireDaemonLock({
            lockFile,
            pid: 200,
            nonce: () => "second-owner-nonce",
            now: () => 2_000,
            processIsRunning: () => true,
        })).rejects.toBeInstanceOf(DuplicateDaemonError);

        await first.release();
        await expect(readDaemonLock(lockFile)).resolves.toBeUndefined();
    });

    it("reclaims a stale lock without signaling its possibly reused pid", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        await mkdir(dirname(lockFile), { recursive: true });
        await writeFile(lockFile, JSON.stringify({
            version: 1,
            pid: 321,
            nonce: "possibly-reused-pid",
            startedAt: "2026-08-18T00:00:00.000Z",
            heartbeatAt: "2026-08-18T00:00:00.000Z",
            entrypoint: "old entrypoint",
        }));
        let probes = 0;
        const lease = await acquireDaemonLock({
            lockFile,
            pid: 654,
            nonce: () => "replacement-owner",
            now: () => Date.parse("2026-08-18T00:01:00.000Z"),
            staleAfterMs: 10_000,
            processIsRunning: () => {
                probes += 1;
                return true;
            },
        });

        expect(probes).toBe(0);
        expect(lease.record.pid).toBe(654);
        await lease.release();
    });

    it("uses a nonce-bound cooperative stop request", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        const stopFile = temp.path("runtime", "daemon.stop");
        const lease = await acquireDaemonLock({
            lockFile,
            nonce: () => "cooperative-owner",
            now: () => 10_000,
        });

        await expect(requestDaemonStop(lockFile, stopFile, () => 11_000))
            .resolves.toMatchObject({ nonce: "cooperative-owner" });
        await expect(consumeStopRequest(stopFile, "different-owner")).resolves.toBe(false);
        await expect(readFile(stopFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        await requestDaemonStop(lockFile, stopFile, () => 12_000);
        await expect(consumeStopRequest(stopFile, "cooperative-owner")).resolves.toBe(true);
        await lease.release();
    });

    it("does not remove a replacement owner's lock during release", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        const lease = await acquireDaemonLock({
            lockFile,
            nonce: () => "original-owner-nonce",
        });
        await writeFile(lockFile, JSON.stringify({
            ...lease.record,
            pid: 999,
            nonce: "replacement-owner-nonce",
        }));

        await lease.release();

        await expect(readDaemonLock(lockFile)).resolves.toMatchObject({
            pid: 999,
            nonce: "replacement-owner-nonce",
        });
    });

    it("heartbeats only while it still owns the lock", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        let now = 1_000;
        const lease = await acquireDaemonLock({
            lockFile,
            nonce: () => "heartbeat-owner-nonce",
            now: () => now,
        });
        now = 2_000;
        await expect(lease.heartbeat()).resolves.toBe(true);
        await expect(readDaemonLock(lockFile)).resolves.toMatchObject({
            heartbeatAt: "1970-01-01T00:00:02.000Z",
        });
        await lease.release();
        await expect(lease.heartbeat()).resolves.toBe(false);
    });
});
