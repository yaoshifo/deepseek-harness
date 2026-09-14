# Agent Note: 投递结果回灌用户可见状态（吸收批次 1）

Status: implemented

[English](2026-09-14-feishu-bridge-delivery-outcome.md) | 中文

## 问题

[dsh-im 对照调研](../../../../packages/acp/feishu-bridge/docs/DSH-IM-COMPARISON.md)钉死了三个投递可靠性缺口，全是同一条原则的违反——投递结果从不回灌到用户可见状态：

- **完成的回合可以在答案未落地时读作成功。** 发送失败只在 debug 级别记日志；回合终态只看 `errorText`；进度卡无条件 finalize 绿、✅ 完成卡照发。
- **重试可能重复发消息。** 飞书 `im/v1` create/reply 支持 `uuid` 幂等键，但本插件从不传，所以每次重试都是一次全新发送；可重试集合还包含桥自合成的 30 秒单次期限——那是投递后症状，请求可能已经落地。
- **强杀丢答案。** stall 耗尽与硬帽两条路径直接 return，不经任何投递点；已完成的流式文本随回合一起死。最坏情形叠加：`fallbackSend` **先删冻结卡再重投**，重投失败时卡和答案一起丢失。

## 决策

**三态判据（u1）。** `src/feishu/delivery-outcome.ts` 的 `classifyDeliveryFailure`：只有服务端应答过的失败才是确定的（"failed"）——收到了 HTTP 状态或业务码，含仍可重试的 230020/99991400 限流拒绝（结果与可重试性是两个轴）。传输层症状与自合成期限是 "unknown"；未识别形态默认 unknown，对齐 dsh-im 的 uncertain-by-default。判据以渠道中立的 `DeliveryOutcomeClassifier` 能力暴露（`src/core/types.ts` 的 `asDeliveryOutcomeClassifier`），由 `FeishuPlatform` 实现——engine 消费它而不引入 engine→feishu import。

**终态联动（u2+u3）。** turn-end 的四处纯文本答案循环走 `deliverAnswerText`，逐块分类失败并在 `state.answerDelivery` 上记录保守最差结果（'unknown' 压过 'failed' 压过 'sent'），每个回合边界重置。答案未确证落地时，警示文案紧跟投递分支发出（无卡平台也能看到），✅ 完成卡正文以同样文案开头：`answer_delivery_unknown` 告知用户不要立即重发；`answer_delivery_failed` 声明答案未能送达。

**强杀前交货（u4）。** 两条强杀路径在终态卡渲染与状态清理之间调用 `deliverKilledTurnPartial`：复用 channel-closed 路径的分段逻辑（工具间已呈现的分段不再重发；只投未送达的余段），以中断标记的部分结果结算子任务父方（而非只有合成的超时通告），并记录投递结果。已知边界：从未完成其消息的块——典型的答案中途挂起——在 `textParts` 里仍然什么都没有；活卡是它唯一的痕迹。

**先投递的兜底（u5）。** `fallbackSend` 先重投、只在成功时删除冻结卡——冻结卡仍显示流式文本，重投失败不再两失。`deliverAnswer` 对失败分类并把最差结果记到 `sp.answerDelivery`（成功的终态 PATCH 也置位）；engine 在 turn-end 读取，流式卡路径因此喂进同一套完成文案。全投不出去时，engine 把答案存到会话工作区旁（`undelivered-reply-<ts>.md`），警示携带路径（`answer_delivery_saved`），成果可找回。

**发送意图 uuid（u6）。** 每个 `im` create/reply 携带一个在重试循环外生成一次的 uuid，瞬态重试与 token 刷新重发在服务端幂等。实施前真机验证：同幂等键两发（lark-cli，不同正文）返回同一 `message_id`、只落一条消息。自合成单次期限退出发送路径的可重试集合（`withRetry(..., { retryOnDeadline: false })`）——超时的发送把未知结果上抛给 engine，而不是赌一次重复——非发送操作保留卡死尝试的重试。

## 备选方案

**完整 DeliveryReceipt 移植。** dsh-im 的回执对象、延迟投递 outbox 与历史捞取协调在本批次被否：单渠道、无回执合并消费者，且廉价版本（强杀交货、先投递兜底）已覆盖钉死的痛点。完整延迟系统仍是 §5.2 候选。

**在 uuid 保护下重试超时的发送。** uuid 就位后，期限重试会在服务端去重——但只在携带 uuid 的动词上、且只在去重窗口内成立；计划选择了保守配对（uuid 管幂等、期限不重试），让两个机制不依赖彼此的边界情形。

**强杀时投递全部累积文本而非未送达余段。** 卡只显示最后一段且截到 6000 字；投全部拼接会重复早前分段已呈现的内容。直接复用 channel-closed 的分段逻辑。

## 后果

答案未确证落地的回合现在会警示用户、不再读作成功；重试不再产生重复消息（服务端去重加期限边界）；强杀交付已完成的流式文本并结算子任务父方；失败的兜底保留冻结卡而非删除；完全投不出去的答案存到工作区并在警示中给路径。

`uuid` 字段搭上每个 `im` create/reply 载荷（36 字符 v4）；发送路径超时现在上抛为 `unknown` 结果——相比静默重试并可能重复是行为变化。流式卡路径经 `sp.answerDelivery` 上报；ask 委托与孤儿回合路径经同一回合状态继承接线。

## 测试

`tests/feishu/delivery-outcome.spec.ts`——五类错误形态加能力守卫。`tests/engine/engine-answer-delivery.spec.ts`——sent/unknown/failed 记录、警示文案、工作区保存与路径。`tests/engine/engine-kill-delivery.spec.ts`——stall 耗尽与硬帽强杀投出已完成的流式文本。`tests/streaming.spec.ts`（absorption u5 块）——`deliverAnswer` 分类与先投递兜底顺序。`tests/feishu/transient-retry.spec.ts`（absorption u6 块）——重试间 uuid 稳定、create uuid 存在、发送路径期限不重试、非发送期限仍重试。
