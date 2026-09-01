# Agent Note: The agent-instructions suppression seam lives on the host plane

Status: implemented

[English](2026-09-07-agent-instructions-suppression-host-plane-service.md) | 中文

## Problem

fork 曾把 `dsh-agent-instructions` 从上游的函数插件改造成 Cordis `Service`，以便桥 adapter 能为裸 persona 与 render-fork 会话调用 `suppress()`（对齐 Go 的 `--bare`：这类会话不做工作区指令注入）。2026-08-29 同步到来的上游 agent-presets 挂载规则拒绝「preset 行发布进程级服务」，而随产品交付的 preset 恰好以普通行挂载本插件——于是 13 个 web-agent-presets e2e 测试全部失败，报 `row(s) published process-global service(s) [agentInstructions]`。桥部署本身从不触发该规则（它经 dsh-base 以宿主面挂载插件），所以破损只在 web 应用的测试套件里暴露。

## Decision

插件回归上游的无服务函数插件形态，抑制状态移入独立的 `AgentInstructionSuppression` 服务，经 `@deepseek-ai/dsh-agent-instructions/suppression` 子路径导出。子路径解析到 `lib/types/`——与 `dsh-tool-subagent-control/list-agents` 相同的 tsc 直出约定——因此对该包做一次 `tsc -b` 即可产出。

- 插件以可选方式读取注册表（`ctx.get('agentInstructionSuppression')`）；注册表缺失时什么都不抑制，因此 preset 挂载不发布任何服务，通过挂载规则。
- 只有桥组合挂载注册表——`packages/acp/feishu-bridge/cordis.patch.yml` 里的一行宿主行——adapter 的两处 session-start 调用点改为读 `agentCtx.get('agentInstructionSuppression')`。
- 抑制语义不变：经服务代理按调用方作用域落标记、沿作用域链检查（外层作用域的标记抑制后代 agent）、dispose 后恢复注入。`tests/suppression.spec.ts` 钉住全部语义，现在在插件旁一并挂载注册表。

## Alternatives considered

**把 preset 的 `agent-instructions` 行包进 `isolate` 组并把 adapter 迁移到 `serviceForAgent`。** 否决：它给三份上游所有的 preset YAML 增加永久性结构分歧（它们已带 plan-mode 文本分歧）、引入 bridge→agent-presets 依赖，还有一个静默失败模式——entry-local realm 之后 `agentCtx.get` 返回 undefined，漏迁移的调用会无声跳过抑制。

**把插件整个回退并砍掉 `suppress()`。** 否决：裸 persona 与 render-fork 的对齐特性是桥的承重行为，砍掉接缝直接破坏它们。

## Consequences

上游所有的文件重新回到零改动——preset YAML 与插件形态与上游一致，缩小后续同步摩擦——抑制接缝则以显式宿主面能力的形态保留，待稳定后可按 fork 原则先提给上游（提接缝胜过每次吸收时重新嫁接）。代价：需要抑制的组合必须多挂一行，且该子路径需要一条手写 tsconfig 别名（paths 生成器只覆盖裸名与 `src/invariant.ts`）。验证：web-agent-presets e2e 32/32、agent-instructions 套件 181 个测试、桥 adapter 各 spec 全绿。
