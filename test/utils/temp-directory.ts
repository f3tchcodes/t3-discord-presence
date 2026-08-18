import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

export function useTempDirectory() {
    let directory = "";
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "t3-discord-presence-test-"));
    });
    afterEach(async () => {
        if (directory.length > 0) {
            await rm(directory, { force: true, recursive: true });
        }
    });
    return {
        path(...parts: ReadonlyArray<string>) {
            return join(directory, ...parts);
        },
    };
}
