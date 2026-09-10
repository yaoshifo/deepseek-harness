# Agent Note：压缩检查点逐字保留已批准计划

Status: implemented

[English](2026-09-10-compaction-preserve-approved-plan.md) | 中文

## Problem

压缩摘要一段长执行会话时，已批准的计划（用户经 exit_plan_mode 评审批准的那份）会被稀释掉。被压缩区段是头锚定的（`region.ts` 的 `selectCompactableRange`）：从 surface 首节点到保留 cut 的一切都替换为一条摘要，而计划批准通常发生在执行早期，exit_plan_mode 调用几乎必然落在该区间内。摘要指令（`summarizer.ts` 的 `COMPACTION_INSTRUCTION`）原本没有计划保留条款——计划只能以 bullet 形式挤进 Pending Jobs / Current Work / Next Step / Critical Context——且旧检查点的「不许照抄前文」规则会主动把它合并稀释。多轮压缩下，模型对已批准计划的可见性单调退化，执行中的 agent 丢失全局图景（范围、分组、验收标准）。todo 清单同样丢失（`todos` projection 是 client-only；模型唯一的视图是自己的调用参数）。

## Decision

给摘要指令加一条规则（最小改动：不加状态、不动区段选择、不改检查点结构）：

- 会话中出现已批准计划（用户允许的 exit_plan_mode 工具调用；有多个时取最新）时，把计划全文逐字复制进 Critical Context 的一个围栏代码块，只要还有未执行的工作就一直保留；全部执行完毕后按其他已完成历史一样压缩。
- 旧检查点合并规则（「不许照抄前文」）恰好豁免这一份副本：仍有未执行工作时原样携带到下一检查点。

首次压缩在 exit_plan_mode 调用仍可见时取得逐字副本；后续压缩从旧检查点继续携带。计划执行完毕后照常压缩，预算占用自限。无计划的会话行为不变；检查点结构（八个小节）不变。

## Alternatives considered

**计划固化为持久状态、每轮重注入（system prompt 段，仿 agent-instructions 基线的 surface 可见性重发）。** 暂缓：这是完全可靠的路径（每请求重渲染的段不受压缩影响），但属于新功能——plan-mode 要加新事件类型加提示段，触碰两个上游包。先落最小条款；实测保真度不足再升级（本 note 记录升级路径）。

**压缩区段选择豁免计划节点。** 放弃：区段选择按 token 定价与 tool-pairing 平衡运转；按消息身份豁免会破坏「区段是平衡头部区间」的不变量，且可能令压缩彻底无法收缩。

**摘要指令同时保留 todo 清单。** 暂缓：机制相同，但 todo 的定位是 client-only projection；改变模型对 todo 的可见性是另一个决定（tool-todo README 记录了现行口径）。

## Consequences

- 保真度是概率性的：摘要模型遵循的是指令而非强制执行；逐字副本与指令其余部分遵循同一服从概率。
- 保留的计划计入 `maxTokens`（默认 8192）：放不下的计划会让检查点安全失败（截断报错、保留完整历史）而不是静默丢内容——反复出现应调大 `maxTokens`（README 限制节已记录）。
- 被超长逐字计划占大头的摘要也可能过不了 shrink 校验；结果同样是告警并保留完整历史。
- `summarizer.ts` 的指令文本属上游包；按 fork 原则，条款验证稳定后提上游。

## Testing

`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts`（describe "default one-shot summarizer"）：两条新断言把指令的确切措辞钉在派发调用信封上——`an exit_plan_mode tool call the user approved` / `copy its full markdown verbatim into Critical Context as a fenced code block` 规则，以及旧检查点规则的例外句。
