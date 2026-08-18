import { describe, expect, it } from "vitest";

import {
    getWindowsStartupStatus,
    installWindowsStartup,
    isOwnedWindowsStartupContent,
    quoteWindowsCommandLineArgument,
    renderWindowsCommandLine,
    renderWindowsLauncherVbs,
    renderWindowsTaskSchedulerXml,
    resolveWindowsStartupFolder,
    resolveWindowsStartupPaths,
    resolveWindowsUserId,
    uninstallWindowsStartup,
    WINDOWS_STARTUP_OWNERSHIP_MARKER,
    type WindowsCommandResult,
    type WindowsCommandRunner,
    type WindowsStartupFileSystem,
    type WindowsStartupOptions,
} from "../src/startup/windows.js";

function commandResult(
    exitCode: number,
    stdout = "",
    stderr = "",
): WindowsCommandResult {
    return { exitCode, stdout, stderr };
}

class MemoryFileSystem implements WindowsStartupFileSystem {
    readonly directories = new Set<string>();
    readonly files = new Map<string, string>();
    readonly writes: Array<string> = [];
    readonly removals: Array<string> = [];

    async ensureDirectory(directory: string): Promise<void> {
        this.directories.add(directory);
    }

    async readTextFile(filePath: string): Promise<string | undefined> {
        return this.files.get(filePath);
    }

    async writeTextFile(filePath: string, contents: string): Promise<void> {
        this.files.set(filePath, contents);
        this.writes.push(filePath);
    }

    async removeFile(filePath: string): Promise<void> {
        this.files.delete(filePath);
        this.removals.push(filePath);
    }
}

interface CapturedInvocation {
    readonly executable: string;
    readonly arguments: ReadonlyArray<string>;
}

class FakeTaskScheduler {
    readonly invocations: Array<CapturedInvocation> = [];
    taskXml: string | undefined = undefined;
    createFailure: string | undefined = undefined;

    constructor(private readonly fileSystem: MemoryFileSystem) {}

    readonly run: WindowsCommandRunner = async (executable, arguments_) => {
        this.invocations.push({ executable, arguments: [...arguments_] });
        const operation = arguments_[0];
        if (operation === "/Query") {
            return this.taskXml === undefined
                ? commandResult(1, "", "The system cannot find the file specified.")
                : commandResult(0, this.taskXml);
        }
        if (operation === "/Create") {
            if (this.createFailure !== undefined) {
                return commandResult(1, "", this.createFailure);
            }
            const xmlPath = arguments_[4];
            if (xmlPath === undefined) {
                throw new Error("test scheduler did not receive an XML path");
            }
            const taskXml = this.fileSystem.files.get(xmlPath);
            if (taskXml === undefined) {
                throw new Error("test scheduler could not read generated task XML");
            }
            this.taskXml = taskXml;
            return commandResult(0, "SUCCESS");
        }
        if (operation === "/Delete") {
            this.taskXml = undefined;
            return commandResult(0, "SUCCESS");
        }
        throw new Error(`unexpected Task Scheduler operation: ${operation ?? "missing"}`);
    };
}

const paths = resolveWindowsStartupPaths({
    appDirectory: "C:\\Users\\Ada Lovelace\\App & 100%\\t3-discord-presence",
    roamingAppDataDirectory: "C:\\Users\\Ada Lovelace\\AppData\\Roaming",
    windowsDirectory: "C:\\Windows",
});

function startupOptions(overrides: Partial<WindowsStartupOptions> = {}): WindowsStartupOptions {
    return {
        cliEntrypoint: "C:\\Program Files\\t3 presence\\dist\\cli.js",
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        paths,
        userId: "WORKGROUP\\Ada & Bob",
        ...overrides,
    };
}

