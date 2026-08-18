import { describe, expect, it } from "vitest";

import { DISCORD_APPLICATION_ID } from "../src/discord/application.js";

describe("Discord application", () => {
    it("uses the built-in public application ID", () => {
        expect(DISCORD_APPLICATION_ID).toBe("1539247632227246150");
    });
});
