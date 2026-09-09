# Agent Note：chatroom error 轮中继自己的 partial，绝不再发旧答案

Status: implemented

[English](2026-09-09-chatroom-error-turn-stale-relay.md) | 中文

## Problem

2026-09-08 晚 chatroom 测试场：角色 turn 在生成中途被 API 1301 内容审查 error 打断。error 轮不会覆盖 `session.lastResult`（engine 在 `setLastResult` 上的 `!errored` 守卫——中途旁白不能变成会话的最后一个干净结果），但 turn-end waterfall 无条件把 `lastResultOrReply` 当本轮 response 下发。旧值仍持有该角色的上一轮答案时，chatroom 串行路径按 stamp 匹配后把旧答案逐字中继给主持人两次——一次是绿色【角色】转发卡加账本行，一次在唤醒里。gather 扇入与 end barrier 同盲区：`response` 带什么就吸收什么为轮答案。同一 engine 函数里的 subtask 自动汇报钩子早已持有正确纪律：error 时汇报本 turn 自己的 partial 流式文本，"never a stale earlier reply"。

## Decision

- **turn-end payload 显式携带失败。** error 轮的 `response` 改为 `joined.trim()`（本 turn 的 partial），payload 新增 `errored: boolean` + `errorText`——消费方不再需要从文本形状推断 response 是不是干净回复。bridge-service 事件契约补齐三个字段的文档；cordis catalog 镜像已重新生成。
- **channel-closed 发射点如实填 `errored`。** 只有真进程崩溃（既非用户停止也非引擎重载的意外退出）读作 errored，`errorText` 用进程退出通知；蓄意切断保持今天的自由转发语义。
- **失败的 chatroom 轮不是回复。** `maybeAutoRelayRole` 接收 `errored`/`errorText`；失败轮不发【角色】转发卡、不写账本行。
- **串行唤醒泛化 NO_REPLY 分支**：`[聊天室·<角色> 本轮发言失败（<errorText>）]`，本 turn 有流出过内容则附其 partial，再接既有的提醒——主持人看到失败与 partial，绝看不到旧答案。条目完成、answered 闩、in-flight 旗标的行为与正常作答完全一致，只有文案不同。
- **gather 与 end barrier 记显式失败注记**（`（本轮发言失败：<errorText>）`）而非回复：轮次仍把该角色计为已答（屏障不搁浅），但唤醒摘要写明回合失败，而非把 partial 伪装成轮答案。
- **新文案走 chatroom i18n 字典**（`chatroom_role_turn_failed_wake`、`chatroom_role_turn_failed_note`，zh+en）；唤醒与屏障文案由新测试钉在 verbatim 级。

## Alternatives considered

- **error 时覆盖 `lastResult`**：lastResult 是其他面读取的持久「最后一个干净结果」（导出键、后续上下文）；为修一个转发把它换成失败文本会毒化所有消费方。
- **把 partial 当正常回复转发**（卡+账本+发言唤醒）：partial 伪装成完整答案会污染账本与主持人的判断；失败必须可读作失败。
- **屏障里记 `''`（NO_REPLY 语义）**：零新增面，但告诉主持人的是角色静默跳过而非回合死掉；一个 i18n key 保住区分度。
- **error 时抑制唤醒**：复刻 wake-on-silent-NO_REPLY 修复前的搁浅——主持人会对死回合永久闲置。

## Consequences

- 测试钉住三层：engine payload（response 是 partial、绝非旧 lastResult，`errored`/`errorText` 已置位）、串行失败唤醒与不变的条目语义、gather 吸收为失败注记。
- 串行唤醒完整附上 partial、不裁剪——与 subtask 钩子的失败汇报同形；屏障注记过摘要既有的 200 字裁剪。
- 崩溃切断的 channel-closed 轮在 chatroom 侧现在读作 errored（发言失败唤醒，而非 partial 伪装成回复）；用户停止与引擎重载不变。
- error 轮 response 契约对事件 payload 是增量；唯一监听方是 chatroom 转发，同变更内已更新。
- 部署：bridge 重建 + `/reload`；验证行：`chatroom: role turn failed; woke moderator with the failure (role=… error=…)`。
