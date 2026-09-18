# Agent Note：/ps 三态表情；删除从未接线的 Go 移植表情配置

Status: implemented

[English](2026-09-17-feishu-bridge-ps-three-state-reaction.md) | 中文

## 问题

`/ps` 在回合中追加文本时，`steer()` 一返回就立刻回 'Done' 表情——但 steer 只是把文本放进 agent 的 next-step 收件箱。从那一刻到模型真正看到文本之间，可能隔着一个长工具调用或一张挂起的权限卡（分钟级），表情宣称「已处理」而事实是「排队中」。普通消息从没有这个盲区（📬 排队通知回复 + 下一回合的进度卡），/ps 是唯一在撒谎的面。

另一件事：`reactionEmoji` 与 `doneEmoji`（Go `reaction_emoji` / `done_emoji`）作为配置项移植了但从未接线：打字中表情与完成表情的平台方法没有任何调用方，配置了也无效——正是 2026-09-14 progressStyle 守卫点名的静默错配类。

## 决定

/ps 的应答改为触发消息上的三态表情，两个死配置删除。**2026-09-18 被取代：** 撤回的那一半已消失——标记改为叠加式，收下标记永不撤回，所有平台走同一条路径（[叠加标记 note](2026-09-18-feishu-bridge-ps-additive-reaction-marks.zh.md)）；下文的认领锚点、表情键名与死配置摘除继续有效。

**信号——认领的持久事件。** agent 循环认领 steer 批次时，在构建并发送模型请求的同一同步块里把认领消息落成持久 `user/message` 事件（agent-loop `step()`），该事件因此就是「文本进入模型请求」的精确时刻。`DshAgentSession.steer` 现在返回铸出的 steer 消息 id 并记入会话级待定集合；`projectSessionEvent` 的 `user/message` 分支拿事件 id 对照该集合，命中即向引擎通道推一条新的 `steer_claimed` 事件（携带 `steerMessageID`）。非 steer 的 id（轮次 prompt、注入）保持静默，每个 id 恰好投影一次。

**引擎——结算状态。** `cmdPs` 经 `ReactionManager.addReactionWithID` 加 `Get` 表情，并按 steer id 在 `InteractiveState.pendingSteerReactions` 记下 `{platform, replyCtx, reactionID}`（BoundedStateMap，淘汰时撤回最旧的 Get——文本本身仍在 agent 持久收件箱里排队，放弃的只是标记）。交互泵的 `steer_claimed` 分支结算 **claimed**：撤 Get、加 `DONE`。`stopInteractiveSession` 与 `cleanupInteractiveState` 结算 **stopped**：撤 Get、触发平台的 `addCancelledReaction`——即配置的 `cancelEmoji`，现在默认 `CrossMark`，并补上了此前缺失的 `'none'` 归一化。停在回合边界的文本保持 Get 直到下一回合认领（认领事件由下一个泵消费），这是如实的：还在排队。不支持按 ID 撤回表情的平台保持旧的单发 `DONE`。**2026-09-18 被取代：** `cmdPs` 改用无 ID 的平台添加打收下标记，`settleSteerReaction` 在其旁边追加结局表情，能力分支随之消失；`cancelEmoji` 及其 `'none'` 归一化继续有效（[叠加标记 note](2026-09-18-feishu-bridge-ps-additive-reaction-marks.zh.md)）。

表情键名按飞书官方表情键表（`Get`、`DONE`、`CrossMark`；旧代码的 `'Done'` 显然大小写不敏感——现改用 canonical 拼写，真机冒烟验证）。

**摘除。** `reactionEmoji`/`doneEmoji` 从配置接口、Schema、装配映射与平台（字段、`startTyping`、`pendingTypingRemovals`、`addDoneReaction`）整体删除，连同 `StreamPreview.needsDoneReaction` 及其测试。profile 里残留的键在加载时 fail loud，沿 progressStyle/predictNext 守卫先例（Schemastery 会保留未知键）。

## 备选方案

- **用进程内 `agent/inbox/claimed` 派发事件做信号。** 否决：持久 `user/message` 事件是「模型可见 ⟺ 已落日志」的不变式锚点，本就经 adapter 现成的 `session/event` 订阅路由、可重放；派发事件要为同一事实加第二条订阅。
- **锚定首个流式 chunk（模型开始回话）。** 否决：DONE 会落后 TTFT 数秒，且请求在首 chunk 前失败的消息永远标不上（失败报告归错误卡管）。
- **Get 与 DONE 累积不撤回。** 当时否决：残留的 Get 永远读作「还在排队」；monitor 流程的撤回换标是既有模式——2026-09-18 经用户裁定反转并落地，见[叠加标记 note](2026-09-18-feishu-bridge-ps-additive-reaction-marks.zh.md)。
- **持久化待定表情表。** 否决：表情是临时平台状态；daemon 重启会让极少数在途 steer 留下一个陈旧 Get——与 monitor 表情 id 同一已接受性质。
- **接线 `reactionEmoji`（打字中表情）而非删除。** 用户裁定删除：/ps 的 Get 已覆盖真实需求。

## 后果

- `AgentSession.steer`（桥内部接口）现在返回 steer 消息 id；全部实现方、桩与两个机器 steer 调用方（忽略返回值）已更新。
- Event 通道新增一种 kind（`steer_claimed`）；三个闭集 switch 都携带它（交互泵结算；spillover 与 relay no-op），`isSubstantiveUnsolicitedEvent` 的 default-false 已让未请求阅读器忽略它。机器 steer（`deliverMachineMessage`）同样投影认领——引擎对无记录的 id 不结算；普通轮次 prompt 不产生事件。
- **部署顺序**：仍配置 `reactionEmoji`/`doneEmoji` 的 profile 在加载时 fail loud——先从 live profile（两个 bot）删掉这两个键再 reload 新构建；`cancelEmoji: CrossMark` 可保留（现已生效且与新默认一致）。
- 已接受的竞态（已文档化）：stall-retry 换通道时被 drain 掉的认领事件可能让一个已认领的 steer 留着 Get（欠报不撒谎）；daemon 重启丢失内存记录（陈旧 Get）。stop/cleanup 结算覆盖所有引擎主动的拆除路径。2026-09-18 起第一处残留是按设计存在而非缺陷——未结算的收下标记保留 Get、没有结局标记（[叠加标记 note](2026-09-18-feishu-bridge-ps-additive-reaction-marks.zh.md)）。
- 无模型可见变化：`user/message` 持久事件本就存在；无 session 格式或快照影响。
