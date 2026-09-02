# Agent Note: feishu-bridge chatroom interrupt disarms member subtask gathers

Status: implemented

[English](2026-09-01-feishu-bridge-chatroom-interrupt-disarms-gathers.md) | 中文

## Problem

2026-09-01 oc_0e4b5c92 研究模式聊天室在一次干净的停止之后自行复活。用户先逐个手动停掉了五个研究助手群（22:39:53–22:40:17，`user stopped turn, auto-report suppressed`），再发 `/chatroom stop`；`interruptChatroom` 于 22:41:15 正确执行（停 hub turn、消费两道聊天室屏障、拆除 10 个成员群、清全部聊天室标记）。十三分钟后的 22:54:18–39，五个角色群全部凭空开出新回合，自顾自跑下去，直到用户再次逐群手动停止。

唤醒源是成员自己的 subtask gather：每个角色在 22:34:18–39 武装了 `pendingSubtaskGather`（expected=1，1200 秒兜底定时器），等待各自的助手群回报。被用户停掉的助手永远不回报（auto-report 抑制是有意的接管语义），这些屏障只能等到超时——22:34:18 + 1200s = 22:54:18，与 `subtask: gather timed out; woke parent with partial results` 分秒吻合。`interruptChatroom` 消费了 hub 上的聊天室屏障，却从未触碰成员会话上的 subtask 屏障；而 [gather-abort 决策](2026-08-26-feishu-bridge-gather-abort-settles.zh.md)有意让被中止的 gather 保持屏障武装、超时唤醒照常投递已入账的回报。暂停语义撞上拆除语义，拆除就复活了。

## Decision

`interruptChatroom` 在拆除范围内解除 subtask gather：`Engine.clearSubtaskGather(sessionKey)` 停掉兜底定时器并丢弃屏障、不产生唤醒；interrupt 在 `stopInteractiveSession(hubKey)` 之后对 hub 调用一次，并在既有的子树停止循环里对每个成员调用——始终在该成员 turn 停止之后，因为 abort 监听器会先结算阻塞式 gather 停在工具调用上的 promise，clear 绝不能 resolve 或悬挂任何 waiter。`chatroom: interrupted` 日志行新增 `gathers_cleared=N`。普通用户 `/stop` 的 2026-08-26 语义不变：屏障保持武装，超时唤醒仍投递部分结果。

## Alternatives considered

- **在 gather abort 监听器里解除（每次停止都清）。** 否决：普通用户停止是暂停——用户可能回来，超时唤醒正是投递已入账部分汇总的通道。每次 abort 都解除会丢掉已收集的回报，恰是 2026-08-26 note 防住的损失。
- **在 `finalizeChatroomEnd`（与正常 end 共享）里清成员 gather。** 否决：正常 end 要排水在飞回复；阻塞在 gather 上的角色若屏障被无声丢弃，永远等不到工具结果——正是 2026-08-26 修复移除的 parked-turn 隐患。`endChatroom` 对死回复源的既有逃生门（`force: true` / `/chatroom stop`）继续拥有该场景。
- **投递时抑制唤醒（在 `wakeParentWithGather` 里查「聊天室已拆除」）。** 否决：屏障会带着活定时器滞留，且该检查需要在通用 subtask 唤醒路径里做聊天室感知查找；在唯一的拆除 owner 处解除，局部且可测。

## Consequences

- `/chatroom stop` 对整棵子树是终局：拆除之后，任何延迟的 gather 超时（以及任何读取已解除屏障的路径）都无法再让成员开新回合。
- 残余：正常 end（非 interrupt）下，等待死助手的角色仍要先熬过 gather 超时，其回复才能排空 end 屏障；受 gather 与 end 超时兜底，逃生门是 `force: true`。
- 残余：被用户停掉的助手回报被抑制，聊天室存活期间父角色的 gather 也只能等到超时才结束——有意的用户接管语义，不变。
- 覆盖于 `packages/acp/feishu-bridge-chatroom/tests/engine/engine-chatroom-interrupt.spec.ts`（interrupt 清屏障；20 分钟兜底推进后角色不再被唤醒）。
