# Agent Note: 计划两层结构化——details 参数与飞书卡默认折叠

Status: implemented

[English](2026-09-10-plan-details-structured-split.md) | 中文

## Problem

[白话直讲约定](2026-09-09-feishu-bridge-plain-language-conventions.zh.md)把计划钉成两层（白话层/实施细节层），但结构只活在提示词里：`exit_plan_mode` 只有一个 `plan` 字符串参数，两层混在一段 markdown 中提交。飞书计划内容卡（`engine/plan-render.ts` `sendPlanCard`）把全量文本塞进单个 markdown 组件——长计划整屏刷过白话层，批准者要翻很久才看到决定。要在卡片上「白话层直接展示、细节层默认折叠」，前提是渲染方能**不靠解析**拿到两层的边界；而任何按标题文字/前缀/正则切分的方案都把「标题名」当合同，语言一变、模型一改写就失效。

## Decision

分层从提示词约定升级为工具入参结构，展示方按字段取值、零解析：

- **上游共享包（加法式 fork-local 改动，稳定后按惯例提上游）**：`exit_plan_mode` 增可选 `details: string` 参数（描述保持 policy-free：机制是「实施细节附录，有能力分层的 UI 默认折叠展示」；分层政策仍归部署方提示词）。`dsh-user-questions` 的 plan-review intent 增可选 `layers?: { plain, details }`——与该类型既有 presentation-only 语义一致。execute 归一化：空白 `details` 视为未提交；评审提问的 `detail` 携带两层拼合的完整计划（`plan + '\n\n' + details`，通用消费方如 web/CLI 看到完整计划、行为不变），intent 仅在提交 `details` 时携带 `layers`。
- **飞书桥渲染**：adapter `answerPlanReview` 从 intent 透传 `layers`；engine 在**没有 agent 自写 plan 文件覆盖**时把 `layers` 一路传到 `sendPlanCard`，卡片为 `[markdown(plain), collapsiblePanel(实施细节, expanded:false, markdown(details)), actions(导出)]`；`collapsible_panel` 是 schema 2.0 现成组件（每张完成卡「▸ 详细信息」生产在用）。无 `layers` 时卡片维持单 markdown 整段（旧路径与旧会话零变化）。导出按钮、落盘计划文件、审批按钮卡继续走拼合全文；PNG 渲染图是面向批准者的概览，有 `layers` 时只从白话层渲染（细节层留在卡内折叠面板与导出里；无 `layers` 的计划渲染全文——无内容被切走），渲染去重哈希随之基于渲染输入。
- **边界规则**：agent 本轮自写 plan 文件触发「文件较新则覆盖」时，卡片照旧整段展示该文件——该路径无分层结构可用，不强行切。
- **提示词**：agent 约定段「白话直讲」计划句改为两参数映射（白话层写进 `plan`、实施细节层写进 `details`），两层内涵与自检句不变。

## Alternatives considered

**桥内按 `## 实施细节` 标题 + markdown AST 切分。** 放弃：标题文字不是合同（语言、措辞、模型改写都会破），且每个渲染方都要重实现切分逻辑——用户明确否掉前缀/正则类方案。

**桥内重注册/包装 exit_plan_mode 工具。** 放弃：与 plan-mode 的注册冲突、HMR 脆弱，脏改上游行为。

**通用卡片展示模型加 `collapsed` 内容标记（dsh-tools presentCall）。** 暂缓：能让 web 等面共享折叠语义，但本次目标表面只有飞书计划卡；结构落地后随时可加。

**把 `details` 设为必填。** 暂缓：必填可机械保证分层出现，但上游共享工具对所有部署生效，先以可选 + 提示词引导落地，抽样复测填写率不达标再升必填（README 已记升级路径）。

## Consequences

- 鲁棒性分层：结构=合同（工具 schema），语义=引导（提示词），失败模式=优雅退化（不填 `details` → 卡片退回整段，内容零丢失）。
- 每 token 代价：工具常驻请求目录（进出 plan 模式只换提示词段），描述+参数说明约增几十 token/请求。
- 会话日志兼容：`tool/call` 的 `arguments` 是原始 JSON 字符串，新字段纯加法，事件 schema 不变、不升 `SESSION_FORMAT_VERSION`；旧录制回放不受影响。批准后执行零影响（模型从会话历史读自己的 tool call，两参数全量可见）。
- 已知行为：PNG 渲染完成的状态 PATCH（`cloneCardWithStatusNote`）保留面板内容，但客户端可能把用户手动展开的面板重置回收起——轻微 UX，冒烟确认后接受。
- 语义放反（细节进 `plan`）时折叠层装错内容但不丢数据，纳入既有抽样复测（`details` 填写率 + 白话层出现率）。

## Testing

`packages/plan/plan-mode/tests/plan-mode.spec.ts`：带/不带/空白 `details` 三路的 detail 拼接与 intent 形状（含 :1069 精确断言守恒）+ presentCall 两段。`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts`：intent.layers 透传与缺席不变。`tests/engine/engine-m3-plan.spec.ts`：分层卡结构（`expanded:false`、面板标题、导出按钮）、无 `layers` 不回归、按层截断。`tests/agent-dsh/adapter-persona.spec.ts`：白话直讲两参数映射措辞逐字钉定。
