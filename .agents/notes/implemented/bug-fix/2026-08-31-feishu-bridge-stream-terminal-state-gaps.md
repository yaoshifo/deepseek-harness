# Agent Note: feishu-bridge stream terminal-state gaps — surface swaps, send failure, text finish, structured-card finalize

Status: implemented

English | [中文](2026-08-31-feishu-bridge-stream-terminal-state-gaps.zh.md)

## Problem

The bridge's contract is that every turn exit renders a terminal card. Five paths violated it, and a sixth broke the classifier that protects the preview from transient PATCH failures. (1) The queued-message takeover swapped in a fresh preview but wrote only `state.preview`, not `state.progressWriter` — the event loop re-reads both from state at each select boundary, so the next event patched the previous turn's already-terminal card through the stale writer (compact/card progress styles; the default legacy style masked it). (2) A failed prompt send emitted the error text but never failed the card, freezing the placeholder in "processing" with a live stop button. (3) The plain-text `finish()` skipped the terminal PATCH when the final text was byte-identical to the last streamed PATCH — but streamed PATCHes carry no status, so the card stayed yellow — and issued its terminal PATCH inline around the async sender, letting a still-queued coalescable running PATCH land after it and flip the completed card back to running. (4) `CompactProgressWriter.finalize` had zero production callers (`void cp` at the result path): the structured progress card's state stayed `running` forever in card style. (5) The `error` event path failed `sp` but never finalized `cp` — the same class as (4). (6) `withTransientRetry` wrapped its exhausted error in `new Error(String(lastErr))`, erasing the AxiosError shape, so `feishuBusinessCode` could no longer see the 230020 rate-limit code and the preview degraded on exactly the transient PATCH errors the classifier (45156fbdb8) was built to forgive.

## Decision

Surface swap points always write both `state.preview` and `state.progressWriter` — all four sites now match. The prompt-send failure branch and the `error` event path follow one shape, mirroring Go's `EventError` order (engine_events.go:5068): `await barrier()` → `if (!sp.inProgressMode()) await cp.finalize('failed')` → `await sp.markFailed()` → `state.eventsNeedResync = true`. `finish()` drops the byte-identical skip — the terminal PATCH always carries a completed status — and awaits `this.async.barrier()` before its inline terminal PATCH, the same ordering `markStoppedSync` uses. `cp.finalize` is wired back per Go engine_events.go:4481 (`if !sp.inProgressMode() { cp.Finalize(...) }`): `sp` (text preview) and `cp` (structured progress) are two separate cards, and the guard routes the terminal state to whichever surface is actually showing. An errored result or error event passes `'failed'` where Go's `EventResult` passed `Completed` unconditionally — the TS loop has a distinct errored-terminal branch, and `failed` keeps `cp` consistent with `sp` (a documented deviation). `withTransientRetry` rethrows the original error on exhaustion; the retry context already lives in the per-attempt warn logs. The ordering rule these fixes share is now uniform: any inline terminal PATCH must drain the async-sender queue first (`barrier()`), because `cp.finalize` patches inline while `sp.markFailed` enqueues a terminal — without the barrier a queued running PATCH can land after the terminal one.

## Alternatives considered

**Deleting `CompactProgressWriter.finalize` instead of wiring it.** Rejected: Go parity and the card-style contract both need it, and the two cards are independent surfaces — only the writer's terminal state was missing, not the whole mechanism.

**Keeping the byte-identical skip for API economy.** Rejected: the streamed PATCH carries no status, so the saved call traded a completed header for a permanently running card.

## Consequences

Every turn exit — result, errored result, error event, prompt-send failure, and the already-correct idle/stop/hard-cap paths — now renders terminal state on both cards. The `!sp.inProgressMode()` guard means a `toolProgress: true` deployment (the placeholder card owns the screen) deliberately leaves `cp` un-finalized on these paths, matching Go's gating. The retry rethrow changes the exhaustion error message shape; the one test asserting the old wrapped message was updated to assert the preserved business code instead.

## Testing

`tests/engine/engine-queued-takeover.spec.ts`: card-style takeover patches the new card, not the previous terminal one. `tests/engine/engine-send-failure-card.spec.ts`: the placeholder fails on send failure, and the structured card fails after events flowed. `tests/engine/engine-card-progress-finalize.spec.ts`: completed and failed finalize on the result path, and the error event fails the structured card. `tests/streaming.spec.ts`: byte-identical finish still delivers the completed status; no running PATCH lands after the terminal one. `tests/feishu/transient-retry.spec.ts`: exhaustion rethrows the original error shape so the business code survives for `isTransientPatchError`.
