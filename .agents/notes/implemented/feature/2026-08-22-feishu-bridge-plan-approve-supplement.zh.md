# Agent Note: 计划审批的补充说明经 steer 注入

Status: implemented

[English](2026-08-22-feishu-bridge-plan-approve-supplement.md) | 中文

## Problem

ExitPlanMode 权限卡只有一个自由文本输入框，但只有拒绝按钮会读它：点「允许」（或「全部允许」）时用户填的文字被直接丢弃，想表达「同意这个计划，同时追加 X」只能先拒绝并写理由、再审一遍新计划。补充文字必须与批准在同一轮到达模型——事后到达会被读作新任务，而不是所批准计划的附加要求。

最直接的编码方式被 seam 禁止：`exit_plan_mode` 把评审答案上的任何 `custom` 都当作「继续规划」反馈（`plan-mode/src/index.ts`），且 user-questions 契约本就规定单选题的 `custom` 覆盖 `selected`。批准答案必须保持仅 `selected`。

## Decision

补充文字以 steer 的用户消息送达，复用 `/ps` 通道（[ps steer](2026-08-21-feishu-bridge-ps-steer.md)）：

- 卡片表单字段由 `deny_reason` 改名 `perm_note`，变为双用途。计划审批卡（toolName `ExitPlanMode`）的 placeholder 同时说明两种语义；普通工具卡维持仅拒绝的措辞。
- `onCardAction` 对 allow 与 allow-all 也读 `form_value.perm_note`，按 deny 已有的方式编码为 `allow\x00<note>` / `allow all\x00<note>`；原地换卡对两种裁决都把 note 以引用行展示在 body 下方。
- `handlePendingPermission` 在 allow/allow-all 上把 note 作为 `message` 转发（原文——只有 deny 路径用原生拒绝前导包装）。
- `answerPlanReview` 把非空的 allow 侧 note 以逐字用户消息 steer 进去（`AgentSession.steer`），批准答案保持仅 `selected`。决定 settle 时 `exit_plan_mode` 工具调用仍在 await 该 ask，agent 处于 running 态，inbox 消息在下一个 step 边界被领取——模型在同一个请求里看到批准 tool_result 与补充文字。

## Alternatives considered

**扩展 user-questions/plan-mode 契约，允许评审答案 `selected` + `custom` 并存（多选语义）。** 否决：影响面不成比例——单选题 `custom` 覆盖 `selected` 是 seam 的既定契约，改动波及 plan-mode、user-questions、apiproxy schema、Web UI 与 cc-connect-bridge，却只为一个桥端的 UX。仅当产品要在所有界面提供该手势时再重提。

**给 steer 文字加前缀（如「批准补充：…」）。** 否决：逐字转发保真用户输入，placeholder 已说明用途，且 `/ps` 的 steer 也是逐字——包装只带来转述风险，不带来清晰度。真机冒烟若发现被误读为新任务，再走此升级路径。

## Consequences

带补充批准计划只在飞书卡片流程生效；纯文本裁决（`allow <文字>`）仍是整词匹配，cc-connect-bridge / Web UI 行为不变。普通工具权限也会把 allow 侧 message 上传到 approval answerer，后者仍会丢弃（与丢弃 deny 理由的既有行为一致）——这是本次改动暴露出的移植缺口，另行上报。若用户在 settle 到 steer 的窗口内停止轮次，steer 由下一轮领取而不是丢失。

## Testing

`tests/feishu/card-action.spec.ts` 锁定 allow/allow-all 的 `perm_note` 编码、留空时的裸 allow、换卡上的引用行；`tests/engine/engine-m3-permission.spec.ts` 锁定三种裁决的 note→message 转发与裸 allow 的缺省；`tests/agent-dsh/adapter.spec.ts` 锁定仅 `selected` 的答案加恰好一次逐字 steer、无 note 或全空白时不 steer、deny 路径不变。
