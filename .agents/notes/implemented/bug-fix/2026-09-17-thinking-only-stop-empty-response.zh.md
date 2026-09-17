# Agent Note: Treat a thinking-only stop as an EMPTY_RESPONSE error, not a silent completion

Status: implemented

[English](2026-09-17-thinking-only-stop-empty-response.md) | 中文

## Problem

线上证据（2026-09-17，两起）：某飞书群 agent 完成了一个 10 分钟的调研回合（58 个只读工具调用），最后一次模型响应**只含一个 reasoning 块**——完整计划草稿，句中截断——而 wire 层却报了干净的 `end_turn`。适配器守卫只拒绝**零**内容块的 stop；有一个思考块就放行，循环看不到工具调用，回合以 `completed` 结束且无任何用户可见输出：绿卡「执行完成 · 15:26:15 · 58」、🤫 静默回复提示、daemon 日志零行。同日第二起（13:02，mycontext 子代理，同为 `deepseek/deepseek-flash`）证实这是提供方的复发故障模式而非孤例：提供方/网关在思考通道中途截断，却报正常 stop。

静默路径是真实存在的：`mapStopReason`（llm-pi-ai——live mify-dsh 路由）与 llm-deepseek 两个协议的翻译器各有同形守卫（`content.length === 0` / `blocks.size === 0` / `order.length === 0`），且有两条测试显式固化了放行行为：llm-pi-ai `convert.spec` 的 "keeps a thinking-only stop successful (any block counts as content)" 与 llm-deepseek `translate.spec` 的 "keeps a reasoning-only stream a successful stop (any opened block counts)"。

## Decision

把三处适配器守卫从「一个块都没有」扩为「没有 text 也没有 tool-call 块」（thinking/reasoning 块不算内容），失败码维持 `EMPTY_RESPONSE`：

- `llm-pi-ai/src/stream.ts` `mapStopReason`——生产路径（mify-dsh 的 GLM 与 deepseek-flash 都经它）。
- `llm-deepseek` messages 协议 `translate`（throw）与 chat-completions 协议 `translate`（error finish）。

`EMPTY_RESPONSE` 本就在默认可重试码表中，恢复链路全部是现成机制：error finish → `assistant/attempt` + `agent/request-error` → llm-retry（默认 5 次；live mify-dsh 配置 15 次）→ 成功则回合产出真实内容；耗尽则回合以 `error` 结束，bridge 渲染既有的红卡/❌/attention 面。两种结局都有声；bridge、循环、SDK、会话格式零改动。

两条固化放行的测试被反转为 EMPTY_RESPONSE 断言（行为随测试一起改）；新增 `reasoning_only_stop` mock-server 行为与一条 transport-recovery 用例锁定组合语义：仅思考 stop → 一次 `llm/retry`（`EMPTY_RESPONSE`）→ 成功 → 恰好一条带正文的 assistant 落盘，回合 `completed`。

## Alternatives considered

- **在 `agent.ts` 无工具调用分支做循环级检测。** 三处适配器守卫后，该形态无真实路径可到达；检测将是不可达代码，而新增 `TurnEndReason` kind 要连带 docs/architecture.md、双 SDK 期望输出与 10+ 消费面。否决（若未来适配器重新引入此缺口再议）。
- **基于 steer 的续写**（`agent/turn-stopping` + `steer`，受认可的同回合续写机制）。重试的重新生成已能自愈偶发场景；steer 注入合成消息却不增加恢复能力。此处否决——`max-tokens` 续写（GLM 烧帽问题族）是另一桩待决事项，本 note 有意不碰。
- **修提供方。** 网关把思考中途截断报成干净 `end_turn`；wire 层无法与真 stop 区分。不归我们控制；守卫就是必须守住的边界。

## Consequences

- 仅思考 stop 现在最多多花 `maxRetries` 次请求（输出 token；罕见、有界），取代的是静默死掉的回合。
- 确定性产出仅思考 stop 的提供方，表现为「重试后红卡」而非静默——可见、比静默慢、对诊断严格更好。
- 消息文案区分形态（`"... no content (thinking only)"` / `"(reasoning only)"`）便于日志排查。
- redacted-thinking-only 的 stop 同样被拒（两种都映射到 thinking 内容类型）。
- 上游候选：这是无 fork 本地耦合的 seam 修复；在 live profile 上浸泡一段时间后提议上游化。
