# Agent Note: feishu-bridge reload.sh refuses daemon-hosted shells and self-restores

Status: implemented

English | [中文](2026-08-20-feishu-bridge-reload-daemon-guard.zh.md)

## Problem

reload.sh restarts the launchd daemon through `launchctl unload` + `launchctl load`. On 2026-08-20 an agent session hosted inside the daemon ran the script as the final step of a task: the unload SIGTERMed the daemon, whose teardown killed the script's own process tree between unload and load, and the LaunchAgent stayed unregistered — the bot was offline until someone re-loaded it manually. The script's existing guard — walk the ppid chain and refuse when an ancestor matches `bin.js --profile feishu-bridge` — never fired. Two environment facts explain the miss, both verified on the live daemon: the bash-tool sandbox denies `/bin/ps`, so the ppid walk dies on its first hop; and the sandbox rewrites the exported `XPC_SERVICE_NAME` to a literal `0` in every bash-tool child (the bash shell variable keeps the true label, the exported copy is clobbered), so a guard on the label cannot reach the script.

## Decision

The primary guard signal is `DSH_SESSION_JSONL`, which dsh exports into every bash-tool execution and whose path names the hosting daemon's session store: values under `${DSH_HOME}/feishu-bridge-sessions/` mean the shell runs inside the feishu-bridge daemon, and the script refuses with exit 1 before touching launchctl. A cc-connect-hosted session (store `cc-connect-sessions`) stays allowed — restarting the feishu-bridge daemon from there cannot kill the caller. The ppid walk remains as the fallback for a manually started daemon outside any dsh session. Second, the unload→load window is defended by a `restore` trap on EXIT/TERM/INT that re-loads the plist with retries (up to 10 attempts, 0.5 s apart): `launchctl load` immediately after `unload` can fail with an Input/output error while launchd settles the removal, and the dying daemon's teardown may TERM the script mid-restart.

## Alternatives considered

**XPC_SERVICE_NAME guard.** Rejected after live verification: the sandbox rewrites the exported value to `0` in every bash-tool child, daemon or not, so the label never reaches the script's environment.

**Refuse every dsh session (any `DSH_SESSION_ID`).** Rejected: it would also block the safe and useful cc-connect-hosted restart path; `DSH_SESSION_JSONL` discriminates precisely.

**`launchctl kickstart -k` instead of unload/load.** Rejected: it never unregisters the service (no offline window), but it also never re-reads the plist, so `EnvironmentVariables` edits would silently not apply.

## Consequences

Running reload.sh from inside a daemon-hosted session fails fast with a message naming the session store; the daemon is untouched. If the script still dies between unload and load (abort path or TERM kill), the trap re-loads the service, so the worst case is a short restart rather than an offline bot. Residual risk: SIGKILL inside the window cannot be caught and the service stays unloaded; the 3 s teardown grace makes that unlikely. Relocating the session store (config change away from `feishu-bridge-sessions`) would silently disable the primary guard — OPERATIONS.md §3.3 documents the signal.

## Testing

`tests/reload-script.spec.ts` runs the real script against stubbed launchctl/pgrep/ps (macOS-only, `describe.skipIf`): a daemon-store environment refuses with zero launchctl calls; a cc-connect-store environment proceeds unload→load; the ppid walk still refuses a daemon-shaped ancestor; the old-daemon abort path re-loads; a mid-restart SIGTERM re-loads; the plain-terminal happy path completes. Live verification on 2026-08-20: a daemon-hosted session ran `reload.sh --skip-build`, received the refusal (exit 1), and the daemon stayed up.
