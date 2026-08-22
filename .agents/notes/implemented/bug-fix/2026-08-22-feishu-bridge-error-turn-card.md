# Agent Note: feishu-bridge rendered error-reasoned turn ends as green completion cards

Status: implemented

English | [中文](2026-08-22-feishu-bridge-error-turn-card.zh.md)

## Problem

The dsh adapter projects a turn ending with `reason.kind === "error"` as a `result` event carrying both the last assistant text and the failure message as `errorText` (agent-dsh/adapter.ts, `turn/end` case). `handleResultEvent` consulted `errorText` only when the turn had produced no text at all. A long tool-driven turn normally has interim narration between tool calls, so the error was dropped, the progress card was finalized via `markCompleted()` — a green 执行完成 header with the pre-error narration left in the 实时播报 section — and the narration was recorded as the session's `last_result` and history reply. No error reached the chat.

Live incident (2026-08-22 17:14): a DeepSeek 1301 content-moderation rejection killed the model request mid-turn; the chat's card froze at 「执行完成 · 17:14:10 · 51」 with the narration 「解压会话日志，看最后几条事件…」, and the investigation task died silently.

## Decision

`handleResultEvent` treats any `result` with non-empty `errorText` as a failed turn regardless of text produced: the reply is `Msg.Error(errorText)`, `setLastResult` is skipped (history records the error message as the turn's reply), and a dedicated branch placed ahead of every completion path renders the failure — on an active progress card `setAnalysisText(error)` + `markFailed()` + `detachPreview()` (red header, error in place of the 实时播报 section), otherwise `discard()` plus the error delivered as a plain message. No ✅ completion notification or insight follow-up fires for a failed turn. The empty-text error case rides the same branch.

## Alternatives considered

**Appending the error after the narration instead of replacing it.** The narration is transient commentary already streamed live; keeping it in the final 实时播报 section buries the failure signal the red header must carry.

**Retrying the failed request in the engine.** Content-moderation 4xx failures are not transient; agent-loop non-retry of `invalid_request_error` is correct and unchanged.

## Consequences

Users see a red 执行失败 card plus the provider error, and the session's recorded reply is the error text — resume, compaction context, and `last_result` reflect the failed turn instead of a narration reply. Interim narration stays visible only while streamed; it is never persisted as the turn's answer.

## Testing

`tests/engine/engine-events.spec.ts` ("processInteractiveEvents error-reasoned turn"). The red run reproduced the incident: tool call + interim narration + error-reasoned result finalized the card `__cc_state__:completed` and recorded the narration. The green run asserts `__cc_state__:failed` with the error text on the card, the narration excluded from `lastResultOrReply()`, and the no-preview path delivering the error as a plain message. Full feishu-bridge suite: 2074 passed.
