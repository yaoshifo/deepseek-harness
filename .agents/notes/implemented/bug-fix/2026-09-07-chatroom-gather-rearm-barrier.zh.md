# Agent Note: 聊天室 gather 重挂屏障——超时先换一个窗口，再降级自由转发

Status: implemented

[English](2026-09-07-chatroom-gather-rearm-barrier.md) | 中文

## Problem

2026-09-06 auto 模式研究第 1 轮事故：hub 对 5 角色的 chatroom gather 在 1200 秒超时只收齐 1/5，`fireGatherTimeout` 销毁屏障并部分唤醒 moderator。moderator 结束回合时的假设是「剩余角色的报告到了会唤醒我」——合理，但 4 份迟到交付（超时后 5-10 分钟内全部落盘）被提问身份路由判为过期 ask（`turn from a superseded ask; relayed as free reply`）：只在群聊可见的转发卡、不注入 hub、不唤醒任何会话。监督网 30-60 分钟后才把房间拉回，净损约 60 分钟。结构性缺陷：屏障超时把「窗口耗尽」与「永远不会再有回复」混为一谈，而 superseded-ask 降级——对真正过期的轮次是正确的——无声吞掉了只是迟到几分钟、却没有任何东西为其重挂窗口的回复。

## Decision

- **gather 超时重挂一次，而不是销毁屏障**（`packages/acp/feishu-bridge-chatroom/src/engine/chatroom.ts` 的 `fireGatherTimeout`）：第一次超时时未交付角色的 expected 集合保持武装，兜底定时器按 `gatherRearmSec`（默认 1200，`Config` 字段，可从 `cordis.patch.yml` 的 `defaults`/按项目 `projects` 覆盖）重启，moderator 收到部分唤醒，其前缀（`chatroom_gather_rearmed`）写明重挂契约——迟到回复继续汇入，全部到齐（或窗口耗尽）会再次唤醒并附届时的全部回复。迟到回复不需要新路由：屏障活着则回合 stamp 仍匹配本轮，`maybeAutoRelayRole` 走既有 gather 汇聚路径（`chatroom: gathered role reply (waiting for more)` → 批量注入摘要的 `chatroom: gather complete; woke moderator with all replies`）。
- **第二次超时才是真正的降级**：`timeoutFire` 走原有路径——屏障销毁、进度卡终态、带未交角色名单的部分唤醒——此后才落到的回复走既有 superseded-ask 自由转发。每轮只重挂一次（屏障上的 `rearmed` 标志），总等待上界 ≈ 2× gather 超时，无无限续期。
- **`rearmed` 标志随屏障快照持久化在 `featureState`**（对齐监督网的可恢复设计，2026-09-06 wake-chain-freeze）：重启恢复仍一次性收束恢复的 gather——没有角色回合能在重启后存活，恢复的屏障不会重挂窗口；持久化的标志保证窗口中途重启不会在任何未来会恢复定时器的路径上重启重挂预算。

## Alternatives considered

- **提示词层修正**（「moderator：等迟到回复齐了再汇总」）。计划已否决：事故里失败的正是劝告式文本——moderator 的假设本来就合理，缺的是兑现这个假设的窗口的归属。
- **调大 `gatherTimeoutSec`。** 为少数迟到的轮给所有轮加税；迟到几分钟的回复对任何固定超时下被销毁的屏障仍然是死路。
- **经提问身份路由重挂屏障（把迟到回复当新 ask）。** superseded-ask 路由正是误路由交付的那条路；绕开它做按角色关联会重复轮次 stamp 已提供的关联，且窗口外的自由转发降级是被有意保留的。
- **扩展 subagent 包的通用 gather 屏障。** 计划明确范围外：通用父侧 gather 有自己的超时与消费方；事故是 chatroom 特有的（角色回合结束经 hub 屏障转发）。

## Consequences

- 测试钉住整条行为阶梯：第一次超时重挂（屏障同一性保持、expected 完整、重挂定时器武装、部分唤醒带点名缺失角色的重挂说明）；窗口内迟到交付走 gather 路径（waiting-for-more journal 指纹、无额外唤醒），最后一份到齐时唤醒 moderator 并批量注入全部回复；第二次超时销毁屏障、之后的回复自由转发、不存在第三个窗口；配置的 `gatherRearmSec` 真正驱动武装定时器（1 秒窗口在 +1 秒烧完）；快照携带 `rearmed`，窗口中途重启一次性收束本轮并保留已收回复、此后不再唤醒；监督网的武装屏障证据门（两类关系）不改动即继续覆盖重挂窗口，监督网不会抢跑活跃重挂。
- 第一次超时的唤醒是新的模型可见输入，走既有 `wakeChatroomModerator` 路径；其文本必须持续告知 moderator 窗口存活期间不要重跑本轮（`gatherRoles` 的在途守卫本来也会拒绝）。
- end/interrupt 守卫看到重挂窗口与原窗口完全一样：`pendingGather` 武装期间 `endChatroom` 继续拒绝（`force: true` 仍是逃生门），`/chatroom stop` 仍消费屏障。
- 迟到轮的最坏总墙钟时间从 1× 增长到 ≈ 2× gather 超时；窗口内完成的轮不受影响。research 进度卡在重挂窗口期间保持 live（屏障仍在等待），用户面前的插话提示也随之保留。
- 部署：bridge-chatroom 插件重构建 + `/reload`；配置默认值无需改 `cordis.patch.yml`，新字段与其他 chatroom 调优字段一样可按项目覆盖。
