# Agent Note: /chatroom stop——从任意协议状态中断聊天室

Status: implemented

[English](2026-08-25-feishu-bridge-chatroom-interrupt.md) | 中文

## Problem

`endChatroom` 在 gather armed 时拒绝收尾——而回复源已死的 gather 永远等不齐。2026-08-25 oc_65f8918e 事故正好走进这个死锁：用户手动停掉两个研究助手（user-stop 压制 auto-report 是既有设计），两个角色的结论轮永不触发，hub 被 idle 回收，聊天室沦为僵尸——armed 屏障的 60 分钟超时会唤醒被放弃的 moderator 继续编排、`/done` 被屏障挡住、十个群无人清理、挂死的 native 后代（marks 的 spawn 兜底，tool call 开着 28 分钟）只能被跑不起来的 end drain。Go 没有对应物：从来没有一条不依赖协议状态的硬停路径。

## Decision

**`interruptChatroom(e, hubKey)`**——一个内核、三个入口：

- 收束两个屏障（gather + end）但不唤醒：timer 停掉，缺失角色名只进中断卡片。
- 先停 moderator 轮次（编排中的轮次会往正要删除的群发 ask），再经 `stopInteractiveSession` 停掉全部在途角色/助手轮次——中断什么都不等，与 end 的排空语义相对。
- 原样复用 `finalizeChatroomEnd` 的收尾机器（角色/助手群清理、标志复位、native 后代 drain——挂死的兜底子在这里被终结）。
- 向 hub 发一张系统卡片（⏹ 聊天室已中断：清理角色数、未收回复、账本保留位置）。**不开 moderator 轮次**：用户在主动中止，卡片是唯一终态记录；armed gather 的进度卡不再单独更新（中断卡片即终态记录）。

入口：`/chatroom stop`（或 中断）——hub、任意角色群、任意助手群都可发起（`resolveChatroomHubKey` 依次走 moderator 标志、chatroomHubKey、父链）；chatroom 工具的 `end` 动作加 `force: true` 走中断（拒绝报错文案现在指明 force 路径）；`/done` 保持优雅语义不做隐式降级。

## Alternatives considered

**end 被挡时自动中断。** 弃用：回复还能到的时候 end 的排空语义是对的；等还是停是调用方的决定，所以被挡报错改为指路 force，而不是悄悄改变语义。

**唤醒 moderator 告知「你被中断了」。** 用户决策弃用：中止意味着不再开任何模型轮次；账目由系统卡片承载。

**停助手通知链（助手被用户停掉时唤醒父角色）。** 作为独立改进延期：中断是解锁搁浅的逃生门，通知链只改善它周边的即时体验。

## Consequences

armed 在死回复源上的 gather 不再是死锁：用户从任意成员群可以打破，moderator 经 `end force` 可以打破，daemon 重启经屏障恢复路径收束（那条路径会唤醒 moderator——契约不同，因为没人请求过那次重启）。oc_65f8918e 的僵尸现场仍需一次性清理（reload + `/done`，或新代码上线后直接 `/chatroom stop`）。

## Testing

`tests/engine/engine-chatroom-interrupt.spec.ts`（+6）：armed gather 中断（屏障消费、无唤醒、moderator 与成员轮次停止、收尾、含缺失角色的卡片）、end 屏障中断、已结束聊天室上的 no-op、hub/角色/助手/无关聊天四种解析、两条命令路径。engine + adapter + assembly 全量套件与仓库 typecheck 通过。
