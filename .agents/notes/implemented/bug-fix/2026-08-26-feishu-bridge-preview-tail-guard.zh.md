# Agent Note: feishu-bridge 进度卡尾部守卫——任何消息都压不住活跃卡

Status: implemented

[English](2026-08-26-feishu-bridge-preview-tail-guard.md) | 中文

## Problem

生产事故 2026-08-26（marks 角色群 `oc_eae876d91b979c82fb5a348641742766`）：主持 ask 卡「主持 → marks」于 20:22:43.611 落地，压过 23ms 前创建的 tool process 卡（20:22:43.588），此后 6 分多钟没有任何机制把它顶回——侧边栏缩略列表停在被压住的 ask 卡上，用户失去「agent 仍在执行」的信号。根因是推送模型的枚举缺陷：`bumpToEnd` 只挂在 `im.chat.updated_v1`（改名/头像）上，引擎自发卡片（chatroom ask/回灌、research 进度、子任务结算、cron 通知）一律不触发；`askRoleInternal`/`relayRoleReply` 以 `void` 发卡后紧跟回合注入，占位卡与卡片的 HTTP 完成顺序互相竞速，同秒两卡先后互换即出事故。人类消息、成员变动系统消息、其他 bot、手动 lark-cli 发送更是连事件都没有，无处可推。engine 级全局单槽 `activePreview` 绑定在多会话并发流式（hub + 角色 + research 助手）下还会互相覆盖，bump 路由错位。

## Decision

翻转模型：活跃 preview 自己周期性自证尾部（拉取），不再枚举发送方。`StreamPreviewCfg.tailCheckMs`（默认 5000，0 关闭）；卡片创建（`flushLocked` 首发成功）时武装独立 `tailTimer`；tick 先查终态（与 `bumpToEndLocked` 同一张守卫表，外加 `finished`），终态即停表不再排下一拍；否则在锁外调平台能力 `PreviewTailProber.previewIsLatest(handle)`（飞书实现 = `message.list(ByCreateTimeDesc, 1)` 按 message_id 比较；thread 句柄跳过——话题内的卡片对主群尾部无意义），非最新则以既有 `bumpToEnd` 删旧发新回到尾部，并在锁内复查终态后排下一拍。`finish()` 入口闩上 `finished` 并停表：它的删除路径不清 `previewMsgID`、不设终态标志，在飞的 tick 会复活已删除的卡。`resumeFromFreeze()` 重新武装（冻结期读作终态，自然停表）。改名/头像系统通知的 2s 推送 bump 保留为快路径。

守卫之上补齐三个原推送方案的洞：① chatroom ask 卡与角色回灌卡改为 await 后再注入回合/唤醒（`askRoleInternal`、serial/gather 完成路径），消除最高发场景的竞态窗口，让占位卡确定后落；② engine bump 路由 per-session 化——`bumpActivePreviewForSession` 直接查 `interactiveStates.get(key).preview`，全局单槽 `activePreview` 绑定删除（并发流式下最新回合不再偷走其他会话的 bump），`onChatChanged` 去抖定时器改为按 session 的 Map；③ `recalled_v1` 命中活跃卡时调 `markRecalled()` 置 degraded 并停守卫——用户手动撤回的卡不再被周期性复活。

周期拉取守卫本身已于 2026-08-28 被活动账本位移自愈取代（[displacement-ledger note](2026-08-28-feishu-bridge-preview-displacement-ledger.zh.md)）：`PreviewTailProber.previewIsLatest`、`streamPreview.tailCheckMs` 与守卫定时器均已移除，自愈搭在预览自身的内容刷新节拍上。上述三项推送侧改动仍按原样交付。

## Alternatives considered

**逐点推送修补（发卡 await 后补 bump + engine per-session 路由）。** 否决为兜底主力：触发集是「引擎发送点」的枚举，本次事故正是枚举漏项；无事件的系统消息与外部发送永远覆盖不了。拉取的触发集是「群尾部状态」，与消息来源解耦，未来新功能的卡片自动被覆盖。但推送侧最便宜的两块（chatroom 卡片 await 定序、per-session 路由）后来作为快路径补齐——它们消除最高发场景的竞态窗口与并发错位，拉取守卫兜住其余一切。

**事件即时性。** 代价如实接受：拉取是周期收敛（最长一个检查周期的错误展示窗口）而非事件保证；每个活跃群每周期一次 `message.list(pageSize=1)`（默认 5s 约 0.2 QPS/群，research 作战室约 7 群并发约 1.4 QPS），probe 失败仅减慢治愈、不破坏行为。

**人类消息豁免。** `listMessages` 响应带 sender，加一行「压尾者是人类用户则跳过」即可豁免；默认不豁免——「始终最新」的语义要求全覆盖，留作体验反馈后的细化开关。

## Consequences

活跃卡无论被什么消息压住，都在一个检查周期内回到本群最新位置；chatroom ask/回灌的自身竞态窗口与并发流式下的 bump 路由错位已由 await 定序与 per-session 路由消除（守卫不再为这两类场景买单）；用户手动撤回的活跃卡经 `recalled_v1` 停用，不再复活。终态卡永不复活（沿用[挂起提问事故的守卫语义](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.zh.md)，`finished` 补上 finish 删除路径的缺口）。剩余边界：线程隔离部署跳过守卫；同一群两个流式 bot 会互相压尾重发（现网单 bot 拓扑不存在）。agent 执行路径与引擎回合编排不受影响。

## Testing

`tests/streaming.spec.ts`「tail guard」：被压自愈且静止期不再重发、仍最新周期零重发、finish 闩住不复活已删卡、discard 停表、probe 失败跳过本周期但继续守卫、平台无能力或周期为 0 永不武装、freeze 停表且 `resumeFromFreeze` 重启、`markRecalled` 停守卫不复活。`tests/feishu/preview-tail.spec.ts`：按最新优先单条查询并比较 message_id、空群为真、thread 句柄不发查询、非句柄参数拒绝。`tests/engine/recall.spec.ts`：`markRecalledPreview` 命中活跃卡置 degraded、无匹配不动作。`tests/engine/engine-m2.spec.ts` 与 `engine-chat-renamed.spec.ts`：per-session bump 路由（并发互不干扰、无关会话不 bump）、按 session 的去抖定时器互不吞掉、停止后的会话不再重发。包内全量测试绿。
