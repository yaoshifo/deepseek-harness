# Agent Note: 斜杠命令分发先于挂起权限闸门

Status: implemented

[English](2026-08-22-feishu-bridge-command-before-permission.md) | 中文

## Problem

权限卡挂起期间（如 plan 评审），所有已注册斜杠命令都会被吞掉：想拆会话而敲的 `/done` 匹配不上 允许/拒绝/允许所有 任何关键词，落入 `handlePendingPermission` 的 hint 分支，被消费并回复「⚠️ 等待权限响应」。turn 停在权限等待上——等待期间不武装任何 stall 计时器——会话只能挂到用户敲关键词或按卡片按钮为止。Go cc-connect 里 `/done` 会到达 `cmdDone` 拆掉会话，经 stop 信号解除挂起的等待。

根因：M3 提交 `c86779ae21` 把**所有**消息先经 `handlePendingPermission` 再进正常分发，声称是 Go 语义——误读。Go `HandleMessage` 先分发斜杠命令（`handleCommand`，自修复 `60e20ef6` 起带 `!msg.IsAskqCardAction` 守卫，该修复正是为了命令在权限挂起期间继续可用而保留命令优先），之后才路由权限应答。TS 那个提交的动机——AskUserQuestion 自由文本答案（如 "1"）——不受命令优先影响：这些回复永不以 "/" 开头。

## Decision

`handleMessage` 恢复 Go 入站顺序：附件暂存 → session 创建 + spawn-user 捕获 → chatroom 挂起人类问题路由 → 斜杠命令分发（`!msg.isAskqCardAction && 无图片 && "/"` 前缀；未注册命令落穿）→ `handlePendingPermission` → `!` shell 快捷 → session 锁。session 创建与 spawn-user 捕获上移到分发之前与 Go 一致，避免 spawned group 首条斜杠命令丢失派发者归属。暂存上移到挂起问题路由之上，同时恢复 Go 对「挂起 ask-human 的聊天里图片-only 消息」的行为（暂存，而不是把空文本路由给角色）。

## Alternatives considered

**在权限闸门内放行特定命令白名单（如只放 `/done`）。** 否决：发明 TS 独有规则；Go 的行为就是「命令优先」，逐命令开洞会偏离被移植的 engine。

**给权限闸门加跳过 "/" 前缀消息的守卫。** 否决：未注册的 `/nope` 在 Go 里必须落穿到 hint（命令分发返回 false，权限处理消费它）；闸门跳过所有斜杠消息会让 `/nope` 漏进 agent turn。

## Consequences

权限卡挂起期间斜杠命令照常执行——`/done`、`/stop` 可以拆掉或停止会话（挂起的权限等待经 stop 信号解除；审批请求永远不被应答，agent 会话随聊天一起杀掉）。给 AskUserQuestion 敲 "/" 开头的自由文本会被当命令分发而非答案——Go 在 `60e20ef6` 接受的取舍；未注册命令仍回落权限路径。权限卡按钮载荷（`allow`、`deny\x00<note>`）永不以 "/" 开头，卡片应答两条路径下都不受影响。

## Testing

`tests/engine/engine-m3-permission.spec.ts`（"handleMessage routing: slash commands vs pending permission"）：挂起 ExitPlanMode 下 `/done` 分发命令（p2p 回复）且无 hint、pending 原样保留；"/" 开头 label 的 askq 卡片答案解析问题（answers 随权限应答回传）而非执行命令；自由文本 "1" 仍解析挂起问题（`c86779ae21` 的动机）；无关自由文本仍回 hint；未注册 `/nope` 经分发落穿到 hint。
