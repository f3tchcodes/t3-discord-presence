# t3-discord-presence

[![npm](https://img.shields.io/npm/v/t3-discord-presence?logo=npm)](https://www.npmjs.com/package/t3-discord-presence)
[![CI](https://github.com/f3tchcodes/t3-discord-presence/actions/workflows/ci.yml/badge.svg)](https://github.com/f3tchcodes/t3-discord-presence/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
![AI](https://img.shields.io/badge/AI-informational-blue)

Discord Rich Presence for T3 Code. It runs quietly in the background, starts at login, and reconnects automatically when T3 Code or Discord returns.

## Install

Requirements: Node.js 22+, T3 Code Desktop, and Discord Desktop.

```sh
npm install -g t3-discord-presence
t3-discord-presence
```

That first run installs startup for the current user, authorizes with T3 when available, and starts one background daemon. Running it again safely repairs startup and never creates a duplicate daemon.

No Discord application setup, client ID, bot token, administrator access, or hardcoded T3 port is required.

After setup, the daemon:

- starts when you log in;
- waits quietly while T3 Code or Discord is closed;
- displays privacy-safe T3 activity in Discord;
- clears the presence when T3 closes;
- reconnects automatically when either application returns.

If T3 is closed on the first run, open it later and run `t3-discord-presence auth` if authorization remains pending.

## Commands

```sh
t3-discord-presence status
t3-discord-presence auth
t3-discord-presence start
t3-discord-presence stop
t3-discord-presence restart
t3-discord-presence doctor
t3-discord-presence logs
t3-discord-presence uninstall
```

Use `t3-discord-presence run --debug` for safe foreground diagnostics. Use `uninstall --purge` to also remove known credentials, configuration, logs, and transient state.

After updating the package, run it once to repair startup if the global installation path changed:

```sh
npm update -g t3-discord-presence
t3-discord-presence
```

## Authentication and privacy

The app discovers and verifies T3 Code's local runtime, uses T3's supported pairing flow, and requests only `orchestration:read`. The resulting credential is saved in the operating-system credential store when available, with a current-user-only file fallback. Pairing tokens and WebSocket tickets are never persisted.

Discord receives only selected project, model, provider, elapsed-time, and coarse activity fields. Thread titles are hidden by default. Raw prompts, messages, commands, terminal output, file contents, patches, absolute paths, RPC payloads, and credentials are never published.

Optional visibility settings live in the generated `config.json`:

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

## Startup support

- **Windows:** current-user Task Scheduler, with a per-user Startup-folder fallback.
- **macOS:** a user LaunchAgent. You may need to allow it under Login Items.
- **Linux:** a systemd user service, with an XDG autostart fallback.

These mechanisms require no root or administrator privileges and run without leaving a terminal window open.

## Troubleshooting

```sh
t3-discord-presence status
t3-discord-presence doctor
t3-discord-presence logs
```

- If Discord is waiting, start and sign in to Discord Desktop. Browser Discord does not support local Rich Presence.
- If T3 is waiting, open T3 Code. Closed applications are treated as normal and retried automatically.
- If authorization is required, open T3 Code and run `t3-discord-presence auth`.
- If the presence looks stale, run `t3-discord-presence restart`.
- If startup stops working after an update, rerun `t3-discord-presence`.

Do not share credential files when reporting an issue; use status output and the redacted logs.

## Development

```sh
npm ci
npm run check
npm run build
```

Unit tests never modify the machine's real startup configuration. Live read-only integration tests are opt-in with `T3_DISCORD_PRESENCE_INTEGRATION=1 npm run test:integration` (set the environment variable using PowerShell syntax on Windows).

## License

[MIT](LICENSE)
