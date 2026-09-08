# Agent Note: 纯文本题目也必须走到角色选择卡——用自举取代报错

Status: implemented

[English](2026-09-08-chatroom-plain-text-topic-picker-bootstrap.md) | 中文

## Problem

2026-09-07 oc_94b41a 事故（「飞书群测试」chatroom 测试）：用户裸敲 `/chatroom`，主持人的 #59 选题卡给了 5 个候选，而用户想聊的题不在其中——卡上没有自由输入框，用户只能把 `题目：中国金融市场…` 当普通消息打出来。普通消息绕过 `cmdChatroom`，`beginChatroomPick` 从未执行，#43 角色 picker 状态从未武装。主持人（被普通消息唤醒，按 #59 priming 预告的剧本自行组织）完成了开场全员 poll，随后调 `pick-roles` 撞上 `chatroom: picker not active`——硬报错且无恢复路径，因为没有任何工具动作能武装 picker。主持人优雅降级（自行定阵容并开局），但用户无声地失去了整条引导流程本要提供的角色选择卡。

两个缺口，一次事故：#59 卡没有自定义题目逃生口；`pick-roles` 把 picker 状态缺失当终态而不是可修复态。

## Decision

- **`pick-roles` 缺状态时以 `topic` 参数自举**（`packages/acp/feishu-bridge-chatroom/src/engine/chatroom-pick.ts` 的 `bootstrapChatroomPick`，接线在 `src/tools/chatroom.ts`）：武装状态缺失且调用带非空 `topic` 时，引擎就地武装状态（角色名单从配置目录现列），既有渲染调用照常推卡。以 hub 的 `chatroomModerator` 标记守卫——已开场的房间拒绝重新武装；无状态且无 `topic` 的调用返回点名该参数的引导错误，让模型驱动的主持人正确重试。不唤醒、不布 picking watchdog：主持人本就在回合中且带着推荐而来。
- **#59 选题卡带自由输入框**（`renderChatroomTopicPickCard`）：一个 Feishu form，含单行输入与 `form_submit` 按钮。表单提交会丢 `action.value`，所以平台层的 name 恢复链把按钮名 `chatroom_topic_custom_submit` 映射到 `act:/chatroom-topic-pick custom`，输入值经 `form_value.chatroom_topic_custom` 追加进 act 载荷（`packages/acp/feishu-bridge/src/feishu/platform.ts`）。picker 状态机新增的 `custom` 分支把输入题目送进与点选候选完全相同的 `finalizeChatroomTopicPick` 交接；空提交保留卡片并给出先选题提示。

## Alternatives considered

- **教主持人（priming）让用户重敲 `/chatroom <题目>`。** 多一轮往返，且依赖 prompt 遵循——恰恰在引擎已丢状态的瞬间；根缺口（候选之外的题目没有卡片逃生口）仍在。
- **对普通文本做题目意图识别并自动武装。** 引擎无法可靠区分题目消息与运行中插话；误触发会在讨论中途武装 picker。
- **延长 picking watchdog。** 本案 watchdog 从未触发——状态根本没建立过；延长窗口治的是另一种失败。

## Consequences

- 测试钉住两条腿：带 `topic` 的 `pick-roles` 经自举渲染出卡（卡体含角色与题目）；无状态无 `topic` 报含提示的错误；已开场的 hub 拒绝（`already runs`）；自举状态确认后进入模式卡，与命令武装的状态行为一致；custom 提交以输入题目武装角色 picker 并换成过渡卡；空 custom 提交保留卡片带提示；平台层派发 `act:/chatroom-topic-pick custom <题目>` 且修剪首尾空白。
- `topic` 参数在 picker 已武装时无效——它只为自举而生，工具 schema 如此描述。
- 自举状态存空 `userID` 与 `'group'` `chatType`：确认链的 `afterChatroomStarted` 两者都不消费，`renameHubToTopic` 仅在 `'p2p'` 时跳过。
- 部署：两个包重建 + `/reload`；无配置或账本变更。
