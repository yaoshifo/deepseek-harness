# Agent Note: feishu-bridge 卡片回调响应与计划卡先行顺序

Status: implemented

[English](2026-08-20-feishu-bridge-permission-card-update-and-order.md) | 中文

## Problem

交互卡上三个用户可见缺陷，均为 TS 移植时丢失的 Go cc-connect 行为。其一，点击 `‼️ 权限请求` 的允许/拒绝/全准后卡片毫无变化：Go 的 `onCardAction` perm 分支（`platform/feishu/feishu_dispatch.go`）返回携带替换卡片的 `CardActionTriggerResponse`——标题翻转为 `✅ 已允许` / `❌ 已拒绝` / `✅ 已全部允许`——飞书用回调响应原地换卡。TS 移植把按钮 `extra` 字段（`perm_label`/`perm_color`/`perm_body`）渲染进了按钮 value map、也写了 `permBodyCache`，但两者从未被读取，回调响应为空。其二，AskUserQuestion 卡有同样的缺口：Go 在回调响应里返回冻结卡（保留全部选项、选中项标 ✅/◻️、不含交互元素），单选按钮点击与多选表单提交共用该机制，背后是 `askqMetaCache`（发送时缓存全量选项集——form_submit 回调不带 `action.value`）与按消息去重的 `askqAnswered`；TS 移植派发了答案却什么都不返回。其三，审批卡有时先于计划卡到达：Go 的 `sendPlanCard` 与 `sendPermissionPrompt` 是同步阻塞调用，计划 → 审批顺序结构性成立；TS 移植对两次发送都 fire-and-forget，两个并发飞书 HTTP 调用按服务端接收时间竞速——小的审批卡经常跑赢大的计划卡。

## Decision

`onCardAction` 的 perm 分支照 Go 构建结果卡片——`action.value` 带 extra 时直接用，否则走固定回退标签（`✅ 已允许` 绿 / `❌ 已拒绝` 红 / `✅ 已全部允许` 绿）、拒绝理由引用为 body、剩余 body 从 `permBodyCache` 取——并以 `{ card: { type: 'raw', data: renderCardMap(...) } }` 返回。askq 分支（单选与多选）返回由 `askqMetaCache` 构建的冻结确认卡（`cacheAskqMeta` 在每次 `sendCard`/`replyCard` 时写入、提交时读后删；缓存丢失时退化为最小 `→ label` 确认卡），`askqAnswered` map 按卡片消息去重重复回调。卡片经 WS 长连接回传：node-sdk 的 `WSClient` 会把 `EventDispatcher` handler 的返回值 base64 后放进回调响应 payload（`es/index.js` 的 `handleEventData`），与 Go oapi-sdk-go 同一机制。为让该值流通，`wsEventRegistrations` 与 `wsStart` 的 raw-event 回调现在透传 handler 返回值；其余路由事件照旧返回 `undefined`，响应保持为空不变。顺序方面，`sendPlanCard` 返回发送 promise（handle 记录仍在 `.then` 里），`sendPlanContent`/`sendInlinePlanContent` await 它，`permission_request` 分支先 await 计划卡发送完成再 `await sendPermissionPrompt(...)`——在事件循环 park 等用户回答之前恢复 Go 的同步发送顺序。

两处对 Go 的刻意偏离（均已在代码注释记录）：`permBodyCache` 条目在 perm 回调后无条件删除（Go 只在读缓存时删除，带 extra 的回调会让陈旧条目存活到下一张权限卡）；多选分支继续派发引擎协议串（`askq:{q}:{i1},{i2}`）由引擎侧解析标签，而非 Go 的平台侧解析——TS 移植里引擎解析器已经拥有该映射。

## Alternatives considered

**PATCH 被点击的卡片而非回调响应。** `act:`/`nav:` 分支已有 `refreshCard`/`cardActionMsgIDs` 的 PATCH 先例，本可沿用。未选为主路径：PATCH 是第二次网络往返且与用户的下一次视图竞速；回调响应是原子的，也正是 Go 的做法。若 WS 回调响应在真机上被证伪，PATCH 模式是既定的回退方案。

**把所有发送串行化进 per-session AsyncSender。** 能全局修复顺序，但 AsyncSender 是为预览 PATCH 合并而存在的，不是为聊天顺序；把每张卡的发送都路由进去对延迟特性的影响远超所报缺陷。

**固定回退标签的 i18n key。** Go 在平台层硬编码中文标签，且平台的 dispatch 路径已有硬编码面向用户的中文（`export:` 失败提示）。为三个字符串给平台层引入 i18n 依赖是范围扩张；保形字面量胜出。

## Consequences

点击反馈即时且原子——用户按的那张卡直接变成结果态（或冻结的选择记录），无多余消息，权限卡与 AskUserQuestion 卡在作答后不再可交互。`permBodyCache` 与 `askqMetaCache` 条目用后即清，陈旧的 body 或选项集不会泄漏进下一张卡；`askqAnswered` 每张已作答的卡消息增加一条且永不清理（Go 的 sync.Map 同样如此）。计划卡发送现在阻塞事件循环直至飞书接收（或回退纯文本发送完成）；慢的计划卡发送会让审批卡晚一个 RTT——与 Go 的取舍相同。全部改动都需真机冒烟（reload.sh + 一次 plan mode 轮次与一次 AskUserQuestion 轮次）后才可 M8 cutover；WS 回调响应路径此前从未被本移植验证过。

## Testing

`tests/feishu/card-action.spec.ts`：perm 分支（extra 路径含缓存清理、form_submit 回退 + 缓存消费、拒绝理由引用 body、allow_all 标签、非 perm 动作无卡片响应）、WS 返回值透传，以及 askq 分支（单选/多选的发送时 `cacheAskqMeta`、冻结卡标记选中子集、单选冻结卡、无缓存时的最小回退、按消息去重）。`tests/engine/engine-m3-plan.spec.ts` 的 `PlanCardBeforePermissionCard` 用闸门挂起计划卡发送，断言审批卡在闸门打开前不启动——红灯阶段精确复现了所报的顺序颠倒。包级全套 1890 绿；`tsc --noEmit`、`verify-export-jsdoc` 与包级 lint 干净。
