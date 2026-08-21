# Agent Note: /reload — the daemon restarting itself through a detached child

Status: implemented

English | [中文](2026-08-21-feishu-bridge-reload-command.zh.md)

## Problem

Making harness TS changes take effect on the feishu-bridge daemon requires running `reload.sh` (host build, `launchctl unload`/`load`, log rotation, WS-ready probe) from a plain terminal. The guard inside that script refuses any execution whose ancestry includes the daemon — restarting it would kill the script's own process tree before `launchctl load`, the 2026-08-20 outage. That guard is correct for agent sessions hosted by the daemon, but it also blocks the one spawn for which the tree-kill concern does not apply: the daemon itself deliberately restarting. There was no chat-side entry: every code change meant leaving the chat, opening a terminal, and remembering the two-step build-restart sequence.

## Decision

`src/engine/reload-commands.ts` adds a TS-native `/reload [--skip-build]` command (not a port of Go's D-class-cut `/restart`). The handler replies "started" first — `--skip-build` restarts the daemon within seconds, so a reply issued after the spawn would never arrive — then runs the script itself via `spawn('sh', [reload.sh, ...], { detached: true, stdio: ['ignore', logFd, logFd] })` plus `unref()`. The setsid detach is the load-bearing move: the script causes the daemon's death and must survive it, so it leaves the daemon's process group before causing that death.

The script self-locates through `resolveReloadScript(import.meta.url)`, probing the two real build layouts in order: `../../reload.sh` for the source/tsc layout (`src/engine/<file>`), `../reload.sh` for the tsdown bundle that `lib/index.js` is — the daemon's `main` inlines every engine module, so `import.meta.url` is the bundle file itself, and a single fixed relative hop resolved to `packages/acp/reload.sh`. The first real `/reload` after the manual restart failed with exactly that missing-script error; source-plane unit tests could not see it because the test layout matched the fixed hop. The live profile symlinks the package into the repo, so under either layout the daemon resolves the repo checkout's script.

`reload.sh` accepts `FB_RELOAD_FROM_DAEMON=1` as a bypass of the ppid-walk guard only. The walk would always see the live daemon as the detached child's ancestor and false-positive on exactly the safe case it approximates; the `DSH_SESSION_JSONL` guard stays un-bypassed, so an agent session that reaches for the variable manually is still refused. That split is honest about the guard's nature: it was never a security boundary (the sandbox already denies `ps`, and a bash child can unset its env), only a footgun shield.

`reload` joins `dir`/`monitor`/`shell` in `privilegedCommands` (admin gate). The resolver matches the exact word `reload` only: the family convention of ≥2-char prefix resolution would let `/re` and `/rel` shadow `/rename` and `/relay` in the chained resolver. A module-level in-flight flag refuses a second `/reload` while one runs (two interleaved unload/load sequences are 2026-08-20-outage-grade risk); script exit or spawn error clears it. Output appends to `$LOG_DIR/feishu-bridge-reload.log` (default `~/.dsh`), one timestamped header per run. When the script exits non-zero while the daemon is still alive — build failure, missing plist, spawn error — the exit listener replies the failure with the log path.

## Alternatives considered

**Reimplement the reload logic natively in the command handler.** Rejected: it would fork the build/restart/probe sequence into a second owner and drift from the terminal path; "same effect as reload.sh" is best guaranteed by running reload.sh.

**`launchctl kickstart -k` instead of unload/load.** Rejected: it restarts the service but owns none of the surrounding contract — the two-step build, log rotation, the unload→load restore trap, and the WS-ready probe all live in the script. Revisited as the fallback if smoke testing shows launchd killing the setsid child (see Consequences).

**Skip the reply-before-spawn ordering.** Rejected: with `--skip-build` the unload lands seconds after the spawn, and the confirmation message would be lost with the old process.

## Consequences

Admins trigger a full rebuild-restart from chat; mid-turn sessions still roll back to their last complete turn, exactly as the terminal flow — the started reply says so. The known ceiling: a failure that only appears after the daemon has restarted (e.g. the WS-ready probe timing out) cannot produce a chat reply, because the listener died with the old process; `feishu-bridge-reload.log` is the only record, and OPERATIONS.md §3.3 says so. The detach-survival assumption — launchd's teardown signals the job's process group, not a setsid child — is verified by real-device smoke; if it fails, the bot strands offline until a manual `launchctl load`, and `kickstart -k` is the recorded fallback. On Linux the script itself refuses (launchd check) and the failure reply surfaces that; the systemd flow stays manual.

## Testing

`tests/engine/reload-commands.spec.ts` (14 cases): registration merge/dispose, exact-match resolver (no `/re`/`/rel` shadowing), admin gate, unknown-argument usage, missing-script error, the spawn contract (argv, `detached`, guard-bypass env, reply-before-spawn ordering), `--skip-build` passthrough, in-flight refusal with recovery after failure, spawn-error flag clearing, silence on clean exit, and `resolveReloadScript` across both build layouts (the tsdown-bundle URL was the red test for the real-device failure) plus the miss fallback. `tests/reload-script.spec.ts` adds two: `FB_RELOAD_FROM_DAEMON=1` completes unload/load through the daemon-shaped-ancestor stub, and the same variable still hits the `DSH_SESSION_JSONL` refusal. The real restart is real-device smoke per MIGRATION.md (fast path, full build, double-run refusal, non-admin denial, build-failure reply).
