# Agent Note: chatroom 低危守卫批次

Status: implemented

[English](2026-09-03-chatroom-lowrisk-guard-batch.md) | 中文

## Problem

2026-09-03 审计留下四个低危守卫与文案缺口。（1）`askRole` 缺少兄弟路径都有的人类提问挂起守卫：向正挂起 ask-human 的角色 ask 会注入第二个在途问题，一次性 relay 门随即丢弃两条回复之一。（2）工具的 `start` 既没有 `/chatroom` 命令路径的 already-running 守卫（重复 start 会在活 hub 下再 spawn 一代角色群），也没有成员会话守卫——命令路径的重入检查只看调用会话名下的角色，角色群里发 `/chatroom` 会把角色变成嵌套主持人（`chatroomModerator` 与外层 `chatroomHubKey` 并存）。（3）不属于任何聊天室的普通会话调 `end` 报的是 moderator-only 诊断（误导，且指向的 /chatroom stop 自己会答 not-in-room）；角色会话调 `note` 按自身 key 解析账本目录，抛裸 ENOENT。（4）research priming 的替补管家引导暗示用 `assistant` 别名再派，而预配 key 仍为空时别名解析必然报错。

## Decision

- `askRole` 镜像 gather 的人类提问挂起守卫，抛新键 `chatroom_ask_pending_human_blocked`。
- 两条 start 路径按序守卫：先成员会话（`chatroomHubKey !== '' || researchAssistant` → `chatroom_start_member_forbidden`），工具路径再查 already-running（`ChatroomAlreadyRunning`）。命令路径保持回复式守卫；工具路径抛错。
- `end` 区分 `''`（不在任何聊天室 → `chatroom_not_in_room`）与解析到外部 hub（moderator-only，不变）。`note` 以同样方式解析 hub，非主持人在任何账本目录解析之前即被 `chatroom_note_moderator_only` 拒绝。
- 替补管家引导改为用 spawn 返回的 child 会话键派任务——`assistant` 别名解析不到替补。原担心的会话泄漏在实际路径不成立：工具 spawn 生成 native child，`finalizeChatroomEnd` 经 `drainNativeDescendants` 排空 hub 的原生后代（与所有子代理一致）；只有群路径预配的管家才需要 `researchAssistant` 分类。

## 备选方案

**工具路径沿用命令路径的回复式守卫。** 否决：工具调用方消费的是错误结果而非聊天回复——工具路径抛结构化错误码（`ChatroomAlreadyRunning`、新的成员禁止错误），只有 `/chatroom` 命令路径保持回复式守卫。

**扩展命令路径的重入检查使其看到所有角色。** 否决：该检查按调用会话名下的父子关系可见性本就是错误的接缝；成员会话守卫（`chatroomHubKey !== '' || researchAssistant`）为两条路径共享，从根上关掉嵌套主持人漏洞，而不是放大某一个调用方的视野。

**预配 `assistant` 别名让替补管家引导保持原样。** 否决：用 spawn 返回的会话键派任务不需要新的解析面，别名继续只指向群路径预配的管家。

## Consequences

- 测试：挂起人类提问时 ask 拒绝且不武装角色；工具重复 start 与角色会话 start 都在 `startChatroom` 之前拒绝；角色会话发 `/chatroom` 收到成员禁止回复且不装嵌套主持人标志；普通会话 end/note 报 not-in-room；角色会话 note 报 moderator-only 而非 ENOENT。routing-proof 测试的 note 断言随行为更新（not-in-room 先于 moderator-dir 检查）。
- chatroom i18n 子表新增四键（`chatroom_ask_pending_human_blocked`、`chatroom_start_member_forbidden`、`chatroom_not_in_room`、`chatroom_note_moderator_only`）；头部计数注释跟随实际总数。
- 相关：`2026-09-02-feishu-bridge-chatroom-followup-guards`（本批次补全的早前互锁批次）、`2026-09-03-chatroom-research-in-turn-conclusion-relay`。
