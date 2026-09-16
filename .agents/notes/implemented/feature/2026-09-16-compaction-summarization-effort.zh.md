# Agent Note: 压缩摘要的可配置思考档位

Status: implemented

[English](2026-09-16-compaction-summarization-effort.md) | 中文

## 问题

一次性摘要调用继承了会话的思考档位：`GenerateOptions.reasoningEffort` 从未被设置，pi-ai adapter 回落到 profile 默认（`options.reasoningEffort ?? profile.reasoning`）——两个生产 bot 都是 `max`。推理模型的思考与纪要正文**共享**摘要的 `maxTokens` 帽，模型先对回放上下文长篇推理、然后才写纪要。活体证据（2026-09-16，oc_8b19，deepseek/deepseek-flash 在 ~84 万 token 上下文上）：四次压缩尝试三次死于 `summarization truncated at the token cap`——先撞 8192 默认帽，调到 16384 后又连撞两次，每次失败烧 ~76 秒并在每个 step 边界重试（压力仍在阈值上）。思考碰巧跑短时成功的纪要只有 ~1.5 万字符；思考则跑到 ~1.7 万 token。

## 决策

- `BasicCompactionConfig` 新增 `summarizationEffort?: string`（`modelPolicies` 里也可按目标覆盖），与 summarization provider/model 对一同链解析。
- 默认 `''` 是**按模型能力自动选择**：summarizer 解析摘要目标声明的 `reasoning.efforts`，含 `low` 档就用 `low`，不含则省略字段。无条件默认 `low` 会让不声明 efforts 或阶梯不同的模型每次压缩必炸（runtime 按声明校验档位、不匹配 fail-loud）；只做省略的默认则会让每个没读到本 note 的部署继续重放高档继承。
- `summarizeWithLlm` 把选出的档位经 `ReasoningEffortId()` 传入一次性请求。显式配置永远压过自动选择。
- 部署仍可显式钉住该字段（live profile 为 deepseek-flash 钉了 `low`：将来 ladder 变化时会在档位校验处 fail-loud，而不是静默退化回被继承的高档）。

## 考虑过的替代方案

**硬编码 `low` 为默认。** 对不声明 efforts 或阶梯不同的模型每次压缩必炸；runtime 的 fail-loud 校验让无条件取值成为部署破坏者。

**只做省略的默认（`''` 永不选择）。** 每个没读本 note 的部署都保留高档继承——正是本次改动要偿还的事故；自动选择在不引入硬编码失败模式的前提下关闭了它。

**继续调大 `maxTokens`。** 治标；思考没有上界，任何帽都是抽签。维持 16384 作为纪要正文本身的余量（实测 ~1.5 万字符）。

## 后果

- 选出的档位作用于该后端的每一次摘要调用（压力触发、溢出恢复、手动 `/compact` 都汇入 `summarize()`），按摘要路由到的模型生效。
- 自动选择给每次摘要增加一次 `resolveModelInfo` 解析——与请求分发本身做的同一解析，不引入新失败模式。
- 配了摘要模型未声明的档位会让压缩尝试失败（随后 step 边界重试）并抛 `UNSUPPORTED_REASONING_EFFORT`——logger-console exporter 落地后 daemon 日志里可见。
- 会话自身的思考档位不动；只有辅助调用改变。
- 测试：新键的配置解析/覆盖/校验、经 `ReasoningEffortId` 的 wire 传递、声明含 low 的模型上自动选择、无 low 阶梯与非推理模型的省略（`compaction-basic.spec.ts`）。
