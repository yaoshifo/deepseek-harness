# Agent Note: /reload on Linux died to the unit cgroup kill and reported a false failure

Status: implemented

English | [中文](2026-08-22-feishu-bridge-reload-linux-cgroup.zh.md)

## Problem

Real-device incident 2026-08-22 22:29 (dev server, chat `/reload`): the chat received "❌ Reload 失败（退出码 -1），daemon 未重启", yet the daemon had restarted successfully — `active (running)` from 22:29:19, `ws client ready` in the journal from 22:29:22, on the just-built artifacts. `feishu-bridge-reload.log` ended at `==> restarting daemon feishu-bridge (systemd)` with no probe output at all.

Root cause: Node's `spawn(detached: true)` only setsids the child on Linux — it stays a member of the `feishu-bridge.service` cgroup. `systemctl --user restart` defaults to `KillMode=control-group`, so the stop phase kills the whole cgroup, including the detached reload.sh and its systemctl client. The script died to SIGTERM (exit code null, mapped to -1) before the WS probe; the old daemon processed the child's `exit` event during its own teardown and fired the failure reply before dying. systemd completed the stop→start regardless, so the restart itself never failed — only the reporting did.

## Decision

`reloadSpawnArgv(platform, scriptPath, scriptArgs)` in `packages/acp/feishu-bridge/src/engine/reload-commands.ts` owns the one platform decision the spawner must make: on Linux `/reload` spawns `systemd-run --user --scope --collect sh <reload.sh> [args]` instead of `sh <reload.sh>`. A transient scope unit is a sibling of the daemon unit, outside its cgroup, so the control-group kill cannot reach the script; `systemd-run` waits for the command, keeping exit-code reporting unchanged. `--collect` garbage-collects the scope on exit, and no fixed `--unit` name means a leftover scope cannot collide with a later reload. macOS spawns `sh` directly as before — launchd teardown leaves a setsid child alone. The build-restart-probe sequence stays solely in reload.sh; the terminal path is unaffected.

## Alternatives considered

**`KillMode=process` on the daemon unit.** Rejected: it would orphan every unit child — the mcp-server processes among them — across restarts, trading a false failure report for a real leak.

**Self-rescue inside reload.sh.** Rejected: the script is already dead at the moment of the kill; only the spawn can leave the cgroup in time.

**Rewording the failure message ("daemon state unknown").** Rejected: it treats the symptom — the script still dies before the probe, the log still lacks the success record, and the -1 signal-death path stays indistinguishable from a spawn error.

## Consequences

The Linux `/reload` false-failure path is gone: the script survives the restart it triggers, runs the journal WS probe, and appends the full success sequence to `feishu-bridge-reload.log`. The reply contract is unchanged — a non-zero exit still only fires for failures before the restart (build error, missing unit, `systemd-run` spawn failure), where "daemon 未重启" is accurate. A Linux deployment without systemd-run fails the spawn with ENOENT and reports failure; such a deployment already fails the script's `systemctl --user cat` precheck loudly, so no fallback is warranted. Real-device smoke on the dev server confirms the scope survives the restart.

## Testing

`tests/engine/reload-commands.spec.ts`: a new `reloadSpawnArgv` suite asserts both platform shapes (linux → the systemd-run scope prefix; darwin → direct `sh`), and the two spawn-contract cases now assert through the mapping so they stay platform-agnostic. Red first: the mapping did not exist. reload-commands 18, reload-script 30 green; `tsc` clean.