describe("Windows command-line quoting", () => {
    it("quotes spaces, empty values, quotes, metacharacters, percent signs, and trailing slashes", () => {
        expect(quoteWindowsCommandLineArgument("")).toBe('""');
        expect(quoteWindowsCommandLineArgument("plain")).toBe('"plain"');
        expect(quoteWindowsCommandLineArgument("C:\\Program Files\\node.exe")).toBe(
            '"C:\\Program Files\\node.exe"',
        );
        expect(quoteWindowsCommandLineArgument('say "hello"')).toBe(
            '"say \\"hello\\""',
        );
        expect(quoteWindowsCommandLineArgument("C:\\ends-with-slash\\")).toBe(
            '"C:\\ends-with-slash\\\\"',
        );
        expect(quoteWindowsCommandLineArgument("fish & chips | 100% ^ safe")).toBe(
            '"fish & chips | 100% ^ safe"',
        );
        expect(quoteWindowsCommandLineArgument(`before${"\\".repeat(2)}"after`)).toBe(
            `"before${"\\".repeat(5)}"after"`,
        );
    });

    it("renders one direct-execution command line without introducing a command shell", () => {
        const commandLine = renderWindowsCommandLine(
            "C:\\Program Files\\nodejs\\node.exe",
            [
                "C:\\Users\\Ada & Bob\\t3 100%\\dist\\cli.js",
                "daemon",
                'value "with quotes" and \\slashes\\',
            ],
        );

        expect(commandLine).toContain('"C:\\Program Files\\nodejs\\node.exe"');
        expect(commandLine).toContain('"C:\\Users\\Ada & Bob\\t3 100%\\dist\\cli.js"');
        expect(commandLine).toContain("value \\\"with quotes\\\" and \\slashes\\\\");
        expect(commandLine.toLowerCase()).not.toContain("cmd.exe");
    });

    it("rejects line breaks instead of emitting an injectable launcher", () => {
        expect(() => quoteWindowsCommandLineArgument("safe\r\nunsafe")).toThrow("single line");
    });
});

describe("Windows startup renderers", () => {
    it("renders a hidden, waiting VBScript launcher with the exact Node and CLI paths", () => {
        const launcher = renderWindowsLauncherVbs({
            nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
            cliEntrypoint: "C:\\Apps & Tools\\t3 100%\\dist\\cli.js",
            daemonArguments: ["daemon", "--label", 'Ada "agent" \\'],
        });

        expect(launcher).toContain(`' ${WINDOWS_STARTUP_OWNERSHIP_MARKER}`);
        expect(launcher).toContain("C:\\Program Files\\nodejs\\node.exe");
        expect(launcher).toContain("C:\\Apps & Tools\\t3 100%\\dist\\cli.js");
        expect(launcher).toContain("shell.Run(");
        expect(launcher).toContain(", 0, True)");
        expect(launcher).toContain(
            `Ada \\${"\"".repeat(2)}agent\\${"\"".repeat(2)} ${"\\".repeat(2)}`,
        );
        expect(launcher.toLowerCase()).not.toContain("cmd.exe");
    });

    it("renders a least-privilege current-user ONLOGON task and XML-escapes values", () => {
        const xml = renderWindowsTaskSchedulerXml({
            launcherPath: 'C:\\Apps & 100%\\launch "daemon".vbs',
            scriptHostExecutable: "C:\\Win & Wow\\System32\\wscript.exe",
            workingDirectory: "C:\\Apps & 100%",
            taskName: "t3 presence & status",
            userId: "DOMAIN\\Ada & <Admin>",
            fingerprint: "a".repeat(64),
        });

        expect(xml).toContain("<LogonTrigger>");
        expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
        expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
        expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
        expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
        expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
        expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
        expect(xml).toContain("<Hidden>true</Hidden>");
        expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
        expect(xml.match(/<UserId>DOMAIN\\Ada &amp; &lt;Admin&gt;<\/UserId>/gu)).toHaveLength(2);
        expect(xml).toContain("DOMAIN\\Ada &amp; &lt;Admin&gt;");
        expect(xml).toContain("C:\\Win &amp; Wow\\System32\\wscript.exe");
        expect(xml).toContain("&quot;//B&quot; &quot;//NoLogo&quot;");
        expect(xml).not.toContain("<Admin>");
        expect(xml).toContain(`${WINDOWS_STARTUP_OWNERSHIP_MARKER}:${"a".repeat(64)}`);
    });

    it("resolves only stable absolute app, Startup-folder, and system executable paths", () => {
        expect(paths.managedDirectory).toBe(
            "C:\\Users\\Ada Lovelace\\App & 100%\\t3-discord-presence\\startup",
        );
        expect(paths.fallbackLauncherPath).toBe(
            "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\t3-discord-presence.vbs",
        );
        expect(paths.schedulerExecutable).toBe("C:\\Windows\\System32\\schtasks.exe");
        expect(paths.scriptHostExecutable).toBe("C:\\Windows\\System32\\wscript.exe");
        expect(() => resolveWindowsStartupPaths({
            appDirectory: "relative",
            roamingAppDataDirectory: "C:\\Users\\Ada\\AppData\\Roaming",
            windowsDirectory: "C:\\Windows",
        })).toThrow("absolute Windows path");
    });

    it("uses the Windows known-folder API result instead of assuming a localized path", async () => {
        const calls: Array<CapturedInvocation> = [];
        const startupFolder = await resolveWindowsStartupFolder("C:\\Windows", async (
            executable,
            arguments_,
        ) => {
            calls.push({ executable, arguments: arguments_ });
            return commandResult(0, "D:\\Profiles\\Ada\\Localized Startup\r\n");
        });

        expect(startupFolder).toBe("D:\\Profiles\\Ada\\Localized Startup");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.executable).toBe(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        );
        expect(calls[0]?.arguments).toContain("-NonInteractive");
        expect(resolveWindowsStartupPaths({
            appDirectory: "C:\\App",
            roamingAppDataDirectory: "C:\\Roaming",
            windowsDirectory: "C:\\Windows",
            startupFolder,
        }).startupFolder).toBe(startupFolder);
    });

    it("resolves the current account without ever requiring elevated credentials", () => {
        expect(resolveWindowsUserId({ USERDOMAIN: "LAPTOP", USERNAME: "ada" })).toBe(
            "LAPTOP\\ada",
        );
        expect(resolveWindowsUserId({ USERNAME: "ada" })).toBe("ada");
        expect(resolveWindowsUserId({})).toBeUndefined();
    });
});

