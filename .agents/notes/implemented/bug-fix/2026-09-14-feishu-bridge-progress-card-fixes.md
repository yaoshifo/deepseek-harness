# Agent Note: Retire the unreachable structured progress card and fix the streaming card's duplicate PATCHes

Status: implemented

English | [中文](2026-09-14-feishu-bridge-progress-card-fixes.zh.md)

## Problem

The 2026-09-12 [progress-card audit](../../../../packages/acp/feishu-bridge/docs/PROGRESS-CARD-AUDIT.md) found seven issues in the bridge's card path. Two are structural:

- The structured progress-card chain (`CompactProgressWriter` plus the Feishu payload renderer, 766 lines across three files) is unreachable: the port turned Go's `ProgressStyle()` method into a string field on `FeishuPlatform` while the consumer still probes for a function, so the writer's constructor returns before setting `enabled` and `progress_style` is a configured-but-inert knob.
- The streaming preview re-PATCHes byte-identical cards during the thinking phase. The dedup guard covers status-free text only, and the card title carries a wall-clock timestamp, so flushes that add no information still upload a full card.

The remaining five: an exception escaping a turn loop leaves the card it drove frozen on 执行中 with a live stop button; the two `streamPreview` throttle knobs are inert on the path users watch; displacement reissues are unthrottled; the PATCH limiter is documented as per-message but implemented bot-wide; and four exports have no production caller.

## Decision

**Duplicate PATCHes.** `StreamPreview.flushLocked` keys status-bearing content on the whole rendered result — body, header state, clock, tool-call count, pending subtasks, background hint — and returns when that key matches the last one the platform accepted, unless the displacement probe reports the card displaced. The plain-text guard is unchanged. `lastSentKey` is written only where content reaches the platform and rolled back when a PATCH fails, while the resets that clear `lastSentText` alone (showPlaceholder, updateProgress) leave the key alone — clearing it there would disable the dedup.

**Frozen cards.** The three turn-loop catch handlers settle the card they left running through `StreamPreview.markFailedIfUnsettled()`, which no-ops on a card that already completed, failed, truncated, or rendered its stopped state. A drain-phase failure therefore cannot re-render a card the turn settled green. The main handler resolves the state by its slot key: its `state` binding is scoped to the `try` block that failed.

**Structured chain (user ruling: delete).** `src/progress-compact.ts`, the payload renderer in `src/feishu/progress.ts`, the payload types and style parser in `src/progress.ts`, `spinnerKeyForItems`, the platform's `progressStyle` field and `supportsProgressCardPayload()`, the `progressStyle` config key, and the payload-only tests are gone. The preview content type collapses to `ProgressContent`. A configuration that still carries `feishu.progressStyle` fails at load: schemastery keeps unknown keys, so validation alone would let the removed knob survive as a silently inert one.

**Flush interval (user ruling: make it configurable).** `streamPreview.progressFlushIntervalMs` — default 300, the value the card used while it was a module constant; `0` PATCHes every change — governs the progress path. The same batch exposed `streamPreview.maxAnalysisChars` (default 6000, the former `maxAnalysisDisplayChars` module constant) through the same `setStreamPreviewCfg` path, making the live-narration cap configurable too. The three older `streamPreview` knobs now document what they actually tune: the plain-text window before the first thinking or tool event.

**Displacement reissues.** `previewReissueCooldownMs` (2000, aligned with the engine's chat-change bump debounce) caps reissues per card so a rename and avatar notice pair collapses into one tail move. A suppressed reissue still PATCHes its content in place: only the tail rearrangement defers. Settled cards never reissue, so the window needs no terminal exception.

**PATCH pacing.** `patchRateWait(cardKey)` waits on the bucket of the message it is about to PATCH; buckets are created on first use and dropped with the card. The bot-wide bucket is gone — it made the documented per-message 5 QPS limit unreal and diluted each card to 5/concurrent-cards PATCHes per second.

**Dead leftovers.** `resetProgressEntries`, `truncateToMaxLines`, the `isThinking` render branch, and `progressNoOutputText` had no production caller; `CompactProgressWriter.append` left with the chain.

## Alternatives considered

**Fix the structured chain instead of deleting it.** The chain needs more than the type fix: the streaming preview and the compact writer both create cards, so the port would also have to decide which one owns a turn's card, feed `tool_use` events the writer never received, and settle its card at turn end — and no deployment has ever configured the style. Deletion removes 48% of three files and a configuration key that cannot work; a structured card can be re-ported from the Go source if it is ever wanted.

**Keep a bot-wide PATCH cap under the per-message buckets.** A shared cap keeps the daemon's total PATCH rate bounded at 5 QPS regardless of how many cards are live. It lost because it is exactly the dilution the audit named, and it makes the per-message layer unobservable: with the cap in place, one card's burst consumes the tokens another card needs, so the per-card limit can be neither honored nor tested. The exposure is bounded in practice — a card's flush cadence tops it at ~3.3 PATCH/s, duplicate flushes are now skipped, and the live log carried no rate-limit error.

**Correct only the documentation (F4).** Documenting that the three knobs miss the card the user watches is zero-risk, but it leaves the card's real cadence — the only one a long task exposes — unconfigurable, while the schema promises tuning.

**Leave displacement reissues unthrottled.** The reissue path deliberately had no throttle so a rename or avatar notice could not eat the last tail move. That reasoning is preserved by the cooldown's scope: the move still happens, just once per window, and the content PATCHes in place meanwhile.

## Consequences

The thinking phase stops uploading cards whose only change is the clock: a 1.2s thinking flow PATCHes twice instead of five, while the header clock keeps advancing one second at a time. Narration PATCHes are unchanged at the default interval and drop to one per second when configured.

Deleting the chain costs the ability to revisit a structured card in place, and the generated catalogs (`docs/config-catalog*.md`, `packages/extensions/tool-cordis/src/api-catalog.ts`) still list the removed key and class until their generators run.

Total PATCH throughput is no longer capped per bot: it now scales with concurrently active cards, each bounded at its own 5 QPS. A rate-limit error in the log is the signal to add a bot-level cap above the per-message buckets.

A card displaced inside the cooldown window keeps its position until the next content change or the turn's end, and a card that settles while displaced stays where it is — settled cards never reissue. The window widens that pre-existing gap from one flush interval to at most two seconds.

## Testing

`tests/streaming.spec.ts` covers the dedup key (same-second repeats PATCH once, a timestamp in the next second still uploads, a failed PATCH rewinds the key, a displaced card is never deduped) and the cooldown (inside the window, past it, terminals never reissue). `tests/engine/engine-turn-catch-card.spec.ts` covers the three catch handlers, including that a settled card is left untouched. `tests/assembly-config.spec.ts` covers the removed key's load failure and the new flush-interval knob's schema and assembly. `tests/feishu/patch-ratelimit.spec.ts` covers per-message pacing: a card that exhausts its burst does not delay another card's wait.
