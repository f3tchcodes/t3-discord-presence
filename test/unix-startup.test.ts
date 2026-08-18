import { describe, expect, it } from "vitest";

import {
    getLinuxStartupStatus,
    installLinuxStartup,
    LINUX_SYSTEMD_UNIT_NAME,
    type LinuxStartupOptions,
    quoteDesktopExecArgument,
    quoteSystemdExecArgument,
    renderLinuxAutostartDesktop,
    renderLinuxSystemdUnit,
    resolveLinuxStartupPaths,
    uninstallLinuxStartup,
} from "../src/startup/linux.js";
import {
    getMacosStartupStatus,
    installMacosStartup,
    MACOS_LAUNCH_AGENT_LABEL,
    type MacosStartupOptions,
    renderMacosLaunchAgentPlist,
    resolveMacosStartupPaths,
    uninstallMacosStartup,
} from "../src/startup/macos.js";
import {
    UNIX_STARTUP_OWNERSHIP_MARKER,
    type UnixCommandResult,
    type UnixCommandRunner,
    type UnixStartupFileSystem,
} from "../src/startup/unix.js";

interface CommandCall {
    readonly executable: string;
    readonly arguments_: ReadonlyArray<string>;
}

function result(exitCode = 0, stderr = ""): UnixCommandResult {
    return { exitCode, stdout: "", stderr };
}

function memoryFileSystem(initialFiles: Readonly<Record<string, string>> = {}): {
    readonly files: Map<string, string>;
    readonly directories: Array<string>;
    readonly removed: Array<string>;
    readonly adapter: UnixStartupFileSystem;
} {
    const files = new Map(Object.entries(initialFiles));
    const directories: Array<string> = [];
    const removed: Array<string> = [];
    return {
        files,
        directories,
        removed,
        adapter: {
            async ensureDirectory(directory) {
                directories.push(directory);
            },
            async readTextFile(filePath) {
                return files.get(filePath);
            },
            async writeTextFile(filePath, contents) {
                files.set(filePath, contents);
            },
            async removeFile(filePath) {
                removed.push(filePath);
                files.delete(filePath);
            },
        },
    };
}

function macosOptions(): MacosStartupOptions & { readonly nodeExecutable: string } {
    return {
        nodeExecutable: "/Applications/Node & Co/node",
        cliEntrypoint: '/Users/al ice/T3 "Discord"\\cli.js',
        daemonArguments: ["daemon", "--label=50% & ready"],
        paths: resolveMacosStartupPaths({
            homeDirectory: "/Users/al ice",
            logDirectory: "/Users/al ice/Library/Logs/T3 & Presence",
            launchctlExecutable: "/bin/launchctl",
        }),
        uid: 501,
    };
}

function renderMacosOptions(
    options: MacosStartupOptions & { readonly nodeExecutable: string },
): string {
    return renderMacosLaunchAgentPlist({
        nodeExecutable: options.nodeExecutable,
        cliEntrypoint: options.cliEntrypoint,
        ...(options.daemonArguments === undefined
            ? {}
            : { daemonArguments: options.daemonArguments }),
        standardOutPath: options.paths.standardOutPath,
        standardErrorPath: options.paths.standardErrorPath,
    });
}

function linuxOptions(): LinuxStartupOptions & { readonly nodeExecutable: string } {
    return {
        nodeExecutable: "/opt/Node & Co/node%bin",
        cliEntrypoint: '/home/al ice/T3 "Discord"\\cli.js',
        daemonArguments: ["daemon", "--dollar=$HOME", "--amp=&"],
        paths: resolveLinuxStartupPaths({
            homeDirectory: "/home/al ice",
            configHome: "/home/al ice/.config with spaces",
            systemctlExecutable: "/usr/bin/systemctl",
        }),
    };
}

