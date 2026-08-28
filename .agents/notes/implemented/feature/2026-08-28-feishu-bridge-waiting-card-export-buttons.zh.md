# Agent Note: feishu-bridge 等待中卡片携带导出/查看按钮行

Status: implemented

[English](2026-08-28-feishu-bridge-waiting-card-export-buttons.md) | 中文

## 问题

ask 或审批挂起 turn 时，`captureReplyForExport`（engine.ts，在 `completeAndDetach(true)` 之前调用）已经把部分回复——优先实时播报尾段、回退全文——以进度卡的 message ID 为 key 注册进 `InteractiveState.exportContent`。卡片随后渲染蓝色「等待中」头（见[ parked-ask 上限豁免笔记](../bug-fix/2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.zh.md)）。但 `injectReplyButtons` 只在绿色头上注入，用户停在选项卡前没有任何途径取回这段文本：实时播报段在卡片上可能被截断，turn 不结算这个 export key 就一直用不上。用户看得到 agent 的提问，却看不到提问之前的那段回复。

## 决策

`injectReplyButtons`（progress.ts）在绿色**和**蓝色头上注入「📄 导出文件」/「💬 查看完整回复」行。蓝色安全的前提是：进度卡 PATCH 路径上的蓝色模板只由 park 进入的 `waiting` 状态产生，而 park 之前 `captureReplyForExport` 已用按钮携带的同一 key 注册了部分回复；任何新的蓝色进度状态都必须排除在该前提之外。点击链路（`export:`/`sendreply:` → engine 的 export handler）不变，包括回退 `lastBaseResponse` 的语义。

## 被否决的替代方案

**执行中（黄色）卡片也注入。** 否决：本 turn 的内容要到 EventResult 的 export 块才注册，点击会回退到上一轮回复——误导；且执行中卡片的实时播报持续更新，全文尚未冻结。

**park 未捕获到文本时在 key 下注册空串。** 否决：export handler 把空注册当失败，这会让常见路径——用户作答、turn 完成后，旧 park 卡的按钮正确回退到 `lastBaseResponse`（此时已是本轮最终回复）——退化成「未找到对应内容」。

**park 时把部分回复直接发成聊天消息。** 否决：推测式回复渲染（`renderAndDeliverReply`）已在 park 时交付超阈值文本，短段在卡片上可见；多发消息是噪音。

## 后果

等待中卡片携带两行按钮：「⏹ 停止执行」加导出/查看行。用户作答后卡片照常变绿并保留按钮，park 时的部分内容仍可取回。plan-review park 时，蓝色 Tool Process 卡导出 plan 之外的段落，plan 卡导出 plan 本身——互补。无前置文本的 park（turn 先提问）导出时回退上一轮回复，与绿卡既有回退语义一致。同样遗留：已停止（⏹ 已停止）和失败（红色）卡片仍无导出入口——同一个取回缺口，本次未处理。

## 测试

`tests/feishu/progress.spec.ts` injectReplyButtons 用例表：蓝色注入两个按钮；黄色、紫色、红色不注入。
