# Agent Note：/spawn 与 /fork 的父群跳转通知

Status: implemented

[English](2026-09-07-feishu-bridge-parent-jump-notice.md) | 中文

## Problem

/spawn 或 /fork 创建子群后，父群只收到一个 Done 表情回应。新群是独立的会话，用户只能去会话列表里手动找。就绪卡（含 ↩ 父群面包屑）发进的是子群，它服务于子会话的定位，帮不到留在父群的用户。monitor 早已为其排查群解决了同一个定位问题（sendMonitorSpawnNotice：卡片 + 跳转按钮），而用户手动触发的 spawn 家族一直没跟上。

## Decision

spawnGroupCommon（src/engine/commands.ts）向父群发送的通知卡**唯一元素就是跳转按钮**：无头部、无文字行——一个 primary 按钮进入子群（spawn_jump_btn），URL 为 chatJumpURL(platform, extractChannelID(子群 session key))，即飞书客户端里打开子群的 AppLink。两次用户裁定塑造了它（均在 2026-09-07）：先是卡片取代 Done 表情成为父群唯一的成功信号，随后卡片被精简到只剩按钮——按钮文案承载全部语义。通知发送失败被捕获并告警，不影响建群流程本身。

sendAsCardWithButtons 获得两个泛化：header 标题为空时不渲染头部（飞书渲染器与纯文本降级本就兼容无头卡）；标题与正文皆为空时，纯文本回退降级为按钮的链接行，绝不发送空消息。无会话跳转 URL 的平台父群完全无反馈——生产环境只有飞书，总能产出 URL。子任务子群与 monitor 群不在此列：子任务面板已在父群聚合子群可见性与跳转链接，monitor 有自己的通知。

## Alternatives considered

**只按字面需求做 /fork。** 否决：/spawn 与 /fork 共用 spawnGroupCommon 且定位缺口完全相同；按命令加开关只会把两个平行值拆开，用户侧毫无收益。

**按页脚/容量卡的按钮惯例把群名放在按钮上。** 否决：LLM 群改名开启时，群以占位名创建并在数秒内被异步改名，带名的按钮上线即过期；通用动词文案不会过期。

**保留 Done 表情作为失败回退信号。** 否决：与卡冗余（用户裁定）。接受的取舍：卡发送失败时父群不再有即时反馈——失败有日志，群仍会出现在会话列表里。

**文字行 + 按钮两元素（去 header 后）。** 评审中被否决：用户裁定文字并入按钮——「进入子群」四个字同时说明了发生了什么和按钮通往哪里。

## Consequences

每次用户手动 spawn，父群只得到一个交互元素：跳转按钮。cc-connect 的 spawnGroupCommon 没有父群通知且会加 Done 表情，本改动在两个方向上都偏离 Go parity；偏离是刻意的 fork-local 决定，稳定后仍是上游 seam 提案候选。通知的 i18n 面只剩单键（spawn_jump_btn）；中间形态的 spawn_parent_notice_title 键同日新增又移除。无跳转能力的平台父群静默。

## Testing

tests/engine/commands.spec.ts 的 /spawn //fork parent jump notice（4 例）：按钮独占卡形态（无 header、单一 actions 元素、一个 primary 跳转按钮）、去表情裁定（两命令后 reactions 均为空且卡片在场）、/spawn 对称用例、无跳转平台跳过（无按钮卡、无 applink 泄漏、建群不受影响）。readiness 卡测试按紫色头部结构性选卡而非按索引。
