# Agent Note：/ps 表情标记改为叠加式；收下标记永不撤回

Status: implemented

[English](2026-09-18-feishu-bridge-ps-additive-reaction-marks.md) | 中文

## 问题

`/ps` 的收下标记原本是「换标」：文本进了 agent 的 next-step 收件箱就打 `Get`，认领落地时撤掉它、换成 `DONE`——回合先死则换成配置的停止表情（见[三态 note](2026-09-17-feishu-bridge-ps-three-state-reaction.zh.md)）。一条消息上只有一枚表情，因此只表达当前状态、抹掉它此前经历过什么：走完的 steer 与死在半路的 steer 最终长得一样；一旦结局已知，这条消息再也看不出它的文本曾被收下过。

换标也无法做可靠。撤掉收下标记要靠那次添加返回的表情 ID，于是认领早于该添加落地时撤回会被跳过（待认领记录此前已被删除），那枚 `Get` 与 `DONE` 永久并存；撤回把重试耗尽也留下同样的残留。两者当时都被记为「已接受竞态」，而非换标形态下可修的问题。

用户在与它共处之后裁定了反方向：收下是「发生过的事」的记录（文本被收进了收件箱），结局是另一件事实，两者都该留在消息上。

## 决定

`/ps` 在触发消息上留下两枚叠加标记。

**收下。** `cmdPs` 用平台的 fire-and-forget 添加打 `Get`：不请求表情 ID，也不保存任何 ID。`PendingSteerReaction` 只在 steer 消息 id 下持有 `{platform, replyCtx}`，待认领表就是一个普通的有界表，其淘汰不再撤回任何东西。

**结局。** `settleSteerReaction` 删掉待认领记录，并在收下标记**旁边**追加结局表情，绝不替换它：认领事件报告文本已进模型请求时追加 `DONE`，回合先死则调 `addCancelledReaction`（配置的 `cancelEmoji`，默认 `CrossMark`，`'none'` 关闭）。`settlePendingSteerReactions` 职责不变——teardown 给每个仍待认领者打上停止表情——只是不再撤回。

**所有平台一条路径。** 无需 ID 的收下标记消掉了能力分支：不支持按 ID 撤回的平台打同样的 `Get`、收同样的结局标记。`ReactionManager` 仍留在能力集中——monitor 的分诊被丢弃时仍要撤回——但 `/ps` 路径不再碰它。

## 考虑过的替代

- **保留换标并修掉它的两处残留**（用已结算标记让晚到的收下添加自己撤回；把结局添加挂在撤回之后）。被本 note 背后的裁定否决：换标隐藏历史，且结局已是 `DONE` 的消息仍应显示它的文本曾被收下。
- **只在死亡路径撤回**（`DONE` 落地时保留 `Get`，回合死掉时换成停止表情）。否决：`Get` 的含义会随结局而变，而撤回状态——连它的残留竞态——会为这条更罕见的路径留着。
- **持久化待认领表，让重启也能送出结局。** 同前否决：表情是平台的临时状态，该表只是引擎生命周期内的记账（该理由归[三态 note](2026-09-17-feishu-bridge-ps-three-state-reaction.zh.md) 所有）。

## 后果

- 一条被 steer 的消息上标记只增不减：永远有 `Get`，之后加 `DONE` 或停止表情。死在半路的 steer 显示 `Get` 加停止表情——接受，因为每枚标记命名的是不同的事实，而不是一个待覆盖的状态。
- 未结算的收下标记不再是缺陷：认领始终不到达（stall-retry 换通道把认领事件 drain 掉、daemon 重启丢了记录、在表的容量上限被淘汰）时，它保留 `Get`、没有结局。三态 note 记录的两处撤回残留都不可能再发生——不存在撤回。
- `PendingSteerReaction` 去掉 `reactionID`；`/ps` 路径不再持有撤回状态，每次结算少一次 API 调用。
- `tests/engine/misc-commands.spec.ts` 钉住这些标记：入队打 `Get`、认领后 `Get` + `DONE`、停止与 cleanup 路径 `Get` + 停止表情、无停止能力时只有 `Get`、以及缺少按 ID 撤回能力的平台得到同一对标记；录制器的 ID 能力继续断言「从未使用」，作为不撤回的护栏。
- 无模型可见、持久化或配置层面的变化：`steer_claimed` 投影、会话日志与 `cancelEmoji` 的全部语义均未改动。
