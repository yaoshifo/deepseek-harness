# Agent Note: feishu-bridge token 速率虚高——tool_result 事件缺 toolID

Status: implemented

[English](2026-08-21-feishu-bridge-token-rate-tool-result-toolid.md) | 中文

## Problem

✅ 完成通知卡显示 `mem0 · test · 40s · 225 t/s`，而同一负载在 cc-connect 上只有几十 t/s。涉事回合（`cc-20260821-132814-1dcb6e318599`）墙钟 40.1s、5 个 API 步骤、6 次工具调用、全回合输出 2257 tokens——按 37.9s 模型生成时间计算，真实速率约 60 t/s。

引擎的速率公式是 `outputTokens / (agent墙钟 − union(toolIntervals))`，工具区间靠 `tool_result.toolID` 与 `tool_use` 的键配对关闭（`engine.ts` 的 `openToolIntervals`）。dsh adapter 主路径的 `tool/result` 投影根本没带 `toolID`（Go `agent/dsh/session.go` 在 EventToolResult 上设 `ToolID: callID`）。于是每个区间都保持 open 直到 `result` 事件在回合结束时统一收口，被扣除的并集覆盖「首个工具调用 → 回合结束」（40.1s 中的 33.4s）。思考时间塌缩成首个工具调用之前的 6.6s，最后一条请求的 1569 输出 tokens 除以该残值：卡片上 ≈236 t/s（渲染为 225；引擎用处理时刻打点，非日志时刻）。

同一代码路径还牵出两处同类偏差：子会话投影从不存在的 `message.callId` 字段读 callId（持久事件把 callId 放在 `message.source.callId`，并在 `tool-result` 块的 `toolCallId` 上重复出现）；result 事件只带**最后一条** assistant 消息的 usage，而 Go 的 `accumulateUsage` 折叠整回合 usage（input、cache、output、步数）。引擎的 ctx/hit 页脚行消费的正是回合和，所以多步回合的 input delta 也偏小，且 "N api" 恒显示 0。

## Decision

`toolResultCallIdOf(message)` 从 `message.source.callId` 提取 call id，回退到 `tool-result` 块的 `toolCallId`；主路径与 `projectSubagentEvent` 都把它投影为 `toolID`（子会话 id 保留 `<childSessionId>:` 前缀）。usage 记账切换为 Go 的累加语义：`turn/start` 清零计数器、每条 `assistant/message` 折叠该次请求的 usage 并递增步数、`turn/end` 在 result 事件上携带总和与 `numTurns`。

## Alternatives considered

**让 engine 把无 ID 的 tool_result 关到最近一个 open 区间。** 否决：Go 从不需要该回退，因为它的 adapter 恒带 ToolID；「最近一个」启发式在并行工具下会配错对。偏差在投影层，就在投影层修。

**分子保留最后一条请求的 usage。** 否决：速率除的是整回合生成时间，且 Go 的 dsh adapter 就是累加——保留最后一条分子会让多步回合恰好少算前面步骤的 tokens。

## Consequences

工具时间区间随各自的 tool_result 关闭，速率分母回到模型真实生成跨度；分子与 ctx/hit 行改为回合和（多步回合不再少报，"N api" 显示真实步数）。无 ID 的 tool_result 仍不带 `toolID` 投影，engine 仍在 `result` 收口滞留区间——既有回退配对机制原样保留。本次刻意不修（同根 omission，另行裁定）：tool_result 仍不带 `toolName`（Go 从 pending callId→name 映射重建；engine 的 Write 计划文件晋升与结果 label 读它）；真实 `tool/call` 事件仍不投影 `toolInputRaw`（engine 的 `file_path` 计划路径追踪读它）。

## Testing

`tests/agent-dsh/adapter.spec.ts`：真实持久形态的 tool/result 投影出 `toolID`（修前红、修后绿）；result 事件携带整回合 usage 总和与步数，下一回合从零起算。`tests/agent-dsh/adapter-subagent.spec.ts`：真实持久形态（callId 在 `message.source` 与 tool-result 块上）投影出带前缀的 id——旧测试编码了生产中不存在的平铺 `message.callId` 假形态，bug 正是这样藏住的。`tests/engine/engine-events.spec.ts`：契约测试锁定 engine 侧——携带相同 id 的 tool_use/tool_result 对中途回收，工具后的生成时间留在思考时间里（修前修后皆绿；它钉住 adapter 现在喂给 engine 的配对契约）。包内全套 2008 测试绿。
