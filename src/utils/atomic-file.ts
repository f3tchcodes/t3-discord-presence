import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface AtomicWriteOptions {
    readonly mode?: number;
    readonly directoryMode?: number;
}

const pendingWrites = new Map<string, Promise<void>>();

async function performAtomicWrite(
    filePath: string,
    contents: string | Uint8Array,
    options: AtomicWriteOptions,
): Promise<void> {
    const directory = dirname(filePath);
    const temporaryPath = join(
        directory,
        `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const mode = options.mode ?? 0o600;

    await mkdir(directory, {
        recursive: true,
        mode: options.directoryMode ?? 0o700,
    });

    let handle;
    try {
        handle = await open(temporaryPath, "wx", mode);
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, filePath);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function writeFileAtomic(
    filePath: string,
    contents: string | Uint8Array,
    options: AtomicWriteOptions = {},
): Promise<void> {
    const resolvedPath = resolve(filePath);
    const queueKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
    const previousWrite = pendingWrites.get(queueKey) ?? Promise.resolve();
    const operation = previousWrite
        .catch(() => undefined)
        .then(async () => {
            await performAtomicWrite(resolvedPath, contents, options);
        });
    const queueTail = operation.catch(() => undefined);
    pendingWrites.set(queueKey, queueTail);
    void queueTail.then(() => {
        if (pendingWrites.get(queueKey) === queueTail) {
            pendingWrites.delete(queueKey);
        }
    });
    return operation;
}
