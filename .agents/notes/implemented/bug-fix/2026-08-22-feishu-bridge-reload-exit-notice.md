# Agent Note: feishu-bridge engine stop was misreported as an agent process exit

Status: implemented

English | [中文](2026-08-22-feishu-bridge-reload-exit-notice.zh.md)

## Problem

Production incident 2026-08-22 10:48:44 (dev server): two spawned subtask groups (`oc_3ae1…` 飞书通知卡余额迁移, `oc_75dac…` dsh记忆与plan目录查询) each received "⚠️ Agent 进程意外退出，本轮已中断" — while the daemon process (pid 1945432) had been running unchanged since 10:04. A subtask agent had edited `~/.dsh/profiles/feishu-bridge/cordis.patch.yml` (adding `usageProviders` for its GLM balance task), the file Cordis HMR watches; 42 ms later the loader disposed and rebuilt the whole plugin tree. `engine.stop()` closed every in-flight turn's event channel without marking the state stopped, so `handleChannelClosed` classified the deliberate teardown as an unexpected exit and sent the crash wording. The wording points incident response at process crashes (exactly where this investigation first went) instead of at config reloads.

## Decision

`InteractiveState` gains an `engineStopped` flag (`packages/acp/feishu-bridge/src/engine/engine.ts`). `engine.stop()` sets it on every interactive state before closing its agent session; `handleChannelClosed` then sends the new `plugin_reloaded` message ("🔁 插件重载，本轮已中断。重新发送消息即可继续（上下文保留）。") instead of `agent_process_exited`. User-initiated stops stay silent and genuine agent crashes keep the crash wording, both unchanged.

## Alternatives considered

**Marking the state stopped in `engine.stop()` so the notice is suppressed entirely.** The turn would vanish with no explanation and no resend hint; users would resubmit blind. The interruption deserves a self-describing notice.

**Distinguishing an HMR reload from a process shutdown.** The loader's dispose reason is not observable at the engine seam, and both paths are deliberate teardowns with identical recovery (resend; context preserved). One wording covers both.

## Consequences

A deliberate teardown — HMR config reload or daemon stop — now self-describes as a plugin reload instead of a fake crash, and the recovery hint stays accurate. A full daemon stop also says "插件重载", which is loose for shutdown but carries the same recovery instruction. The flag must stay owned by `engine.stop()`: any other setter would silence real crash notices.

## Testing

`tests/engine/engine-events.spec.ts` → "engine stop reports the plugin reload instead of a process exit": a turn in flight while `engine.stop()` runs must emit the reload notice and not the exit notice. Red first (the exit notice was sent), then green with the implementation. No snapshot: the trigger is an in-process config reload, which the record-replay harness cannot inject; the engine-level suite is the coverage substitute (same documented gap as the 2026-08-21 stall-retry fix). engine-events 125, engine-stall-retry 2, i18n 11 green; tsc host/client clean; oxlint clean.
