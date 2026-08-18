# t3-discord-presence

`t3-discord-presence` is a small background daemon that shows current T3 Code agent activity as Discord Rich Presence. It starts at user login, waits quietly while T3 Code or Discord is closed, and reconnects when either application returns.

It does not modify or inject into T3 Code, inspect the screen, or read process memory. It discovers T3 Code's loopback server, authenticates through T3's supported pairing flow with read-only access, subscribes to the local state API, reduces that state to privacy-safe labels, and sends the result to the Discord desktop application's local RPC interface.

## Requirements

- Node.js 22 or newer. The Node.js 22 and 24 LTS lines are tested in CI.
- T3 Code Desktop. For first-time authorization, the app automatically uses the CLI bundled with the verified Desktop installation, then falls back to a supported global `t3` command.
- Discord Desktop running whenever you want Rich Presence to appear. Discord in a browser is not sufficient.
- Windows, macOS, or Linux. Startup is installed for the current user and does not require root or administrator access under normal conditions.

## Install

Install the package globally, then run it once:

```sh
npm install -g t3-discord-presence
t3-discord-presence
```

That is the complete setup. The package includes the public Discord Application ID `1539247632227246150`, so there is no Discord Developer Portal setup, client-ID environment variable, bot token, or client secret to configure.

Running `t3-discord-presence` without a command is idempotent. It installs or repairs startup for the current user, attempts initial authorization when T3 Code is open, and ensures the daemon is running. Repeating it does not create another startup registration or daemon process. The explicit `t3-discord-presence install` command performs the same setup and remains available for scripts.

If T3 Code is closed during setup, the command still succeeds. The daemon starts in the background, waits quietly, and automatically connects when T3 Code and Discord Desktop become available. Open T3 Code and run `t3-discord-presence auth` later if authorization is still pending.

After the first run, it starts automatically when you log in, waits quietly for T3 Code, updates Discord Rich Presence when T3 is active, clears the presence when T3 closes, and reconnects whenever T3 Code or Discord Desktop returns.

The generated `config.json` contains optional privacy and image settings only. For example, project names and thread titles can be hidden or shown without changing the built-in Discord application:

```json
{
    "presence": {
        "showProject": true,
        "showThread": false,
        "showModel": true,
        "showProvider": true,
        "showElapsedTime": true
    },
    "discord": {}
}
```

## Authentication

To authorize explicitly, open T3 Code and run:

```sh
t3-discord-presence auth
```

The command asks the official local T3 CLI for a short-lived pairing credential, preferring the verified T3 Desktop installation and falling back to a supported global CLI. It exchanges that credential with the verified local T3 server and requests only the `orchestration:read` scope. The resulting access credential is stored per T3 environment in the operating-system credential store when available. A current-user-only app state file is used as a restrictive fallback.

If automatic pairing is unavailable, `auth` can prompt in an interactive terminal for the `Token` produced by `t3 pair --label "t3 discord presence"`. Input is hidden. That one-time pairing value is exchanged immediately and is never persisted; only the scoped bearer credential is stored. The login daemon never prompts for input.

Pairing credentials and WebSocket tickets are short-lived and are not persisted. Access credentials are never printed, logged, or sent to Discord. When a credential expires or is rejected, run `auth` again.

## Daily use

The login daemon should require no attention. These commands are available when needed:

```sh
t3-discord-presence status
t3-discord-presence start
t3-discord-presence stop
t3-discord-presence restart
t3-discord-presence doctor
t3-discord-presence logs
```

`status` reports startup registration, daemon, T3, Discord, and authorization state without revealing secrets. `doctor` checks the local prerequisites and explains common setup failures. `logs` prints the path to the bounded, rotated JSONL daemon log.

Running in the foreground is useful while diagnosing a changing T3 protocol:

```sh
t3-discord-presence run --debug
```

Debug logging includes safe event classifications and connection state, not raw payloads or private content.

## Background startup

- **Windows:** installs a current-user Task Scheduler task triggered at logon. It launches the exact Node executable and installed CLI through a hidden launcher. If Task Scheduler registration is unavailable, it falls back to a launcher in the current user's Startup folder.
- **macOS:** installs `~/Library/LaunchAgents/com.f3tchcodes.t3-discord-presence.plist` and loads it with modern `launchctl` user-domain commands. Recent macOS versions may show it under Login Items / Allow in the Background; allow it there if macOS disables it.
- **Linux:** installs and enables a `systemd --user` service. If a user systemd manager is unavailable, it falls back to an XDG autostart desktop entry.

