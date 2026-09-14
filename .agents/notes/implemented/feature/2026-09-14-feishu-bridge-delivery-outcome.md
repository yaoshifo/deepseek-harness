# Agent Note: Feed the delivery outcome back into what the user sees (absorption batch 1)

Status: implemented

English | [中文](2026-09-14-feishu-bridge-delivery-outcome.zh.md)

## Problem

The [dsh-im comparison survey](../../../../packages/acp/feishu-bridge/docs/DSH-IM-COMPARISON.md) pinned three delivery-reliability gaps, all variations of one principle violation — the delivery result never fed back into user-visible state:

- **A finished turn could read as success without its answer landing.** Send failures logged at debug level only; the turn's terminal state read `errorText` alone; the progress card finalized green and the ✅ completion card went out regardless of delivery.
- **Retries could duplicate messages.** The Feishu `im/v1` create/reply API supports a `uuid` idempotency key, but the bridge never sent one, so every retry was a fresh send; the retryable set also included the bridge's own synthesized 30-second per-attempt deadline — a post-delivery symptom where the request may already have landed.
- **Forceful kills dropped the answer.** Stall exhaustion and the hard turn cap returned without any delivery point; the completed streamed text died with the turn. The worst case stacked: `fallbackSend` deleted the frozen card *before* re-delivering, so a failed re-delivery lost the card and the answer together.

## Decision

**Three-state judgment (u1).** `classifyDeliveryFailure` in `src/feishu/delivery-outcome.ts`: a failure is definite ("failed") only when the server answered — an HTTP status or a business code arrived, including the 230020/99991400 rate-limit rejections that stay retryable, because outcome and retryability are separate axes. Transport symptoms and the synthesized deadline are "unknown"; unrecognized shapes default to unknown, mirroring dsh-im's uncertain-by-default. The judgment is exposed as a channel-neutral `DeliveryOutcomeClassifier` capability (`asDeliveryOutcomeClassifier` in `src/core/types.ts`) implemented by `FeishuPlatform`, so the engine consumes it without an engine→feishu import.

**Terminal-state linkage (u2+u3).** The four turn-end plain-text answer loops go through `deliverAnswerText`, which classifies each chunk failure and records the conservative worst outcome (`'unknown'` outranks `'failed'` outranks `'sent'`) on `state.answerDelivery`, reset at every turn boundary. When the answer did not provably land, a plain-text warning rides right after the delivery branches (card-less platforms included) and the ✅ completion card leads its body with the same wording: `answer_delivery_unknown` tells the user not to resend immediately; `answer_delivery_failed` states the answer was not delivered.

**Kill-path delivery (u4).** Both kill paths call `deliverKilledTurnPartial` between the terminal card render and the state cleanup: it mirrors the channel-closed path's segmentation (inter-segment chunks already surfaced between tools; deliver the unsent remainder), settles the subtask parent with the interrupted-marked partial instead of only the synthetic timeout, and records the delivery outcome. Known limit: a block that never completed its message — the classic mid-answer hang — still leaves nothing in `textParts`; the live card remains its only trace.

**Deliver-first fallback (u5).** `fallbackSend` re-delivers first and deletes the frozen card only on success — the frozen card still shows the streamed text, so a failed re-delivery no longer loses everything. `deliverAnswer` classifies its failures and records the worst outcome on `sp.answerDelivery`, which a successful terminal PATCH also sets; the engine reads it at turn end, so the streaming-card paths feed the same completion wording. When nothing could land, the engine saves the answer next to the session's workspace (`undelivered-reply-<ts>.md`) and the warning carries the path (`answer_delivery_saved`), making the work recoverable.

**Send-intent uuid (u6).** Every `im` create/reply carries a uuid generated once outside the retry loop, so transient retries and the token-refresh re-request are server-side idempotent. Verified live before implementing: two `lark-cli` sends with one idempotency key (distinct bodies) returned the same `message_id` and landed a single message. The synthesized per-attempt deadline left the retryable set on the send path (`withRetry(..., { retryOnDeadline: false })`) — a timed-out send surfaces the unknown outcome to the engine instead of risking a duplicate — while non-send operations keep retrying through a stuck attempt.

## Alternatives considered

**Full DeliveryReceipt port.** dsh-im's receipt objects, deferred-delivery outbox, and history-recovery coordination were rejected for this batch: single-channel, no receipt-merge consumer, and the cheap versions (kill-path delivery, deliver-first fallback) cover the pinned pain. The full deferred system remains a candidate row in the [comparison survey](../../../../packages/acp/feishu-bridge/docs/DSH-IM-COMPARISON.md)'s §11 table.

**Retry the timed-out send under uuid protection.** With the uuid in place, a deadline retry would dedupe server-side — but only on the uuid-carrying verbs, and only when the dedup window holds; the plan chose the conservative pairing (uuid for idempotency, no deadline retry) so the two mechanisms do not depend on each other's edge cases.

**Deliver the full accumulated text on kills instead of the unsent remainder.** The card shows the last segment only and truncates at 6000 chars; delivering the full join would duplicate what earlier segments already surfaced. The channel-closed segmentation logic was reused as-is.

## Consequences

A turn whose answer did not provably land now warns the user and stops reading as success; retries no longer produce duplicate messages (server-side dedup plus the deadline boundary); forceful kills deliver their completed streamed text and settle the subtask parent; a failed fallback keeps the frozen card instead of deleting it; a fully undeliverable answer is saved to the workspace with the path in the warning.

The `uuid` column rides every `im` create/reply payload (36-char v4); send-path timeouts now surface as `unknown` outcomes — a behavior change from silent retry-and-maybe-duplicate. The streaming-card paths report through `sp.answerDelivery`; ask-delegate and orphan-turn paths inherit the wiring through the same turn state.

## Testing

`tests/feishu/delivery-outcome.spec.ts` — the five error shapes plus the capability guard. `tests/engine/engine-answer-delivery.spec.ts` — sent/unknown/failed recording, the warning text, and the workspace save with its path. `tests/engine/engine-kill-delivery.spec.ts` — stall-exhaustion and hard-cap kills deliver the completed streamed text. `tests/streaming.spec.ts` (absorption u5 block) — `deliverAnswer` classification and the deliver-first fallback ordering. `tests/feishu/transient-retry.spec.ts` (absorption u6 block) — stable uuid across retries, create uuid presence, the send-path deadline not retried, non-send deadline still retried.
