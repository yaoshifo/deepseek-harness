# Agent Note: 收尾卡提交派发可读的选择消息

Status: implemented

[English](2026-09-07-feishu-bridge-followups-selection-message.md) | 中文

## Problem

收尾卡的 followups 转换曾把卡面提交按原始传输码 `fw:{i1},{i2}`（附言走 NUL 分隔符）加 `isFollowupAction` 旗标派发。引擎按该旗标把消息路由到新 turn 并把文本原样交给 agent，于是模型的下一条 prompt 就是字面的 "fw:1"——一个系统提示从未描述过的内部传输码，而 agent 约定提示词却承诺选择会作为「[后续处理]」新消息到达。每次 followups 提交都要让模型消耗一轮困惑的澄清（2026-09-07 oc_0481474 实测：一轮 ask_user_question 加约 880 个推理 token 猜 "fw:1" 是什么意思；用户靠澄清卡救回）。README、引入提交的 commit message、引擎测试的 mock 内容描述的都是可读的自包含消息；唯独实现缺失，为标题行定义的 `followups_selection` 消息表条目也从未被引用。

## Decision

飞书平台的 `fw_multi:` intake 在提交点就地合成派发文本——发送时 meta（问题、选项、描述）本来就在手边供卡片冻结使用：

- `followupsSelectionMessage`（engine/ask.ts）构造消息：`FollowupsSelection` 标题行、问题、每个选项一行 `✅/◻️ **标签**` + 描述、尾行 `✍️` 附言。勾选标记的构造与冻结卡共享（`settledOptionMarks`），派发文本与用户可见的冻结卡不会漂移。
- 无缓存 meta（daemon 重启、旧于缓存的卡、或缓存键被更新的 askq 卡占用）时，派发本地化的 `followups_stale` 提示——点名勾选序号、回调 value 里可用时带问题提示、附言随行——任何路径上原始 `fw:` 传输码都不再到达模型。
- `isFollowupAction` 的路由语义不变；只改了派发文本。

## Alternatives considered

**在 routeAskResponse fall-through 处做引擎侧展开。** 作为放置点被否：引擎看到消息时，交互状态的 `pendingFollowups` 已被消费，选项标签只存在于平台的 meta 缓存——提交点才是标签与冻结共同所在，单一合成点让派发与冻结保持对称。

## Consequences

followups 提交后 agent 的下一条 prompt 是一份自包含的选择报告（标题行、问题、勾选与未勾选项的标签及其 `path:line` 描述、附言），模型可直接处理勾选项而无需猜测序号含义。旧卡的提交降级为「与用户确认」提示而非不可解读的传输码。由 `tests/feishu/card-action.spec.ts`（带标签与附言的可读派发、仅附言提交、带附言的 stale 提示）与 `tests/engine/followups.spec.ts`（路由 mock 改由 `followupsSelectionMessage` 生成）钉住。
