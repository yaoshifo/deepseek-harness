# Agent Note: feishu-bridge 将以 error 结束的 turn 渲染成了绿色完成卡

Status: implemented

[English](2026-08-22-feishu-bridge-error-turn-card.md) | 中文

## Problem

dsh 适配器把以 `reason.kind === "error"` 结束的 turn 投影为 `result` 事件，同时携带 turn 内最后一条 assistant 文本和失败消息 `errorText`（agent-dsh/adapter.ts 的 `turn/end` 分支）。`handleResultEvent` 只在 turn 完全没有文本时才读取 `errorText`。长的工具驱动 turn 在工具调用之间通常有过渡叙述，于是错误被丢弃，进度卡经 `markCompleted()` 终态化——绿色「执行完成」头、错误前的叙述留在实时播报段——且该叙述被记为会话的 `last_result` 与 history 回复。聊天里收不到任何错误。

线上事故（2026-08-22 17:14）：DeepSeek 1301 内容审查拒绝在 turn 中途掐断模型请求；群的卡片停在「执行完成 · 17:14:10 · 51」，实时播报是「解压会话日志，看最后几条事件…」，排查任务无声死亡。

## Decision

`handleResultEvent` 把 `errorText` 非空的 `result` 一律视为失败 turn，无论产出过什么文本：回复取 `Msg.Error(errorText)`，跳过 `setLastResult`（history 把错误消息记为该 turn 的回复），并在所有完成路径之前用独立分支渲染失败——活跃进度卡上 `setAnalysisText(error)` + `markFailed()` + `detachPreview()`（红色头、错误替换实时播报段），否则 `discard()` 并以普通消息送达错误。失败 turn 不触发 ✅ 完成通知与 insight 跟进。空文本错误场景走同一分支。

## Alternatives considered

**把错误追加在叙述之后而非替换。** 叙述是流式过程中已展示的临时评注；保留在最终实时播报段会淹没红色头要传递的失败信号。

**在 engine 里重试失败请求。** 内容审查 4xx 失败非瞬时；agent-loop 对 `invalid_request_error` 不重试是正确行为，保持不变。

## Consequences

用户看到红色「执行失败」卡与平台错误文本，会话记录的回复即错误文本——resume、压缩上下文与 `last_result` 反映失败的 turn 而非叙述回复。过渡叙述只在流式期间可见，绝不持久化为该 turn 的答案。

## Testing

`tests/engine/engine-events.spec.ts`（"processInteractiveEvents error-reasoned turn"）。红测复现事故：工具调用 + 过渡叙述 + error 结束的 result 终态化为 `__cc_state__:completed` 并记录叙述；绿测断言 `__cc_state__:failed`、错误文本上卡、叙述不进 `lastResultOrReply()`，以及无预览卡路径以普通消息送达错误。feishu-bridge 全套件：2074 通过。
