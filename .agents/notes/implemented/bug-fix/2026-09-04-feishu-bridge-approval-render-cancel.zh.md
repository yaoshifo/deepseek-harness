# Agent Note: 审批批准不再终止 in-flight 渲染

Status: implemented

[English](2026-09-04-feishu-bridge-approval-render-cancel.md) | 中文

## Problem

2026-09-04 oc_3b2fa 群事故链：`/provider` 切到 glm-5.3-flash 后，第一次 bash 提权弹卡（全准记忆按 Agent 实例记，新会话清零），审批 park 时触发的 speculative reply 渲染（超阈值的 pre-ask 文本段，`engine.ts` deliverCards → `renderAndDeliverReply`）在 8 秒后被用户批准按钮的 `cancelRenders` 杀掉；turn-end 兜底渲染因最终回复低于 `defaultReplyPreRenderLen` 阈值不触发——该段（模型外显的完整计划文本）永久失去渲染投递，只留在过程卡上。结构性原因：权限审批的决策耗时（秒级）与渲染 fork 耗时（~12s）的量级差，使 Go `handlePendingPermission` 遗留的「用户响应即无条件取消」对 speculative render 几乎必杀；plan 渲染当日 33 次投递全部幸存，只因用户读计划卡的时间普遍超过渲染耗时。`cancelRenders` 自述的取消动机是省 token（stale render 不值得烧），而批准场景下渲染内容是本 turn 的有效投递物，并不 stale。

## Decision

`routeAskResponse` 的 `cancelRenders` 改为条件执行：pending ask 存在、`kind !== 'questions'`、且 `parsePermissionVerdict(content)` 为 allow 或 allow-all（卡片按钮与自由文本等价）时跳过取消——批准结算 ask 并恢复 turn，pre-ask 段的 in-flight 渲染仍是有效投递（2026-09-09 起豁免按渲染归属收窄：plan 卡渲染随批准取消、仅 reply 投机渲染保留豁免，见 [批准豁免按渲染归属收窄](2026-09-09-feishu-bridge-plan-render-approval-cancel.zh.md)）。其余响应（deny、questions 的任何回答、无 pending 的过期按钮）维持 Go 语义取消；其余四个 `cancelRenders` 调用点（新 turn 入口、interactive 状态清理、会话停止、卡片导航按钮）不变。

## Alternatives considered

- **被取消段标记为待 turn-end 重试。** 单飞保护（`preRenderRunning`）与 `exportContent` 导出按钮已提供兜底，且 turn-end 的 `displayReplyText` 只含 trailing 段，重试语义需要新引入段落归属状态，改动面大。
- **移除 routeAskResponse 的全部取消（一切响应豁免）。** questions 部分回答后 ask 继续 parked，渲染完成落群会把 parked 卡顶离群尾，引入新的 UX 面；真正的 stale 场景（新 turn、会话停止）已由各自入口的取消覆盖，但过期按钮等边界随之漂移。

## Consequences

- 测试：`engine-ask.spec.ts` 新增 `routeAskResponse render-cancel semantics` describe，经公共接口（`askUser` + `registerRenderCancel` + `routeAskResponse`）钉住批准形态不取消 reply 渲染（`perm:allow`、`perm:allow_all`、自由文本「允许」）与三个保留取消形态（deny、questions 回答、无 pending 过期按钮）；plan-review 批准的现行语义（plan 渲染取消、reply 存活）由 [09-09 收窄笔记](2026-09-09-feishu-bridge-plan-render-approval-cancel.zh.md)记录。
- 已知边界：questions 回答仍取消渲染（同构场景未修），由 turn-end 兜底与导出按钮覆盖；批准后渲染完成时 turn 已恢复，图落群触发新过程卡 `bumpToEnd` 回底，均为既有机制；渲染未完成时 turn-end 的 `renderAndDeliverReply` 仍被单飞跳过（现状不变）。
- 部署：构建后用户手动 `/reload`；活体验证信号：权限审批等待期启动的 `reply-html` fork 在批准后日志出现 `render session completed` 而非 `cancelled`。
- Go parity：有意偏离 `handlePendingPermission` 的无条件取消，`engine.ts` 注释记录案例与理由；若上游后续吸收撞到本改动，以本包测试套件裁决。