All mechanisms run the actual globally installed Node executable and compiled entry point rather than relying on an interactive shell's `PATH`.

After updating the global package, run the command again so it can repair a registration whose installed path changed:

```sh
npm update -g t3-discord-presence
t3-discord-presence
```

## Privacy

The default Discord activity can include the project name, model, provider, elapsed time, a coarse activity label, and a deterministic active-agent count. Thread titles are hidden by default. Set any of the five `presence` options in the config example to `false` to hide that field; in particular, set `showProject` to `false` to hide project names.

The daemon never persists or publishes to Discord:

- raw prompts, chat messages, or response text;
- raw commands, terminal output, or tool arguments;
- file contents, patches, or diffs;
- workspace roots, current working directories, or other absolute paths;
- full T3 activities, thread objects, or raw RPC payloads.

Activities are mapped to a small allowlist such as `editing code`, `thinking`, `running commands`, or `waiting for input`; unknown activities become a generic label. Authentication secrets are the one intentional private value retained for reconnects: access credentials are kept in the OS credential store or restricted fallback file, but never included in presence, status output, or logs. Logs are size-bounded, rotated, and redact secret-shaped values and sensitive metadata.

There is no screen capture, process-memory inspection, T3 database scraping, or intermediary service operated by this project. Network communication is limited to T3's authenticated loopback backend and the local Discord RPC client; Discord itself receives only the filtered presence fields described above.

## Uninstall

Stop the daemon and remove only this application's startup registration:

```sh
t3-discord-presence uninstall
```

Normal uninstall preserves this app's config and stored authorization so reinstalling does not require setup again. To also remove this app's config, credentials, logs, and transient state, use:

```sh
t3-discord-presence uninstall --purge
```

Neither form removes or changes T3 Code data. `--purge` applies only to `t3-discord-presence` files and credentials. It removes fallback-file credentials plus operating-system credential entries for currently known T3 environments. Because operating-system keyrings do not provide a portable way to enumerate a service's historical entries, an entry for an old environment that is no longer present in app state or discoverable may need to be removed through the OS credential manager.

## Troubleshooting

Start with:

```sh
t3-discord-presence status
t3-discord-presence doctor
t3-discord-presence logs
```

- **Discord is waiting or disconnected:** start Discord Desktop and sign in. The daemon retries automatically. Optional invalid image keys are retried without images, so they cannot prevent presence updates.
- **T3 is waiting:** open T3 Code. Stale runtime files and servers whose PID, origin, or environment descriptor cannot be verified are deliberately ignored. For a nonstandard development installation, set `T3CODE_HOME` to the relevant T3 base directory before starting the daemon.
- **Authorization is required:** ensure T3 Code is open, then run `t3-discord-presence auth`. It checks T3 Desktop's bundled CLI and then a supported global `t3` command automatically. If neither can pair automatically, run `t3 pair --label "t3 discord presence"` and paste its `Token` into the hidden prompt. Run `restart` afterward if the daemon does not reconnect immediately.
- **Presence looks stale:** `restart` safely replaces the one daemon instance and republishes current state. Rapid T3 events are deliberately debounced.
- **Startup does not run after login:** rerun `t3-discord-presence`, inspect `doctor`, and check the platform-specific login mechanism described above. On macOS, also check Allow in the Background.

Do not post the contents of credential files when opening an issue. Status and redacted logs are the appropriate diagnostics.

## Development

```sh
npm ci
npm run check
npm run build
npm run dev
```

`npm run check` runs ESLint, TypeScript type checking, and the unit test suite. Unit tests use mocks and pure startup renderers; they do not install login services or require T3 Code or Discord.

Read-only integration tests are explicitly gated because they connect to a real local T3 environment. They never send agent commands or modify projects or threads. On macOS/Linux:

```sh
T3_DISCORD_PRESENCE_INTEGRATION=1 npm run test:integration
```

In PowerShell:

```powershell
$env:T3_DISCORD_PRESENCE_INTEGRATION="1"; npm run test:integration
```

Normal CI runs only `npm ci`, `npm run check`, and `npm run build`; it needs neither T3 Code nor Discord and does not publish packages.

## License

MIT