describe("macOS startup", () => {
    it("renders a shell-free LaunchAgent with escaped arguments and crash restart", () => {
        const options = macosOptions();
        const plist = renderMacosOptions(options);

        expect(plist).toContain(`<!-- ${UNIX_STARTUP_OWNERSHIP_MARKER} -->`);
        expect(plist).toContain(`<string>${MACOS_LAUNCH_AGENT_LABEL}</string>`);
        expect(plist).toContain("<string>/Applications/Node &amp; Co/node</string>");
        expect(plist).toContain("<string>/Users/al ice/T3 &quot;Discord&quot;\\cli.js</string>");
        expect(plist).toContain("<string>--label=50% &amp; ready</string>");
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/u);
        expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
        expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/u);
        expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/Users\/al ice\/Library\/Logs\/T3 &amp; Presence\/launchd\.stdout\.log<\/string>/u);
        expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/Users\/al ice\/Library\/Logs\/T3 &amp; Presence\/launchd\.stderr\.log<\/string>/u);
        expect(plist).not.toContain("/bin/sh");
    });

    it("uses modern launchctl operations and repairs idempotently", async () => {
        const options = macosOptions();
        const memory = memoryFileSystem();
        const calls: Array<CommandCall> = [];
        let loaded = false;
        const runCommand: UnixCommandRunner = async (executable, arguments_) => {
            calls.push({ executable, arguments_ });
            if (arguments_[0] === "print") {
                return result(loaded ? 0 : 113);
            }
            if (arguments_[0] === "bootstrap") {
                loaded = true;
            }
            return result();
        };

        await expect(installMacosStartup(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toEqual({ installed: true, changed: true, loaded: true });
        expect(calls).toEqual([
            { executable: "/bin/launchctl", arguments_: ["print", "gui/501/com.f3tchcodes.t3-discord-presence"] },
            { executable: "/bin/launchctl", arguments_: ["bootstrap", "gui/501", options.paths.plistPath] },
            { executable: "/bin/launchctl", arguments_: ["enable", "gui/501/com.f3tchcodes.t3-discord-presence"] },
            { executable: "/bin/launchctl", arguments_: ["kickstart", "-k", "gui/501/com.f3tchcodes.t3-discord-presence"] },
        ]);
        expect(memory.directories).toContain(options.paths.logDirectory);

        calls.length = 0;
        await expect(installMacosStartup(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toEqual({ installed: true, changed: false, loaded: true });
        expect(calls.map(call => call.arguments_[0])).toEqual(["print", "enable", "kickstart"]);
        await expect(getMacosStartupStatus(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toMatchObject({
            installed: true,
            current: true,
            file: "current",
            registration: "loaded",
        });
    });

    it("bootouts a loaded LaunchAgent before replacing an owned outdated plist", async () => {
        const options = macosOptions();
        const memory = memoryFileSystem({
            [options.paths.plistPath]: `<!-- ${UNIX_STARTUP_OWNERSHIP_MARKER} -->\nold plist`,
        });
        const calls: Array<CommandCall> = [];

        await expect(installMacosStartup(options, {
            fileSystem: memory.adapter,
            runCommand: async (executable, arguments_) => {
                calls.push({ executable, arguments_ });
                return result();
            },
        })).resolves.toMatchObject({ changed: true, loaded: true });
        expect(calls.map(call => call.arguments_[0])).toEqual([
            "print",
            "bootout",
            "bootstrap",
            "enable",
            "kickstart",
        ]);
        expect(memory.files.get(options.paths.plistPath)).toBe(
            renderMacosOptions(options),
        );
    });

    it("unloads and removes only an owned LaunchAgent", async () => {
        const options = macosOptions();
        const foreign = memoryFileSystem({ [options.paths.plistPath]: "foreign plist" });
        const foreignCalls: Array<CommandCall> = [];
        await expect(uninstallMacosStartup(options, {
            fileSystem: foreign.adapter,
            runCommand: async (executable, arguments_) => {
                foreignCalls.push({ executable, arguments_ });
                return result();
            },
        })).resolves.toEqual({
            removed: false,
            unloaded: false,
            registrationConflict: true,
        });
        expect(foreign.files.get(options.paths.plistPath)).toBe("foreign plist");
        expect(foreignCalls).toEqual([]);

        const ownedPlist = renderMacosOptions(options);
        const owned = memoryFileSystem({ [options.paths.plistPath]: ownedPlist });
        const ownedCalls: Array<CommandCall> = [];
        await expect(uninstallMacosStartup(options, {
            fileSystem: owned.adapter,
            runCommand: async (executable, arguments_) => {
                ownedCalls.push({ executable, arguments_ });
                return result();
            },
        })).resolves.toEqual({
            removed: true,
            unloaded: true,
            registrationConflict: false,
        });
        expect(ownedCalls.map(call => call.arguments_[0])).toEqual(["print", "bootout"]);
        expect(owned.files.has(options.paths.plistPath)).toBe(false);
    });
});

describe("Linux startup renderers", () => {
    it("quotes systemd and Desktop Entry arguments for their separate grammars", () => {
        const systemdQuoted = quoteSystemdExecArgument('a "quote" \\ 50% $HOME &');
        expect(systemdQuoted).toContain('\\"quote\\"');
        expect(systemdQuoted).toContain("\\\\ 50%% $$HOME &");

        const desktopQuoted = quoteDesktopExecArgument('a "quote" \\ 50% $HOME &');
        expect(desktopQuoted).toContain('\\\\"quote\\\\"');
        expect(desktopQuoted).toContain("\\\\\\\\ 50%% \\\\$HOME &");
    });

    it("renders a default-target systemd service with on-failure restart", () => {
        const unit = renderLinuxSystemdUnit(linuxOptions());

        expect(unit).toContain(`# ${UNIX_STARTUP_OWNERSHIP_MARKER}`);
        expect(unit).toContain("Type=simple");
        expect(unit).toContain('ExecStart="/opt/Node & Co/node%%bin"');
        expect(unit).toContain('"/home/al ice/T3 \\"Discord\\"\\\\cli.js"');
        expect(unit).toContain('"--dollar=$$HOME"');
        expect(unit).toContain("Restart=on-failure");
        expect(unit).toContain("RestartSec=5s");
        expect(unit).toContain("WantedBy=default.target");
        expect(unit).not.toContain("/bin/sh");
    });

    it("renders a quiet XDG autostart fallback without field-code expansion", () => {
        const desktop = renderLinuxAutostartDesktop(linuxOptions());

        expect(desktop).toContain("[Desktop Entry]");
        expect(desktop).toContain("Exec=\"/opt/Node & Co/node%%bin\"");
        expect(desktop).toContain("Terminal=false");
        expect(desktop).toContain("NoDisplay=true");
        expect(desktop).toContain("X-GNOME-Autostart-enabled=true");
        expect(desktop).not.toContain("/bin/sh");
    });
});

describe("Linux startup installer", () => {
    it("prefers systemd --user and is idempotent", async () => {
        const options = linuxOptions();
        const memory = memoryFileSystem();
        const calls: Array<CommandCall> = [];
        let enabled = false;
        let active = false;
        const runCommand: UnixCommandRunner = async (executable, arguments_) => {
            calls.push({ executable, arguments_ });
            if (arguments_[1] === "show-environment") {
                return result();
            }
            if (arguments_[1] === "is-enabled") {
                return result(enabled ? 0 : 1);
            }
            if (arguments_[1] === "is-active") {
                return result(active ? 0 : 3);
            }
            if (arguments_[1] === "enable") {
                enabled = true;
                active = true;
            }
            return result();
        };

        await expect(installLinuxStartup(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toEqual({
            installed: true,
            mechanism: "systemd",
            changed: true,
            registrationConflict: false,
        });
        expect(memory.files.get(options.paths.unitPath)).toContain("ExecStart=");
        expect(memory.files.has(options.paths.desktopPath)).toBe(false);
        expect(calls).toContainEqual({
            executable: "/usr/bin/systemctl",
            arguments_: ["--user", "enable", "--now", LINUX_SYSTEMD_UNIT_NAME],
        });
        expect(calls.some(call => call.arguments_[1] === "daemon-reload")).toBe(true);

        calls.length = 0;
        await expect(installLinuxStartup(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toMatchObject({ changed: false, mechanism: "systemd" });
        expect(calls.some(call => call.arguments_[1] === "daemon-reload")).toBe(false);
        expect(calls.some(call => call.arguments_[1] === "enable")).toBe(true);
        await expect(getLinuxStartupStatus(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toMatchObject({
            installed: true,
            mechanism: "systemd",
            current: true,
            systemdAvailable: true,
            enabled: true,
            active: true,
        });
    });

    it("uses XDG autostart only when the systemd user manager is unavailable", async () => {
        const options = linuxOptions();
        const memory = memoryFileSystem();
        const calls: Array<CommandCall> = [];
        const runCommand: UnixCommandRunner = async (executable, arguments_) => {
            calls.push({ executable, arguments_ });
            return result(1, "no user bus");
        };

        await expect(installLinuxStartup(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).resolves.toEqual({
            installed: true,
            mechanism: "xdg-autostart",
            changed: true,
            registrationConflict: false,
        });
        expect(calls).toEqual([{
            executable: "/usr/bin/systemctl",
            arguments_: ["--user", "show-environment"],
        }]);
        expect(memory.files.get(options.paths.desktopPath)).toContain("[Desktop Entry]");
        expect(memory.files.has(options.paths.unitPath)).toBe(false);
    });

    it("reports a systemd install failure instead of silently falling back", async () => {
        const options = linuxOptions();
        const memory = memoryFileSystem();
        const runCommand: UnixCommandRunner = async (_executable, arguments_) => {
            if (arguments_[1] === "enable") {
                return result(1, "unit rejected");
            }
            return result();
        };

        await expect(installLinuxStartup(options, {
            fileSystem: memory.adapter,
            runCommand,
        })).rejects.toThrow("unable to enable the systemd user service: unit rejected");
        expect(memory.files.has(options.paths.desktopPath)).toBe(false);
    });

    it("disables and removes only owned Linux registrations", async () => {
        const options = linuxOptions();
        const owned = memoryFileSystem({
            [options.paths.unitPath]: renderLinuxSystemdUnit(options),
            [options.paths.desktopPath]: renderLinuxAutostartDesktop(options),
        });
        const calls: Array<CommandCall> = [];
        await expect(uninstallLinuxStartup(options, {
            fileSystem: owned.adapter,
            runCommand: async (executable, arguments_) => {
                calls.push({ executable, arguments_ });
                return result();
            },
        })).resolves.toEqual({
            unitRemoved: true,
            desktopRemoved: true,
            serviceDisabled: true,
            registrationConflict: false,
        });
        expect(calls.map(call => call.arguments_[1])).toEqual([
            "show-environment",
            "disable",
            "daemon-reload",
        ]);
        expect(owned.files.size).toBe(0);

        const foreign = memoryFileSystem({
            [options.paths.unitPath]: "[Unit]\nDescription=someone else's unit\n",
            [options.paths.desktopPath]: "[Desktop Entry]\nName=someone else's app\n",
        });
        const foreignCalls: Array<CommandCall> = [];
        await expect(uninstallLinuxStartup(options, {
            fileSystem: foreign.adapter,
            runCommand: async (executable, arguments_) => {
                foreignCalls.push({ executable, arguments_ });
                return result();
            },
        })).resolves.toEqual({
            unitRemoved: false,
            desktopRemoved: false,
            serviceDisabled: false,
            registrationConflict: true,
        });
        expect(foreignCalls).toEqual([]);
        expect(foreign.files.size).toBe(2);
    });
});
