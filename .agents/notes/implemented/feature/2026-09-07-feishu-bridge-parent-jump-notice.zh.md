# Agent Note：/spawn 与 /fork 的父群跳转通知卡

Status: implemented

[English](2026-09-07-feishu-bridge-parent-jump-notice.md) | 中文

## Problem

/spawn 或 /fork 创建子群后，父群只收到一个 Done 表情回应。新群是独立的会话，用户只能去会话列表里手动找。就绪卡（含 ↩ 父群面包屑）发进的是子群，它服务于子会话的定位，帮不到留在父群的用户。monitor 早已为其排查群解决了同一个定位问题（sendMonitorSpawnNotice：卡片 + 跳转按钮），而用户手动触发的 spawn 家族一直没跟上。

## Decision

spawnGroupCommon（src/engine/commands.ts）在 Done 表情之后、子群就绪卡之前，向父群发送一张通知卡：indigo 头部 🌿 已创建子群（spawn_parent_notice_title），正文引用首消息并按 200 runes 截断（truncateMonitor），命令未携带消息时回落为就绪文案；一个 primary 按钮进入子群（spawn_jump_btn），URL 为 chatJumpURL(platform, extractChannelID(子群 session key))——即飞书客户端里打开子群的 AppLink。通知发送失败被捕获并告警，不影响建群流程本身。无会话跳转 URL 的平台保持仅表情回应的旧行为：不发死按钮卡、不泄漏 applink，对齐 monitor 通知的纪律。

/spawn 与 /fork 共用该骨架，无按命令的开关。子任务子群与 monitor 群不在此列——子任务面板已在父群聚合子群可见性与跳转链接，monitor 有自己的通知。

## Alternatives considered

**只按字面需求做 /fork。** 否决：/spawn 与 /fork 共用 spawnGroupCommon 且定位缺口完全相同；按命令加开关只会把两个平行值拆开，用户侧毫无收益。

**按页脚/容量卡的按钮惯例把群名放在按钮上。** 否决：LLM 群改名开启时，群以占位名创建并在数秒内被异步改名，带名的按钮上线即过期；通用动词文案不会过期。

## Consequences

每次用户手动 spawn，父群多一张卡——噪音可接受，因为每张卡都对应一条用户刚输入的命令。cc-connect 的 spawnGroupCommon 没有父群通知，这是对 Go parity 的刻意 fork-local 偏离；稳定后按 fork 二开原则是上游 seam 提案的候选。无跳转能力的平台不受影响。

## Testing

tests/engine/commands.spec.ts 的 /spawn //fork parent jump notice（4 例）：fork 通知卡与跳转按钮及任务引文、/spawn 对称用例、无跳转平台跳过（无按钮卡、无 applink 泄漏、建群不受影响）、无消息时正文回落就绪文案。readiness 卡测试改为按紫色头部结构性选卡而非按索引，因为通知卡现在先于就绪卡进入同一个记录器。
