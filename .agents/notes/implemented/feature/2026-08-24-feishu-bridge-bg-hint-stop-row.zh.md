# Agent Note: feishu-bridge 后台任务提示移入停止按钮行

Status: implemented

[English](2026-08-24-feishu-bridge-bg-hint-stop-row.md) | 中文

## Problem

后台任务提示（`bg_task_running`，由 [unsolicited reader](2026-08-24-feishu-bridge-unsolicited-reader.zh.md) 接线）渲染为进度卡正文的最后一行——永远在每次 PATCH 注入的「⏹ 停止执行」按钮行的上一行。一条短状态串占掉整行竖向空间，且把两个同属回合实时状态的信息（后台计数、停止控制）拆到两行。

## Decision

运行中（非终态）卡上提示离开正文、渲染进停止按钮行内；文案缩短为 `💡 %d 个后台任务`：

- `TextPreviewContent`（`src/core/types.ts`）增加可选 `bgTaskHint` 字段。`StreamPreview.progressContentLocked` 负责附加，`flushLocked` 的 content 重建负责保留——该重建只搬运 `{kind, text, status}`，不显式透传会丢掉这个字段。
- `buildProgressDisplayLocked` 仅在终态渲染（`completed`/`failed`）时把提示行拼进正文；运行态卡的提示只走结构化字段。
- `injectStopButton(cardJSON, sessionKey, hint)` 在提示非空时于 danger 按钮后追加一个灰色 notation 列。`sendPreviewStart` / `updateMessage` 负责传入该字段；列结构是与 `injectReplyButtons` 渲染状态行共享的 `notationColumn` 助手。

摆放位置在卡状态间刻意不对称。终态（绿/红）卡保留提示为答案下方的正文行：卡片变绿时停止按钮行消失，正文行让信息不丢，也免去为 `updateRenderStatus` / `markCardStopped` 重建路径缓存提示。用户停止卡（⏹ 已停止 + ▶ 继续执行）不重注入提示——它从最后一次 pre-button 运行态渲染重建，而提示那时在（现在被丢弃的）按钮行里。

## Alternatives considered

**所有卡状态都渲染进按钮行，绿卡的回复按钮行也带上。** 位置恒定，但需要按 messageID 缓存提示以支撑绿卡重建与停止卡重注入——相对信息价值而言管线过重，终态正文行本来就存在。

**只缩短文案、保留在正文。** 用户抱怨的是布局；更短的串依然独占按钮上方一行。

## Consequences

运行卡一行内显示 `⏹ 停止执行 | 💡 N 个后台任务`；终态卡除文案缩短外渲染不变。代价：用户停止卡不再显示提示（接受——停止本身是更强的信号，计数也会随完成回合清零）；卡片变绿时提示可见地换位（按钮行 → 正文行）。

## Testing

`tests/feishu/progress.spec.ts`——提示列在按钮旁、无提示时单列、终态带提示也不注入。`tests/streaming.spec.ts`——content 字段携带并清除提示；完成卡保留正文行。`tests/feishu/preview-send.spec.ts`——平台层 create/PATCH 与 `cmd:/stop` 同行渲染。feishu-bridge 全量：2279 通过。
