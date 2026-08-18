import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";

function writer() {
    let value = "";
    return {
        stream: {
            write(chunk: string) {
                value += chunk;
                return true;
            },
        },
        value: () => value,
    };
}

describe("cli", () => {
    it("shows help without arguments", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli([], stdout.stream, stderr.stream)).resolves.toBe(0);
        expect(stdout.value()).toContain("t3-discord-presence <command>");
        expect(stderr.value()).toBe("");
    });

    it("rejects unknown commands", async () => {
        const stdout = writer();
        const stderr = writer();

        await expect(runCli(["wat"], stdout.stream, stderr.stream)).resolves.toBe(1);
        expect(stderr.value()).toContain("unknown command: wat");
    });
});
