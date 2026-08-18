import { readFile } from "node:fs/promises";

import { commandNames, helpText } from "./help.js";

interface PackageMetadata {
    readonly version: string;
}

async function readVersion(): Promise<string> {
    const packageUrl = new URL("../../package.json", import.meta.url);
    const value: unknown = JSON.parse(await readFile(packageUrl, "utf8"));
    if (
        typeof value !== "object"
        || value === null
        || !("version" in value)
        || typeof value.version !== "string"
    ) {
        throw new Error("package version is missing");
    }
    return (value as PackageMetadata).version;
}

export async function runCli(
    args: ReadonlyArray<string>,
    output: Pick<NodeJS.WriteStream, "write"> = process.stdout,
    errorOutput: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): Promise<number> {
    const command = args[0];
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
        output.write(helpText);
        return 0;
    }
    if (command === "--version" || command === "-v") {
        output.write(`${await readVersion()}\n`);
        return 0;
    }
    if ((commandNames as ReadonlyArray<string>).includes(command)) {
        errorOutput.write(`${command} is not available yet\n`);
        return 1;
    }
    errorOutput.write(`unknown command: ${command}\n\n${helpText}`);
    return 1;
}
