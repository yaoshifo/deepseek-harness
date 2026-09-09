# Agent Note: 批准豁免按渲染归属收窄——plan 卡渲染随批准取消

Status: implemented

[English](2026-09-09-feishu-bridge-plan-render-approval-cancel.md) | 中文

## Problem

2026-09-09 用户报告：plan 卡片图片仍在「渲染中」时点击允许按钮执行 plan，渲染 fork 完成后仍把 PNG 投递落群——迟到的 plan 图片插进执行中的过程消息流。根因是 2026-09-04 豁免（见 [审批批准不再终止 in-flight 渲染](2026-09-04-feishu-bridge-approval-render-cancel.zh.md)）按「响应是批准」放行全部 in-flight 渲染，不区分渲染归属：oc_3b2fa 事故要保的是 speculative reply 渲染——审批决策秒级而渲染 fork ~12s 的量级差使无条件取消几乎必杀，且渲染内容是本 turn 的有效投递；plan 卡渲染在批准后 stale——plan 已在执行、迟到图片只是落群打扰，且 plan 内容有卡片 markdown 与 export 按钮兜底。09-04 当日 33 次 plan 投递全部幸存只因读卡时间普遍超过渲染耗时，批准快于渲染的用户必然撞上豁免分支。

## Decision

`routeAskResponse` 的批准分支从「不取消」收窄为「按归属取消」：`RenderCancelHandle` 带 `kind: 'plan' | 'reply'`（与 `RenderStatusEntry.kind` 同构），`registerRenderCancel` 第三参声明归属（`launchPlanRender` → plan、`renderAndDeliverReply` → reply）；批准 verdict（permission 与 plan-review，卡片按钮与自由文本等价）改为调用新增的 `cancelPlanRenders(state)`——只摘除并取消 plan 归属句柄，reply 句柄留在集合继续投递。deny、questions 回答、过期按钮的无差别 `cancelRenders` 与其余调用点（新 turn 入口、interactive 状态清理、会话停止、卡片导航按钮）不变。

## Alternatives considered

- **批准后 plan 渲染改静默投递（不落群、只 PATCH 卡片状态行）。** 保住投递但没消除打扰的主体（渲染 token 照烧、状态行照变），且同一 `deliverRenderedImage` 分叉出两条投递形态，改动面大于收益。
- **维持 09-04 豁免现状。** 用户明确报告了打扰；plan 已批准的语境下迟到图片价值存疑，export 按钮兜底已足。

## Consequences

- 测试：`engine-ask.spec.ts` render-cancel describe 反转 plan-review 批准用例（plan 句柄被取消）、新增 plan-review 批准下 reply 句柄存活用例（oc_3b2fa 回归保护）、permission 批准三形态改传 `'reply'`；`plan-render.spec.ts` RenderCancels describe 适配三参签名并新增 `cancelPlanRenders` 直接用例。
- 批准早于渲染完成（~12s 内）的用户不再收到 plan 图片；plan 内容经 plan 卡 markdown 与 export 按钮可达。
- 既有瑕疵不动：渲染完成与投递之间被取消的 plan 渲染走 catch 分支标 `failed` 而非 `cancelled`。
- 部署：构建后用户手动 `/reload`；活体验证信号：plan 卡「渲染中」时点击允许，卡片状态行转「✘ 已取消」且群内无迟到图片，日志出现 `plan-render: cancelled` 而非 `delivering image`。
- Go parity：在 09-04 已偏离的基础上再收窄一步；上游吸收冲突时以本包测试套件裁决。
