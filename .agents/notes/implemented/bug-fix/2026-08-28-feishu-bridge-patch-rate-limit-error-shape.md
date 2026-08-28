# Agent Note: Feishu PATCH rate-limit errors are classified by body code, and the PATCH bucket sits under the 5 QPS limit

Status: implemented

English | [中文](2026-08-28-feishu-bridge-patch-rate-limit-error-shape.zh.md)

## Problem

A Feishu card PATCH that hits the per-message update frequency limit (business code 230020, "update the single messages too frequently") was meant to be transient: both `retry.ts` (`isTransientError`, via the `code=230020` message substring) and `platform.ts` (`isTransientPatchError`) carried explicit 230020 handling with comments saying it clears in seconds and must not degrade the streaming card. Neither check ever fired in production, because `@larksuiteoapi/node-sdk` rethrows the AxiosError whose message is only "Request failed with status code 400" — the business code rides in `err.response.data.code`. A four-rejection burst therefore incremented `failedPatchStreak` to the degrade threshold and the streaming card froze mid-turn with the agent still working (2026-08-28, the 「飞书卡片触发场景分析」 group: 16 minutes of no card updates until the user killed the turn).

The existing tests could not catch this: every fixture built the fake error as text with the code embedded in the message, so both classifiers passed against a shape that does not occur.

The trigger side mattered too: the PATCH token bucket defaulted to 120 ms with burst 3 (~8.3/s), above Feishu's documented 5 QPS per-message update limit, so a hot card burst breached the limit and produced the rejection streak in the first place.

## Decision

Business-code extraction is shape-aware and single-sourced:

- `retry.ts` gains `feishuBusinessCode(err)`: it reads `err.response.data.code` (the SDK's AxiosError shape, stringified) and falls back to a `code=(\d+)` message scan for the legacy text shape. It reads neither field with instanceof — the package does not depend on axios, and the response body is the only load-bearing part.
- `isTransientError` returns true when the extracted code is `230020` (exported as `feishuPatchRateLimitCode`) before the message-substring scan; the now-redundant `code=230020` substring left the list.
- `FeishuPlatform.isTransientPatchError` is `feishuBusinessCode(err) === feishuPatchRateLimitCode`.

The PATCH bucket default moves from 120 ms to 200 ms (`patchRateIntervalMs ?? 200`), putting a single hot card at the documented 5 QPS instead of above it. Burst 3 stays: a momentary burst above 5 QPS in a one-second window can still reject, and the transient path owns that residual — the optimistic `lastSentText` rewinds and the next flush resends, so the card lags briefly instead of degrading.

## Alternatives considered

**Widening the message match.** Impossible in the direction that matters: the message does not contain the code. Matching the HTTP 400 status instead would classify every business failure as transient.

**Distinguishing errors by `instanceof AxiosError`.** Rejected: it would add an axios dependency to classifier code that only needs the response body, and duck-typed fixtures keep the tests dependency-free.

**Per-message rate limiting instead of the global bucket.** Rejected for now: the global 200 ms bucket already caps any one card at the documented limit, and two concurrent streaming cards at 5 QPS each stay well under the 50/s app-level cap. A per-message limiter adds bookkeeping the transient path does not need.

**Adopting the cardkit streaming-update API (10/s per card entity).** The real long-term fix for update throughput, but a much larger change to how the preview card is built and sent; deferred, not decided here.

## Consequences

- A 230020 rejection now costs one lost intermediate frame and a resend on the next flush; `degraded` only trips for genuinely non-transient failure streaks. The freeze mode — card dead while the agent works — requires a non-transient cause.
- Every Feishu operation that goes through `withTransientRetry` (send, reply, patch, …) now retries on 230020. That is the correct semantics for a too-frequent error regardless of endpoint; the per-endpoint limit buckets are independent, so this only adds backoff where a rejection actually happened.
- The 200 ms default slightly slows the update floor for every card; with flush coalescing this is invisible in practice.

## Testing

`tests/feishu/transient-retry.spec.ts` classifies both the AxiosError body shape and the legacy text shape as transient, pins 230011 (withdrawn message) as non-transient in the body shape, and unit-tests `feishuBusinessCode` (body precedence, text fallback, plain-error undefined); the patch-wrapper retry test uses the body shape. `tests/streaming.spec.ts` builds its fake checker on `feishuBusinessCode`, and the "transient (230020) PATCH failures never degrade" case uses the real body shape across six update attempts and asserts the successful resend after the failure run. Full feishu-bridge suite: 2706 tests across 158 files pass; host/client typecheck faces pass.
