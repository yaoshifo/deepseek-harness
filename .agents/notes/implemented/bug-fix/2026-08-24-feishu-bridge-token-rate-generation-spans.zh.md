# Agent Note: feishu-bridge token 速率改用流式生成区间

Status: implemented

[English](2026-08-24-feishu-bridge-token-rate-generation-spans.md) | 中文

## Problem

子任务报告返回后的 ✅ 完成通知卡显示 `deepseek-harness · dev · 9s · 5.0 t/s`（群 `oc_325f5652…`），比正常的几十 t/s 低了一个量级。逐 turn 复算绑定会话日志（`cc-20260824-124410`）把缺陷钉死在速率公式 `outputTokens / (agent 墙钟 − union(工具/权限区间))` 的分母上（2026-08-21 的 toolID 修复已校正过该公式一次）：

1. **首 token 延迟被算成生成时间。** 每个模型步骤在首个流式 delta 之前的预填充/排队等待实测 1.0–6.3 s，全额进入思考时间。短 turn 被它支配：最差的一步在 6.3 s 等待后 0.5 s 解码 51 个 token，渲染 ~7.5 t/s，而实测解码速率 93.6 t/s。
2. **agent turn 开始前的派发开销。** bridge 在事件泵启动时打 `agentStart`，而 agent 的 `turn/start` 最晚滞后约 7 s（`followup()` 即发即返——延迟位于 agent 运行时内部、收件箱投递与 turn 认领之间，根因未定位）。1.5 s 的 agent turn 渲染成「9s」。
3. **子 agent 的模型时间记到父账上。** turn 内同步派发 subagent 时，子会话的模型生成时间既不是父的工具区间（子的工具调用是，但子在两次调用之间的思考不是），也不产生父的 output tokens，整体灌进父分母。

分子没有问题：adapter 逐条折叠各请求的 `usage.outputTokens`（DeepSeek `completion_tokens` 含 reasoning——日志里 reasoning 块字符量与它正相关）。六个报告确认 turn 的真实解码速率实测 90–130 t/s，卡片显示 5–9 t/s；长回复自我稀释误差，所以只有短 turn 看起来坏了。

## Decision

`TurnTiming.intervals` 换成 `generationSpans`（`engine.ts`）：静默期后的首个 `text_delta`/`thinking_delta` 开区间，父自身的 `tool_use` 或 `result` 事件关区间；`fromSubagent` 的工具调用不关它（子运行时父可能仍在生成）。速率变为 `outputTokens ÷ union(generationSpans)`，构造性地排除上述三类污染。`openToolIntervals`/`toolIntervalSeq` 记账与权限等待区间 push 只为旧公式服务，随之删除。已接受的不精确：区间在 `tool_use` 投影时刻关闭，截掉 tool-call 参数自身的生成时间（占思考密集步骤的小头）。

## Alternatives considered

**从墙钟公式里扣除测得的 TTFT。** 效果等价，但保留了脆弱的减法链（每种新等待源都得记得登记成区间）；span 并集不需要枚举等待种类。

**adapter 用 `assistant/chunk` 事件时间戳算解码时间。** 时间戳更精确，但 delta 本来就实时到达引擎（流式预览靠它），adapter 需要新增 result 事件字段加逐步累积，换不来用户可见的收益。

**Go 保形。** Go 的 `thinkingTime` 结构相同；这是一次有意分歧，因为墙钟公式对短 turn 结构性错误——与按轮计量的看门狗时钟同类决策。

## Consequences

短 turn 现在渲染真实解码吞吐；不流式 delta 的 provider 无区间、速率行省略（dsh provider 恒流式，该分支只防外部 adapter）。duration 行（`agentDurationMsg`）仍按泵墙钟计量、仍虚高（约 7 s 派发开销）；修它是另一个决策，定位该开销在 agent 运行时侧的根因同样是遗留事项。排队接管（queued takeover）继续在同一 timing 对象上累积 span，镜像旧公式的跨 turn 混算而非修复它。

## Testing

`tests/engine/engine-events.spec.ts`——速率 describe 覆盖四个行为：首个 delta 之前的等待不入分母、父自身工具调用关闭区间（工具后的静默时间排除）、`fromSubagent` 工具调用不关父区间、无 delta 的 turn 省略速率行。
