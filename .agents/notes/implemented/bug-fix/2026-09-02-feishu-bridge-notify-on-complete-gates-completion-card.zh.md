# Agent Note: feishu-bridge notifyOnComplete 门禁完成通知卡

Status: implemented

[English](2026-09-02-feishu-bridge-notify-on-complete-gates-completion-card.md) | 中文

## Problem

`projects[].feishu.notifyOnComplete`（Go `notify_on_complete`，FEATURE-PARITY #2）在文档中是 ✅ 完成通知的开关，M2 也确实如此实现：纯文本 `CompletionNotifier` 路径回复前检查它。M7-b 在卡片平台用紫色状态页脚卡（`sendTurnCompletionCard` 经 `sendCardWithHandle`）替换了该路径，却没有继承检查。`FeishuPlatform` 结构上恒有 `sendCardWithHandle`，引擎的卡片分支因此无条件执行，`sendCompletionNotification` 内部的门禁变得不可达——该配置键在所有飞书部署上是死配置，而 OPERATIONS.md §2 与 FEATURE-PARITY #2 仍声称它有效；也没有任何配置能关掉每轮的 ✅ 卡。

## Decision

`sendTurnCompletionCard` 在任何页脚计算之前先查询新的可选平台能力 `CompletionNoticePreference.completionNoticeEnabled()`：实现了该能力并报告 disabled 的平台跳过紫色卡与文本回退两路。`FeishuPlatform.completionNoticeEnabled()` 返回 `notifyOnComplete`，因此 `notifyOnComplete: false`——或缺省，该键保持 Go 对齐的 opt-in——即可按 bot 静音 ✅ 卡。探针与所有 `as*` 能力检查一样是 opt-in：没有该方法的平台保持无条件发卡，测试 stub 与未来平台不受影响。`FeishuPlatform.sendCompletionNotification` 内部的检查保留，继续守护该能力自身的方法契约。

## Alternatives considered

**在 `FeishuPlatform.sendCardWithHandle` 内部门禁。** 粒度错误：该方法被进度卡、追问卡、洞察卡、spawn 就绪卡共享，门禁会删掉 bot 发出的所有卡片。

**反转为 opt-out 缺省（不设 `notifyOnComplete: false` 就发卡）。** 会改变省略该键的 bot 的现网行为。两处部署（Mac 2 bot、dev 服务器 9 bot）都显式设了 `true`，保持文档化的 opt-in 缺省在部署时零变化，并恢复 FEATURE-PARITY #2 的语义。

**把该标志穿进 Engine 构造函数。** 引擎是平台无关的，飞书配置键不属于它的装配面。能力探针让决策留在拥有配置的平台里。

## Consequences

未设置或设为 false 的 bot 不再发 ✅ 卡——包括其状态页脚（模型/ctx/workdir/git）、spawn 跳转链、subtask diff 与在途子任务提示；`/notify` 可按需重发就绪卡，洞察卡、cron 通知、错误通知各有自己的开关。页脚内容决策不受影响：时长刨除 parked-ask 等待（[2026-08-30](2026-08-30-feishu-bridge-completion-duration-park-exempt.zh.md)），在途子任务提示仍随推送（[2026-08-26](../feature/2026-08-26-feishu-bridge-pending-subtasks-card-visibility.zh.md)）。门禁位于唯一入口——`sendTurnCompletionCard` 是完成通知的唯一调用点——两种渲染形态执行同一决策。

## Testing

`tests/engine/status-footer.spec.ts`：报告 `completionNoticeEnabled: false` 的卡片平台 stub 收不到卡、不存句柄；同一 stub 报告 `true` 时卡照发；无卡片的通知平台在偏好 disabled 时收不到文本通知。`tests/assembly.spec.ts`：`completionNoticeEnabled()` 返回配置的 `notifyOnComplete`，缺省为 false。
