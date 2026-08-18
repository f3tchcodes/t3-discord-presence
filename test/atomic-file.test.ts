import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic } from "../src/utils/atomic-file.js";

const temporaryDirectories: Array<string> = [];

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "t3-presence-atomic-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async directory => {
        await rm(directory, { recursive: true, force: true });
    }));
});

describe("writeFileAtomic", () => {
    it("creates parent directories and writes a complete file", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "nested", "state.json");

        await writeFileAtomic(filePath, "first");

        await expect(readFile(filePath, "utf8")).resolves.toBe("first");
        await expect(readdir(join(root, "nested"))).resolves.toEqual(["state.json"]);
    });

    it("atomically replaces an existing file", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "state.json");
        await writeFileAtomic(filePath, "old value");

        await writeFileAtomic(filePath, new TextEncoder().encode("new value"));

        await expect(readFile(filePath, "utf8")).resolves.toBe("new value");
        await expect(readdir(root)).resolves.toEqual(["state.json"]);
    });

    it("leaves a complete result during concurrent replacements", async () => {
        const root = await temporaryDirectory();
        const filePath = join(root, "state.json");
        const candidates = Array.from({ length: 20 }, (_, index) => `${index}`.repeat(1_000));

        await Promise.all(candidates.map(async candidate => {
            await writeFileAtomic(filePath, candidate);
        }));

        expect(candidates).toContain(await readFile(filePath, "utf8"));
        await expect(readdir(root)).resolves.toEqual(["state.json"]);
    });

    it("cleans up its temporary file when replacement fails", async () => {
        const root = await temporaryDirectory();
        const targetDirectory = join(root, "occupied");
        await mkdir(targetDirectory);

        await expect(writeFileAtomic(targetDirectory, "value")).rejects.toBeDefined();

        await expect(readdir(root)).resolves.toEqual(["occupied"]);
    });
});
