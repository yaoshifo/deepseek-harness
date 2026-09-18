# Agent Note: 选择卡还挂着时，主持人的 start 换出模式卡而不是直接启动

Status: implemented

[English](2026-09-09-chatroom-start-mode-card-guard.md) | 中文

## Problem

2026-09-08 oc_9b99f（定投场聊天室）：`pick-roles` 渲染出角色多选卡后，用户没有点卡，而是用纯文本回了「按照你推荐的角色推进」。纯文本消息不经任何过滤直达主持人会话，主持人把文本当指令直接调了 `feishu_bridge_chatroom` 的 `start`——聊天室以普通模式启动，模式选择卡（普通 / 研究·自动 / 研究·手动）从未到达用户。结构上，模式卡只存在于卡片点选路径（`executeChatroomPickAction` 的 confirm 分支武装 `chatroomModePick`），文本入口对挂起中的 picker 零拦截，`start` 动作自身也没有待决卡检查。

## Decision

守卫放在做出决定的操作里：`start` 动作（`packages/acp/feishu-bridge-chatroom/src/tools/chatroom.ts`）在 already-running 守卫与 inherit 解析之后咨询 `armChatroomModePickFromModeratorStart`（`src/engine/chatroom-pick.ts`）。角色 picker 挂起时，模式未决的多角色 start 会消费掉角色 picker（纯文本确认对阵容成立），用主持人的 roles/topic/prior 武装模式 picker 并发出模式卡；聊天室随后经由既有 `finalizeChatroomModePickStart` 链启动（含 research venv 门控）。模式卡在用户手上时重复 start 幂等。放行条件与 confirm 路径对称：显式 stash 过的 `--research` 与单角色 cast 直接启动；非法 cast（为空、超上限、幻觉角色名）穿透落下，`startChatroom` 对其照旧响亮报错。

## Alternatives considered

- **在消息入口拦截 picker 挂起期间的纯文本。** 要么挡死 picking 期间的全部用户文本，要么做自然语言意图分类；而且只覆盖文本入口——主持人从任何唤醒（含 poll 结算）都能到达 `start`。start 操作才是所有路径共享的咽喉。
- **让 start 报错拒绝。** 扔掉用户的明确确认，逼用户回头点旧卡再点模式卡——三步才能完成文本一句话已经说清的事。
- **教主持人 priming「卡挂起时别 start」。** 提示词不是 enforcement;poll 结算唤醒带着不同 priming 到达同一段代码。

## Consequences

- 测试钉住行为（`packages/acp/feishu-bridge-chatroom/tests/tools/chatroom-tool.spec.ts` 的 `start guards`）：角色 picker 挂起 → 模式卡武装、不启动、picker 被消费；重复 start 幂等；research 已 stash 与单角色 cast 穿透；超上限 cast 保持响亮的 `too many roles` 报错且角色 picker 原样保留。
- 被用户忽略的角色卡在换卡时消费——模式卡之后阵容即主持人确认过的列表；模式卡的 cancel 让用户回到全新的 `/chatroom`。
- picker 的 `'picking'` 阶段（poll 进行中）被 start 命中同样走守卫：picker 被消费、模式卡发出；poll 结算随后的 `pick-roles` 只在聊天室从未启动时才自举出新 picker。
- 部署：桥重建 + `/reload`。