describe("Windows startup adapters", () => {
    it("creates one current-user task with argument-array invocation and is idempotent", async () => {
        const fileSystem = new MemoryFileSystem();
        const scheduler = new FakeTaskScheduler(fileSystem);
        const options = startupOptions();

        const first = await installWindowsStartup(options, {
            fileSystem,
            runCommand: scheduler.run,
        });
        const second = await installWindowsStartup(options, {
            fileSystem,
            runCommand: scheduler.run,
        });

        expect(first).toMatchObject({
            installed: true,
            mechanism: "task-scheduler",
            changed: true,
            registrationConflict: false,
        });
        expect(second).toMatchObject({
            installed: true,
            mechanism: "task-scheduler",
            changed: false,
            registrationConflict: false,
        });
        expect(fileSystem.writes).toEqual([paths.launcherPath, paths.taskXmlPath]);
        expect(scheduler.invocations.filter(call => call.arguments[0] === "/Create")).toHaveLength(1);
        expect(scheduler.invocations[1]).toEqual({
            executable: paths.schedulerExecutable,
            arguments: [
                "/Create",
                "/TN",
                "t3-discord-presence",
                "/XML",
                paths.taskXmlPath,
                "/F",
            ],
        });
        expect(scheduler.taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
        expect(scheduler.taskXml).toContain("WORKGROUP\\Ada &amp; Bob");

        await expect(getWindowsStartupStatus(options, {
            fileSystem,
            runCommand: scheduler.run,
        })).resolves.toMatchObject({
            installed: true,
            mechanism: "task-scheduler",
            current: true,
            task: "current",
            fallback: "missing",
        });
    });

    it("replaces an outdated owned registration when the daemon command changes", async () => {
        const fileSystem = new MemoryFileSystem();
        const scheduler = new FakeTaskScheduler(fileSystem);
        const firstOptions = startupOptions();
        await installWindowsStartup(firstOptions, { fileSystem, runCommand: scheduler.run });
        const previousXml = scheduler.taskXml;

        const updated = await installWindowsStartup(
            startupOptions({ daemonArguments: ["daemon", "--debug"] }),
            { fileSystem, runCommand: scheduler.run },
        );

        expect(updated.mechanism).toBe("task-scheduler");
        expect(updated.changed).toBe(true);
        expect(scheduler.invocations.filter(call => call.arguments[0] === "/Create")).toHaveLength(2);
        expect(scheduler.taskXml).not.toBe(previousXml);
        expect(fileSystem.files.get(paths.launcherPath)).toContain("--debug");
    });

    it("uses the per-user Startup folder when Task Scheduler registration fails", async () => {
        const fileSystem = new MemoryFileSystem();
        const scheduler = new FakeTaskScheduler(fileSystem);
        scheduler.createFailure = "Access is denied.";
        const options = startupOptions();

        const installed = await installWindowsStartup(options, {
            fileSystem,
            runCommand: scheduler.run,
        });

        expect(installed).toMatchObject({
            installed: true,
            mechanism: "startup-folder",
            schedulerError: "Access is denied.",
            registrationConflict: false,
        });
        expect(fileSystem.directories).toContain(paths.startupFolder);
        expect(fileSystem.files.get(paths.fallbackLauncherPath)).toContain(
            WINDOWS_STARTUP_OWNERSHIP_MARKER,
        );
        await expect(getWindowsStartupStatus(options, {
            fileSystem,
            runCommand: scheduler.run,
        })).resolves.toMatchObject({
            installed: true,
            mechanism: "startup-folder",
            current: true,
            task: "missing",
            fallback: "current",
        });
    });

    it("does not replace a foreign same-named task and falls back without shell parsing", async () => {
        const fileSystem = new MemoryFileSystem();
        const scheduler = new FakeTaskScheduler(fileSystem);
        scheduler.taskXml = "<Task><Description>someone else's task</Description></Task>";

        const installed = await installWindowsStartup(startupOptions(), {
            fileSystem,
            runCommand: scheduler.run,
        });

        expect(installed).toMatchObject({
            installed: true,
            mechanism: "startup-folder",
            registrationConflict: true,
        });
        expect(scheduler.invocations.some(call => call.arguments[0] === "/Create")).toBe(false);
        expect(scheduler.taskXml).toBe(
            "<Task><Description>someone else's task</Description></Task>",
        );
    });

    it("uninstalls an owned task and only the exact files carrying its ownership marker", async () => {
        const fileSystem = new MemoryFileSystem();
        const scheduler = new FakeTaskScheduler(fileSystem);
        const options = startupOptions();
        await installWindowsStartup(options, { fileSystem, runCommand: scheduler.run });
        fileSystem.files.set("C:\\unrelated.vbs", "keep me");

        const removed = await uninstallWindowsStartup(options, {
            fileSystem,
            runCommand: scheduler.run,
        });

        expect(removed).toEqual({
            taskRemoved: true,
            fallbackRemoved: false,
            managedFilesRemoved: 2,
            registrationConflict: false,
        });
        expect(scheduler.invocations.filter(call => call.arguments[0] === "/Delete")).toHaveLength(1);
        expect(fileSystem.files.has(paths.launcherPath)).toBe(false);
        expect(fileSystem.files.has(paths.taskXmlPath)).toBe(false);
        expect(fileSystem.files.get("C:\\unrelated.vbs")).toBe("keep me");
    });

    it("never deletes a foreign task or foreign file at an app registration name", async () => {
        const fileSystem = new MemoryFileSystem();
        const scheduler = new FakeTaskScheduler(fileSystem);
        scheduler.taskXml = "<Task><Description>foreign</Description></Task>";
        fileSystem.files.set(paths.launcherPath, `' ${WINDOWS_STARTUP_OWNERSHIP_MARKER}\r\nowned`);
        fileSystem.files.set(paths.taskXmlPath, `<!-- ${WINDOWS_STARTUP_OWNERSHIP_MARKER} -->`);
        fileSystem.files.set(paths.fallbackLauncherPath, "foreign Startup script");

        const removed = await uninstallWindowsStartup(startupOptions(), {
            fileSystem,
            runCommand: scheduler.run,
        });

        expect(removed).toEqual({
            taskRemoved: false,
            fallbackRemoved: false,
            managedFilesRemoved: 2,
            registrationConflict: true,
        });
        expect(scheduler.invocations.some(call => call.arguments[0] === "/Delete")).toBe(false);
        expect(scheduler.taskXml).toBe("<Task><Description>foreign</Description></Task>");
        expect(fileSystem.files.get(paths.fallbackLauncherPath)).toBe("foreign Startup script");
    });

    it("still removes owned fallback files when Task Scheduler is unavailable", async () => {
        const fileSystem = new MemoryFileSystem();
        fileSystem.files.set(paths.fallbackLauncherPath, `' ${WINDOWS_STARTUP_OWNERSHIP_MARKER}`);
        fileSystem.files.set(paths.launcherPath, `' ${WINDOWS_STARTUP_OWNERSHIP_MARKER}`);
        fileSystem.files.set(paths.taskXmlPath, `<!-- ${WINDOWS_STARTUP_OWNERSHIP_MARKER} -->`);

        const removed = await uninstallWindowsStartup(startupOptions(), {
            fileSystem,
            runCommand: async () => {
                throw new Error("Task Scheduler service unavailable");
            },
        });

        expect(removed).toEqual({
            taskRemoved: false,
            fallbackRemoved: true,
            managedFilesRemoved: 2,
            registrationConflict: false,
            schedulerError: "Task Scheduler service unavailable",
        });
    });

    it("recognizes only explicit app-owned content", () => {
        expect(isOwnedWindowsStartupContent(`' ${WINDOWS_STARTUP_OWNERSHIP_MARKER}`)).toBe(true);
        expect(isOwnedWindowsStartupContent("t3-discord-presence")).toBe(false);
    });
});
