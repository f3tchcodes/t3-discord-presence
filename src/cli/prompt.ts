import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export interface SecretPromptOptions {
    readonly prompt: string;
    readonly input?: NodeJS.ReadStream;
    readonly output?: NodeJS.WriteStream;
}

export async function promptForSecret(
    options: SecretPromptOptions,
): Promise<string | undefined> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stderr;
    if (!input.isTTY || !output.isTTY) return undefined;

    output.write(options.prompt);
    const mutedOutput = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    const readline = createInterface({
        input,
        output: mutedOutput,
        terminal: true,
    });
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: string | undefined) => {
            if (settled) return;
            settled = true;
            readline.close();
            output.write("\n");
            resolve(value);
        };
        readline.once("SIGINT", () => finish(undefined));
        readline.once("close", () => finish(undefined));
        readline.question("", answer => {
            const trimmed = answer.trim();
            finish(trimmed === "" ? undefined : trimmed);
        });
    });
}
