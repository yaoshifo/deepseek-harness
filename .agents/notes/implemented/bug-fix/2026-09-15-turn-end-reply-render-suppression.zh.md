# Agent Note: 抑制转交型会话的回合末 reply 渲染

Status: implemented

[English](2026-09-15-turn-end-reply-render-suppression.md) | 中文

## 问题

投机 reply→HTML 渲染（#48）的两个触发点守卫不对称。交互前位点（ask 前挂起，`captureReplyForExport` → `renderAndDeliverReply`）查了 `Session.shouldSuppressAutoRender`，而 `handleResultEvent` 里的回合末位点没查——该守卫自 M7-a 移植（ffbaebae95）Go `EventResult` export 块起就缺失。于是每个「产出转交别处」的会话仍会 fork 渲染会话（LLM fork + Chromium 栅格化 + 图片上传），投递一张没人要的本地 HTML 总览：

- chatroom 角色群（「聊天室·<角色>」）：回复在回合末转给主持人 hub；
- 研究助手（「聊天室·助手·<角色>」）、数据管家、以及一切普通子任务子会话：回复报给父会话。

生产 profile 上这是活成本：启用 chatroom 的项目（知识驴）开着 `planRender.enabled: true`，2026-09-13 场次复盘统计 81 个会话中 43 个是渲染 fork。2026-09-14 的分档回滚 note（[2026-09-14-reply-render-tier-revert.zh.md](2026-09-14-reply-render-tier-revert.zh.md)）关闭了长度分档路线，把成本留作未解项；浪费恰好集中在转交型会话上。

## 决策

`handleResultEvent` 的回合末触发点现在套用与交互前位点相同的谓词：`planRenderEnabled && length >= defaultReplyPreRenderLen` 条件追加 `!session.shouldSuppressAutoRender(this.bridge)`。谓词本身已带既定豁免：

- chatroom 角色经 `feishuBridge/auto-render-policy` 瀑布抑制（chatroom 包：`chatroomHubKey !== ''`）；
- 子任务子会话经内建 `subtaskDepth > 0` 基线抑制；
- 用户接管恢复渲染（`userInterjected`），监控子会话保持豁免。

主持人 hub、直聊角色、普通用户会话照常渲染——它们的读者就是用户，遵循「每条达标（≥500 rune）的用户面回复保留 fork 渲染卡」的产品裁定。

## 考虑过的替代方案

- **把检查收进 `renderAndDeliverReply` 内部。** 否：两个调用位各自决定何时 fork；挂起位点已在触发处检查，镜像它保持一处一个惯用法，函数契约（尽力而为的 fork）不动。
- **把抑制扩到直聊角色（`chatroomDirectRole`）。** 本次不做：直聊角色是与用户的一对一对话，读者就是用户，与普通会话同类。以后要加很便宜。
- **同时给 ExitPlanMode 的 plan 渲染位点加闸。** 不取：plan 渲染只发生在用户面的计划审批流；moderator 被降级永不进 plan，角色不走 `exit_plan_mode`。

## 后果

- 转交型会话（chatroom 角色、研究助手、所有启用 plan_render 项目的子任务子会话）不再 fork 回合末渲染——2026-09-13 复盘登记的未解成本项在「产出在别处消费」的会话上正中解决。用户面回复行为不变，保住分档回滚的裁定。
- 回合末的 `exportContent` 缓存不变：被抑制会话的绿卡导出按钮仍可用（导出的是文本，不是渲染）。
- 测试：`plan-render-fork.spec.ts` 的 `turn-end reply-render suppression` 用真实事件循环（`processInteractiveEvents`）驱动 chatroom 形 policy listener、子任务深度会话、用户接管会话；普通会话的正向控制是 `PreRenderAutoDelivers`。
