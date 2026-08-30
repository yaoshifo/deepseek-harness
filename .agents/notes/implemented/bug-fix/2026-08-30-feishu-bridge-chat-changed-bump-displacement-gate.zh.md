# Agent Note: feishu-bridge chat-changed bump —— 以位移台账为门

Status: implemented

[English](2026-08-30-feishu-bridge-chat-changed-bump-displacement-gate.md) | 中文

## Problem

现网观察（2026-08-30）：turn 执行期间，头像/群名变更的系统消息（agent 经 lark-cli 改头像、phase 重绘、family 盖章等）即使没有把 tool-progress 卡挤出聊天尾部，也会触发卡片的撤回重发——已被内容节拍自愈重发到通知之上的卡被再次删发，线程隔离卡（主群尾部对其话题本无意义）更是每次头像变更都白白翻动一次。[2026-08-28 位移台账](2026-08-28-feishu-bridge-preview-displacement-ledger.zh.md)刻意不记 chat-change 类通知（它们以 `im.chat.updated_v1` 到达而非消息事件），`bumpToEnd` 因此无条件重发：墓碑数等于被压次数的不变量恰在这类事件上失守。

## Decision

`onChatUpdated` 在触发 chat-changed handler 的同一分支触达逐聊天活动台账——该变更的系统消息此刻正物理落在聊天尾部，与任何消息一样计为被跟踪活动。`StreamPreview.displacedLocked` 改为三态（平台无 prober 时为 `undefined`）；内容节拍自愈要求 `=== true`，`bumpToEnd` 在判定为 `false` 时跳过——卡片仍占住尾部（已重发越过通知、在事件之后才落卡、或身处隔离话题），不发生撤回重发。无 prober 的平台维持无条件 bump。

## Alternatives considered

**以 chat-change 事件时间戳替代台账做门。** 否决：另开一条与台账目的完全重合的时间戳通道——台账用一次与 `placedAtMs` 的比较已回答「卡片之后是否落过东西」。

**chat-change 事件一律不重发。** 否决：静默工具执行段没有内容节拍可自愈，而侧栏摘要只跟踪最新消息——推送 bump 仍是静默段兜底（2026-08-26/28 的产品裁定不变）。

**bump 前查询聊天最新消息。** 否决：系统消息经消息列表 API 取不回，且每次 bump 一次读请求等于把台账删掉的轮询请回来。

## Consequences

bump 现在恰在台账判定卡片被压时触发：落在活卡之上的通知仍会把尾部夺回卡片（静默段侧栏保障不变），而已自愈与线程隔离两种情形不再产生墓碑。流式期间的卡在下一个内容节拍（~800ms）即治愈通知位移，不必等满 2 秒去抖，去抖到点的 bump 随之空转。已知残余竞态：台账触达记的是事件到达时刻，只是通知落地的近似——落在消息落地与事件到达之间重发的卡仍会多付一次重发；失败方向安全（卡片保住尾部）。

## Testing

`tests/feishu/preview-tail.spec.ts`：头像/群名变更触达台账（此前被压、此后新发卡为最新）；无 name/avatar 字段的变更不触达。`tests/streaming.spec.ts` "bump to end"：prober 判卡片在尾部时 bump 跳过、判被压时照常重发；既有无 prober 用例钉住回退行为。包测试全绿（2847 项）。
