# Agent Note: feishu-bridge 群 @ 门控放行对 bot 自己消息的回复

Status: implemented

[English](2026-08-29-feishu-bridge-group-gate-reply-to-bot.md) | 中文

## Problem

群 @ 门控丢弃一切不带 @bot 提及的群消息，而飞书的回复从不自动提及被回复消息的发送者——用户直接回复 bot 的消息会被静默忽略：不派发、无日志、无会话事件。追问卡片邀请用户打字作答在门控群里成了文字陷阱，被邀请的回复落在 bot 的卡片上却被吞掉（2026-08-26 oc_0e48d3 事故；唯一绕法是记得 @bot）。

## Decision

- 门控放行 `parent_id` 指向 bot 自己发出消息的群消息：对 bot 的回复即是对 bot 说话，无需 @。无关群消息不带 @ 仍然丢弃。
- 平台通过 `ensureApi` 一次性安装的记录型 client 包装记录每次成功发送的 message id：发送路径的调用方丢弃 SDK 返回值，client 是唯一能看到每个 `{ messageId }` 的收口（文本、卡片、preview 发送全覆盖）；`withToken` 派生 client 同样再包一层，token 刷新重试路径也记录。
- id 集合是 2048 条的 FIFO 环，长跑 daemon 内存恒定；id 全局唯一，被记录的 id 只能在它发出的群里被回复。

## Alternatives considered

- **给受影响群开 `groupReplyAll`。** 拒绝：bot 会应答群里每一条消息；门控存在的意义就是挡住群噪音。
- **被丢弃时在群里回一条提示。** 拒绝：只修了沉默，没修派发——用户的回答仍然到不了 agent。

## Consequences

- 只有直接父消息是 bot 消息的回复放行；bot 发起的话题串里父消息是另一名人类的消息时仍需 @（有意收窄的第一版）。
- 回复超过环窗口（2048 次发送之前）的 bot 消息时退回要求 @。
- `botOpenID` 为空仍然整体关闭门控，与之前一致。

## Testing

`tests/feishu/platform.spec.ts`（`group @-gate reply exception`）：不带任何提及、回复 bot 自己消息的群消息被送达 handler；不带提及的无关群消息仍被丢弃。套件：feishu-bridge 包全绿；仓库 typecheck 干净；所改文件 oxlint 干净。
