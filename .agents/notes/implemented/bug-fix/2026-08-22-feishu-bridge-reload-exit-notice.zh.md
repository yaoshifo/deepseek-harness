# Agent Note: feishu-bridge 引擎停止被误报为 Agent 进程意外退出

Status: implemented

[English](2026-08-22-feishu-bridge-reload-exit-notice.md) | 中文

## Problem

生产事故 2026-08-22（Dev 服务器）两起。10:48:44：两个派生子任务群（`oc_3ae1…` 飞书通知卡余额迁移、`oc_75dac…` dsh记忆与plan目录查询）各自收到「⚠️ Agent 进程意外退出，本轮已中断」——而 daemon 进程（pid 1945432）自 10:04 起从未退出。一个子任务 agent 编辑了 `~/.dsh/profiles/feishu-bridge/cordis.patch.yml`（为其 GLM 余额任务添加 `usageProviders`），该文件正是 Cordis HMR 监视的配置；42 毫秒后 loader dispose 并重建了整个插件树。`engine.stop()` 关闭每个运行中 turn 的事件 channel 时没有把 state 标记为 stopped，`handleChannelClosed` 于是把这次有意的拆除判定为意外退出并发出了崩溃文案。11:49:08：教学驴群 `oc_610e…` 在提交 plan 审批卡途中整体冻住、一条消息都没有——同一个 GLM 余额 agent 为部署自己的修复调度了延时 `systemctl restart`，daemon 停止时该群的 `exit_plan_mode` 工具调用正在执行；turn 以 `interrupted` 结束，其事件循环在进程退出前再未运行，什么都没发出去。两种结果都把事故响应引向错误的层面。

## Decision

`InteractiveState` 新增 `engineStopped` 与 `stopNoticeSent` 标志（`packages/acp/feishu-bridge/src/engine/engine.ts`）。`engine.stop()` 在关闭任何东西之前，直接向每个有运行中 turn（`activeTurns > 0`）的群发送新的 `plugin_reloaded` 消息（「🔁 插件重载，本轮已中断。重新发送消息即可继续（上下文保留）。」）——turn 的事件循环在进程退出前可能再也不会运行，通知不能依赖它。循环侧的 `handleChannelClosed` 路径在循环确实排空（channel 关闭且未发过直发通知）时仍发同一消息，`stopNoticeSent` 防止两条路径重复发送。用户主动停止保持静默、真正的 agent 崩溃保持崩溃文案，两者均不变。

## Alternatives considered

**在 `engine.stop()` 里把 state 标记为 stopped，让通知完全消失。** turn 会无解释地蒸发，也没有重发提示；用户只能盲目重发。被打断的 turn 值得一条自述性的通知。

**区分 HMR 重载与进程关闭。** loader 的 dispose 原因在 engine 这一接缝上不可观测，且两条路径都是有意的拆除、恢复方式相同（重发即继续，上下文保留）。一条文案覆盖两者。

## Consequences

有意的拆除——HMR 配置重载或 daemon 停止——现在自述为插件重载，不再是伪造的崩溃或无声冻结，恢复提示保持准确。daemon 整体停止也会说「插件重载」，对关闭场景措辞偏松，但恢复指引相同。两个标志必须保持只由停止路径置位：任何其他置位点都会静默吞掉真实的崩溃通知。停止时被丢弃的排队（非运行中）消息仍然没有通知——`notifyDroppedQueuedMessages` 只在循环驱动的拆除路径上运行。

## Testing

`tests/engine/engine-events.spec.ts` → "engine stop reports the plugin reload instead of a process exit"（循环排空 channel 关闭：发重载通知而非退出通知）、"engine stop notifies an in-flight turn directly"（完全没有循环运行——stop 本身必须发出通知；即 oc_610e 事故形态，先红：什么都没发）、"engine stop notifies an in-flight turn once even when the loop also drains the close"（不重复发送）。无快照：触发条件是进程内重载或关闭，录制回放 harness 无法注入；engine 级套件作为覆盖替身（与 2026-08-21 stall-retry 修复记录在案的缺口相同）。engine-events 127、engine-stall-retry 2、i18n 11 全绿；tsc host/client 干净；oxlint 干净。
