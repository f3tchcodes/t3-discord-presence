import { describe, expect, it } from "vitest";

import {
    DaemonStatusWriter,
    parseDaemonStatus,
    readDaemonStatus,
} from "../src/daemon/status.js";
import { useTempDirectory } from "./utils/temp-directory.js";

describe("daemon status", () => {
    const temp = useTempDirectory();

    it("serializes transitions and never accepts unknown states", async () => {
        const filePath = temp.path("runtime", "status.json");
        let now = 1_000;
        const writer = new DaemonStatusWriter({
            filePath,
            pid: 123,
            nonce: "daemon-status-owner",
            now: () => now,
        });
        await writer.update({ t3: "connected", auth: "valid", environmentId: "env-1" });
        now = 2_000;
        await writer.update({ discord: "connected" });

        await expect(readDaemonStatus(filePath)).resolves.toEqual({
            version: 1,
            pid: 123,
            nonce: "daemon-status-owner",
            updatedAt: "1970-01-01T00:00:02.000Z",
            daemon: "running",
            t3: "connected",
            discord: "connected",
            auth: "valid",
            environmentId: "env-1",
        });
        expect(parseDaemonStatus(JSON.stringify({ ...writer.snapshot, t3: "invented" })))
            .toBeUndefined();
    });

    it("coalesces concurrent callers without corrupting the file", async () => {
        const filePath = temp.path("status.json");
        const writer = new DaemonStatusWriter({
            filePath,
            pid: 123,
            nonce: "serialized-status-owner",
        });
        await Promise.all([
            writer.update({ message: "first" }),
            writer.update({ message: "second" }),
            writer.update({ message: "last" }),
        ]);
        await writer.flush();

        await expect(readDaemonStatus(filePath)).resolves.toMatchObject({ message: "last" });
    });

    it("treats missing and malformed status as unavailable", async () => {
        await expect(readDaemonStatus(temp.path("missing.json"))).resolves.toBeUndefined();
        expect(parseDaemonStatus("not-json")).toBeUndefined();
        expect(parseDaemonStatus("{}")).toBeUndefined();
    });
});
