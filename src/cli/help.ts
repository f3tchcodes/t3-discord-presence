export const commandNames = [
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "auth",
    "doctor",
    "logs",
    "run",
] as const;

export const helpText = `t3-discord-presence

Discord Rich Presence for T3 Code agent activity.

usage:
  t3-discord-presence [command] [options]

Run without a command for first-time setup or to repair login startup and ensure the daemon is running.

commands:
  install      explicitly run the same idempotent first-time setup
  uninstall    stop the daemon and remove login startup
  start        start the background daemon
  stop         stop the background daemon
  restart      restart the background daemon
  status       show daemon and connection status
  auth         authorize against the local T3 environment
  doctor       check the local setup
  logs         print the log file location
  run          run in the foreground (add --debug for diagnostics)

internal:
  daemon       login-service entrypoint; not needed for normal use

options:
  --purge      with uninstall, also remove this app's config and credentials
  --debug      with run, enable privacy-safe debug logging
  -h, --help   show help
  -v, --version show the installed version
`;
