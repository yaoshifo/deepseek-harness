# Agent Note: reload.sh on Linux — systemctl restart with a journal WS probe

Status: implemented

English | [中文](2026-08-22-feishu-bridge-reload-linux.zh.md)

## Problem

reload.sh was macOS-launchd-only. On the Linux dev server (systemd user unit, OPERATIONS.md §5) the script exited 1 at the Darwin check before doing anything, so the chat-side `/reload` — whose handler spawns the script — failed there with an unhelpful "exit code 1" reply (real-device report 2026-08-22, group `oc_7e49044246b67ce4b5a64d0567a87d6a`); the actual "launchd is macOS-only" error only ever reached `feishu-bridge-reload.log`. Operators had to leave chat and run the §1.3 build plus `systemctl --user restart` manually — exactly the friction `/reload` exists to remove.

## Decision

reload.sh branches on `uname` around a common prefix (argument parsing, both refusal guards, host build). The Linux path prechecks `systemctl --user cat "$UNIT"` — fail loud before the build burns minutes, mirroring the plist check; `UNIT=${UNIT:-feishu-bridge}` parallels the `PLIST` override — restarts with a single `systemctl --user restart "$UNIT"`, then probes WS readiness from the journal: a stamp taken *after* restart returns (the old daemon is already stopped then, so a WS-reconnect line it emitted just before teardown cannot satisfy the probe), followed by up to 60 polls of `journalctl --user -u "$UNIT" --since "$stamp" | grep 'ws client ready'` at 0.5s. No restore trap and no log rotation: the systemctl restart is one atomic operation with no unload/load window (the trap exists solely for that window), and the journal keeps history across restarts.

The guards are unchanged and platform-independent: `DSH_SESSION_JSONL` (daemon-hosted agent sessions) and the ppid walk (manually started daemon), with `FB_RELOAD_FROM_DAEMON=1` still bypassing only the walk. The platform precheck sits *after* the guards so a refusal performs zero system interaction — a property the darwin suite already asserted against launchctl. The TS side (`reload-commands.ts`) keeps the build-restart-probe sequence solely in the script, but owns one platform decision the spawner must make: on Linux the `/reload` spawn wraps the script in `systemd-run --user --scope` because setsid cannot escape the unit cgroup ([cgroup note](../bug-fix/2026-08-22-feishu-bridge-reload-linux-cgroup.md)); the terminal path stays a plain `sh reload.sh`, unaffected.

## Alternatives considered

**Reimplement the Linux flow in the command handler (TS).** Rejected for the same reason as in the `/reload` note: two owners of the build-restart-probe sequence would drift; the script self-locates and serves both entries.

**`systemctl --user restart` without a WS probe.** Rejected: the macOS flow treats "WS ready" as the completion signal, and a build that compiles but breaks startup would otherwise look like success.

**A journal cursor instead of a wall-clock `--since` stamp.** Rejected: the post-restart stamp is sufficient (the old daemon cannot write past its stop) and far simpler; a clock rollback would have to coincide with the restart to matter.

## Consequences

`/reload` works on Linux deployments with an unchanged reply contract: failures before the restart (build error, missing unit) reply in chat, failures after it (probe timeout) are log-only — the documented ceiling. A probe timeout tails the last five journal lines into `feishu-bridge-reload.log` for diagnosis. `journalctl --user` needs the user bus (`XDG_RUNTIME_DIR`); the systemd unit sets it and a plain terminal has it.

## Testing

`tests/reload-script.spec.ts` gains a `reload.sh on Linux/systemd` suite (6 cases) running on darwin and linux by shadowing `uname`/`systemctl`/`journalctl`/`ps` on PATH (a no-op `sleep` stub lets the 60-iteration probe timeout exhaust in milliseconds): happy path (exactly `cat` + `restart`), `DSH_SESSION_JSONL` refusal with zero systemctl calls, missing-unit fail-loud, probe timeout, `FB_RELOAD_FROM_DAEMON=1` walk bypass, and that bypass still refusing daemon-hosted sessions. Real-device smoke per MIGRATION.md (terminal run on the dev server, then chat-side `/reload --skip-build`).
