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

    it("does not reclaim a stale lock while its sleeping owner is still alive", async () => {
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
        await expect(acquireDaemonLock({
            lockFile,
            pid: 654,
            nonce: () => "replacement-owner",
            now: () => Date.parse("2026-08-18T00:01:00.000Z"),
            processIsRunning: () => {
                probes += 1;
                return true;
            },
        })).rejects.toBeInstanceOf(DuplicateDaemonError);

        expect(probes).toBe(1);
        await expect(readDaemonLock(lockFile)).resolves.toMatchObject({
            pid: 321,
            nonce: "possibly-reused-pid",
        });
    });

    it("reclaims a lock after confirming its owner is dead", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        const first = await acquireDaemonLock({
            lockFile,
            pid: 321,
            nonce: () => "dead-original-owner",
        });
        const lease = await acquireDaemonLock({
            lockFile,
            pid: 654,
            nonce: () => "replacement-owner",
            processIsRunning: () => false,
        });

        expect(lease.record.pid).toBe(654);
        await first.release();
        await lease.release();
    });

    it("rechecks ownership before reclaiming a concurrently revived lock", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        const owner = await acquireDaemonLock({
            lockFile,
            pid: 321,
            nonce: () => "racing-original-owner",
        });
        let probes = 0;

        await expect(acquireDaemonLock({
            lockFile,
            pid: 654,
            nonce: () => "racing-replacement",
            processIsRunning: () => {
                probes += 1;
                return probes > 1;
            },
        })).rejects.toBeInstanceOf(DuplicateDaemonError);

        expect(probes).toBeGreaterThanOrEqual(2);
        await expect(readDaemonLock(lockFile)).resolves.toMatchObject({
            pid: 321,
            nonce: "racing-original-owner",
        });
        await owner.release();
    });

    it("reclaims malformed lock metadata", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        await mkdir(dirname(lockFile), { recursive: true });
        await writeFile(lockFile, "{malformed");

        const lease = await acquireDaemonLock({
            lockFile,
            pid: 654,
            nonce: () => "valid-replacement-owner",
            processIsRunning: () => {
                throw new Error("malformed locks have no pid to probe");
            },
        });

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

    it("uses a read-only heartbeat that cannot overwrite a replacement owner", async () => {
        const lockFile = temp.path("runtime", "daemon.lock");
        let now = 1_000;
        const lease = await acquireDaemonLock({
            lockFile,
            nonce: () => "heartbeat-owner-nonce",
            now: () => now,
        });
        const originalContents = await readFile(lockFile, "utf8");
        now = 2_000;
        await expect(lease.heartbeat()).resolves.toBe(true);
        await expect(readFile(lockFile, "utf8")).resolves.toBe(originalContents);

        const replacement = {
            ...lease.record,
            pid: 999,
            nonce: "replacement-heartbeat-owner",
            startedAt: "1970-01-01T00:00:02.000Z",
            heartbeatAt: "1970-01-01T00:00:02.000Z",
        };
        await Promise.all([
            lease.heartbeat(),
            writeFile(lockFile, JSON.stringify(replacement)),
        ]);

        await expect(readDaemonLock(lockFile)).resolves.toMatchObject({
            pid: 999,
            nonce: "replacement-heartbeat-owner",
        });
        await expect(lease.heartbeat()).resolves.toBe(false);
        await lease.release();
    });
});
