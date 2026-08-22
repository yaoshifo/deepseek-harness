# Agent Note: feishu-bridge engine stop was misreported as an agent process exit

Status: implemented

English | [中文](2026-08-22-feishu-bridge-reload-exit-notice.zh.md)

## Problem

Production incidents 2026-08-22 (dev server). 10:48:44: two spawned subtask groups (`oc_3ae1…` 飞书通知卡余额迁移, `oc_75dac…` dsh记忆与plan目录查询) each received "⚠️ Agent 进程意外退出，本轮已中断" — while the daemon process (pid 1945432) had been running unchanged since 10:04. A subtask agent had edited `~/.dsh/profiles/feishu-bridge/cordis.patch.yml` (adding `usageProviders` for its GLM balance task), the file Cordis HMR watches; 42 ms later the loader disposed and rebuilt the whole plugin tree. `engine.stop()` closed every in-flight turn's event channel without marking the state stopped, so `handleChannelClosed` classified the deliberate teardown as an unexpected exit and sent the crash wording. 11:49:08: the 教学驴 group `oc_610e…` froze mid-plan-submission with no message at all — a delayed `systemctl restart` (scheduled by that same GLM-balance agent to deploy its fix) stopped the daemon while the group's `exit_plan_mode` tool call was in flight; the turn ended `interrupted`, its event loop never resumed before process exit, and nothing was sent. Both outcomes point incident response at the wrong layer.

## Decision

`InteractiveState` gains `engineStopped` and `stopNoticeSent` flags (`packages/acp/feishu-bridge/src/engine/engine.ts`). `engine.stop()` directly sends the new `plugin_reloaded` message ("🔁 插件重载，本轮已中断。重新发送消息即可继续（上下文保留）。") to every chat with an in-flight turn (`activeTurns > 0`) before closing anything — the turn's event loop may never resume before process exit, so the notice must not depend on it. The loop-side `handleChannelClosed` path keeps sending the same message when the loop does drain (channel closed without the direct notice), and `stopNoticeSent` prevents the two paths from double-sending. User-initiated stops stay silent and genuine agent crashes keep the crash wording, both unchanged.

## Alternatives considered

**Marking the state stopped in `engine.stop()` so the notice is suppressed entirely.** The turn would vanish with no explanation and no resend hint; users would resubmit blind. The interruption deserves a self-describing notice.

**Distinguishing an HMR reload from a process shutdown.** The loader's dispose reason is not observable at the engine seam, and both paths are deliberate teardowns with identical recovery (resend; context preserved). One wording covers both.

## Consequences

A deliberate teardown — HMR config reload or daemon stop — now self-describes as a plugin reload instead of a fake crash or a silent freeze, and the recovery hint stays accurate. A full daemon stop also says "插件重载", which is loose for shutdown but carries the same recovery instruction. The flags must stay owned by the stop path: any other setter would silence real crash notices. Queued (not in-flight) messages dropped by a stop still go unannounced — `notifyDroppedQueuedMessages` only runs from loop-driven teardown paths.

## Testing

`tests/engine/engine-events.spec.ts` → "engine stop reports the plugin reload instead of a process exit" (loop drains the channel close: reload notice, not exit notice), "engine stop notifies an in-flight turn directly" (no loop runs at all — the stop itself must send the notice; this is the oc_610e shape, red first with nothing sent), and "engine stop notifies an in-flight turn once even when the loop also drains the close" (no double send). No snapshot: the trigger is an in-process reload or shutdown, which the record-replay harness cannot inject; the engine-level suite is the coverage substitute (same documented gap as the 2026-08-21 stall-retry fix). engine-events 127, engine-stall-retry 2, i18n 11 green; tsc host/client clean; oxlint clean.
