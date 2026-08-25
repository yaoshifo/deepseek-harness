# Agent Note: feishu-bridge 挂起提问卡上的 /done 不再重启 ask 表面

Status: implemented

[English](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.md) | 中文

## Problem

生产事故 2026-08-25（群 oc_d22d，「上游变更检查」）：该群最后一个 turn 于 08:44 停在一张用户始终未作答的收尾 `ask_user_question` 卡上；26 分钟后的 `/done` 在拆除会话一分钟之后于群里留下一张全新的「执行中 · 09:11:00」运行卡（带停止按钮）。会话日志为证：提问的 `tool/call` 在 08:44:25.970，其 `tool/result` 与 `turn/end` 落在 09:10:57.544——正是 `/done` 的中止时刻。两个缺陷叠加：

- `askUser` 经 stopSignal 解决挂起的提问（`decided = cancelled`）后仍无条件执行 `restartAskSurfaces`——新建 `StreamPreview`、推出占位运行卡、并把引擎级 active preview 重绑到它上面。stopSignal 的全部触发点（stopInteractiveSession 拆除、interactive-state 回收、cleanup）都会丢弃或替换该 state，新卡永远无人收尾。重启的本意是让用户作答后的执行落到新卡上（[post-permission restart](2026-08-20-feishu-bridge-post-permission-card-restart.zh.md)）；被拆除的会话不存在作答后的执行。
- `/done` 的头像置灰触发 `im.chat.updated_v1` → `onChatChanged`（2 秒去抖）→ `bumpActivePreviewForSession` → `bumpToEnd`，后者把 preview 重发为新卡并删旧卡——把幽灵卡刷新成「执行中 · 09:11:00」。`bumpToEndLocked` 的守卫只覆盖 `previewMsgID`/`degraded`/`completed`/`failed`，不含 `stoppedCardRendered`（`markStopped` 成功后 `degraded=false`），且拆除从不解绑 bump 绑定——即使 ⏹ 停止卡被正确渲染（[stop finalizes the preview](2026-08-22-feishu-bridge-stop-finalizes-preview-card.zh.md)），也会被 bump 换成一张新的运行卡，而且该死群此后每次改名/换头像都会再复活一次。

## Decision

三处协同修改，一洞一堵：

1. `askUser` 仅在结局为 `decided` 时执行 `restartAskSurfaces`；stopped/aborted 直接返回 cancelled 决定，不产生新表面。
2. `bumpToEndLocked` 的守卫列表加入 `stoppedCardRendered`：停止卡是终态，bump 是重发不是复活。`resumeFromFreeze` 会重置该标志，合法恢复的冻结卡仍可 bump。
3. `stopInteractiveSession` 在 `activePreviewSession` 命中被停会话时解绑引擎级 bump 绑定：拆除之后的改名/头像通知没有可重发的 preview。

## Alternatives considered

**只修 bump 守卫。** 否决：`restartAskSurfaces` 的占位卡仍会在拆除时刻发出——每次「ask 挂起期间 /done」仍留一张多余运行卡，只是之后不再刷新。

**只修 askUser 分支。** 否决：事件循环与提问 continuation 赛跑，stop arm 可能先在旧 preview 上渲染 ⏹，而头像置灰的 bump 仍会复活停止卡——约一半交错序下事故卡照样出现。

**在 bump 里 detach 而非加守卫。** 所有者错了：终态性本就由 preview 的标志承载，守卫只是漏了一项。

## Consequences

ask 挂起期间的 `/done`、`/stop`、`/new`、`/switch` 及 interactive-state 回收不再发出任何新 preview 卡；已渲染的 ⏹ 卡在同名后续改名/头像通知下存活。用户作答后的执行仍落在全新卡片上。bump 绑定随会话消亡，而非等到引擎里任意下一个 turn 才被覆盖。

## Testing

`tests/engine/engine-ask.spec.ts`：aborted 与 stopped 的 settle 用例断言 `state.preview` 保持 undefined；allow 路径用例钉住 decided 结局仍重启表面。`tests/streaming.spec.ts`「bump to end」：no-op 用例表新增 `stopped` 分支（`degraded=false`，与 `markStopped` 的实际留态一致）。`tests/engine/engine-chat-renamed.spec.ts`：bind → `stopInteractiveSession` → `bumpActivePreviewForSession` 无发送，且无关会话的绑定不受影响。红灯验证：暂存 src 改动后恰好这四个断言失败。聚焦测试套件与仓库 typecheck 全绿。
