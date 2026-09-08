# Agent Note: stop 必须抢救已登记的追问卡，而不是丢弃

Status: implemented

[English](2026-09-08-feishu-bridge-followups-card-lost-on-stop.md) | 中文

## Problem

2026-09-08 oc_469693e0 事故（spawned 讨论群「图片查看分析」，tingting bot）：agent 收尾的 closing-card ask 在 turn 中被转换为非阻塞追问卡登记（3 个选项）。该 turn 结束时队列里已有消息（用户在执行期间发了消息），turn 末投递按设计同时跳过 ✅ 完成卡与追问卡，把登记保留给「drain 循环的最后 turn」。队列消息接手为下一个 turn 后，用户对其执行了 `/stop`。`stopInteractiveSession` 整体拆除 `InteractiveState`，未投递的登记随之消亡：问题卡片永远没有到达聊天，也没有任何提示。用户把这理解为「执行中发消息把卡片压没了」。

## Decision

`stopInteractiveSession` 在拆除前抢救存活的 `pendingFollowups` 登记：登记存在且 `state.platform` 已设置时，fire-and-forget 调用现有的 `sendFollowupsCard`（`packages/acp/feishu-bridge/src/engine/engine.ts`）。该方法本就先清登记再发送、对无卡片平台静默丢弃、且不重试——stop 路径保持同步，不会被发送卡住。errored/未完成 turn 的 turn 末丢弃语义不变：stop 是用户显式中止而非失败 turn，且登记背后的分析已经流式展示给用户。

## Alternatives considered

- **在有队列接管时也在完成 turn 末直接投递卡片。** 为了只在「接管 turn 被停止」才出现的丢失窗口，改变所有队列接管的既定卡片顺序，过宽。
- **给登记标记 earned（所属 turn 已完成），只抢救这类。** 为一个没有事故支撑的区分增加状态：turn 中被 stop 后分析已经钉在卡片上可见，建议菜单反而帮用户续作。

## Consequences

- 测试钉住抢救行为：`stopInteractiveSession` 带存活登记时恰好发送一张追问卡并清除登记；无登记时不发（`packages/acp/feishu-bridge/tests/engine/followups.spec.ts`）。
- 抢救卡与 ⏹ stop 终结卡都是 fire-and-forget，两者顺序不保证——对非阻塞建议卡可接受。
- 队列消息不受影响：stop 本就通知被丢弃的发送方（`notifyDroppedQueuedMessages`），事故中「排队」消息正是这样带着可见错误回复被丢弃的。
- 部署：桥重建 + `/reload`。
