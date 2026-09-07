# Agent Note：feishu-bridge auto-compress 改读会话投影占用

Status: implemented

[English](2026-09-06-feishu-bridge-auto-compress-projection-source.md) | 中文

## Problem

同一个 bridge 进程里并存两套 token 口径。auto-compress 触发（M7-c 自 Go `estimateTokensWithPendingAssistant` 保形迁入）用 chars/4 对 `recentTurnsOf` 全量窗口加 pending-assistant 项估算上下文大小，而 `/context` 卡与上游 token-meter 已经经 `adapter.contextSnapshot`（对活会话 log 的一次 `sessionProjections.snapshot` 一致切面）供数。两套各自漂移——chars/4 启发式系统性低估 CJK 文本与 tool-result JSON，且完全看不到系统提示与工具 schema 的重量——配置的 `autoCompress.maxTokens` 阈值对触发器与对进程内其他 token 面含义不同。

## Decision

- **触发读 `contextPressure.projectedTokens`**——/context 卡 headline 首选锚定的 token-meter 投影值：最新 usage 样本的 prompt 侧压力 + 采样以来 surface 移动的启发式重定价。随每次落定的请求步进、压缩遮蔽一个片段的瞬间即回落，由 provider 锚定而非按字符数。
- **`tokenUsage` 经查证后否决**：它是完整 durable log 的累计计费用量，压缩后不回落——用它做阈值会在首次越限后每个 `minGapMins` 重复触发，且计入全部历史输出 token，不是上下文占用。
- **不保留回退估算器。** 触发点（`handleResultEvent` 的 turn 结束尾）该 turn 的 usage 事件已提交，`sessionProjections.snapshot` 同步：缺失 cell 惰性折叠全量 in-memory log，resume 会话同样折叠恢复出的 log（持久化投影 cache 只是捷径、非前提）。base bundle 恒挂 token-meter，bridge 生产 provider（llm-pi-ai、anthropic-messages API）每个落定请求都报 usage。唯一缺失场景——零次请求落定——没有 provider 锚定的上下文可压缩；为它保留第二套估算器正是本次要消除的漂移。
- **`projectedContextTokens(e, sessionKey, session)`**（session-misc.ts）持有读取：`asContextSnapshotReader(e.agent)?.contextSnapshot(e.activeAgentSessionID(...))?.pressure?.projectedTokens`，registry 失败被捕获并降级为「低于阈值」+ warn（/context 卡同样降级；否则一次 throw 会打断 turn 结束路径）。
- **触发语义不变**：绝对比较 `occupancy >= autoCompressMaxTokens`、自动压缩间 min-gap、`(~Nk tokens)` 通知数字——只换了数字的来源。

## Alternatives considered

- **用 `tokenUsage` 做门**：否决——累计、单调、语义错误（见上）。
- **按 `contextWindow` 比例做门**：会改变配置阈值的含义（今天是绝对 token 数）；配置契约不动。
- **投影优先 + chars/4 回退**：否决——所有真实触发场景投影可得，回退只会是死代码、重新引入第二套估算器。
- **在 engine.ts 内联读投影**：读取属于 auto-compress 域模块（session-misc.ts），被退役的估算器就住在那里。

## Consequences

- `estimateTokensWithPendingAssistant` 及其 describe 块删除；触发的全量 `recentTurnsOf` 折叠随之消失（`recentTurnsOf` 本体保留其他调用方：predict-next、commands、reset-on-idle、lastResultOrReply）。
- 测试双向钉住数据源切换：低投影 + 胖窗口（200 字符、chars/4 口径 50 token）不触发；无 `contextSnapshot` 能力的 agent 不触发。
- 宿主真缺 token-meter 的部署会完全失去 auto-compress 触发（旧启发式仍会触发）；base bundle 使其实际不可达。
- 验证：`packages/acp/feishu-bridge` engine spec 套件；真机检查是长会话跨过 `maxTokens` 后出现 🗜 通知、其 token 数与 /context 卡 headline 一致。
