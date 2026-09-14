# Agent Note: Expose the narration cap, cache the preview card after its PATCH lands, serialize wire ops once

Status: implemented

English | [中文](2026-09-14-feishu-bridge-progress-card-followups.zh.md)

## Problem

Three follow-ups to the [progress-card fixes](2026-09-14-feishu-bridge-progress-card-fixes.md) landed the same day:

- The flush interval became `streamPreview.progressFlushIntervalMs`, but the live-narration cap stayed a module constant (6000 chars) — the same deployment-varying choice (the Feishu 11310 guard boundary) left unconfigurable.
- `updateMessage` wrote the pre-button card into `lastProgressCard` before the rate-limit wait and the PATCH retry, so a PATCH that exhausted its retries left the cache ahead of the card the chat shows; stop and render-status rebuilds then wrapped chrome around content that never landed.
- Each wire operation walked the card through two or three JSON round-trips: `renderPreviewCard` stringified, then `injectStopButton` and `injectReplyButtons` each parsed and re-stringified (the stopped-card path added a fourth through its internal chain).

## Decision

`streamPreview.maxAnalysisChars` (default 6000, the former constant) caps the live-narration section through the same `setStreamPreviewCfg` seam as the flush interval, with its schema field and OPERATIONS row.

The pre-button cache is written only after the PATCH retry resolves, so the cache always reflects what the platform accepted; a failed PATCH leaves the previous entry, and the stop/status rebuild paths fall back through the existing cache-miss handling.

Button injection mutates a card object in place (`injectStopButtonInto` / `injectReplyButtonsInto` / `injectStoppedButtonsInto` / `markCardStoppedInto`), with `buildCardWithHeader` / `buildPreviewCard` returning objects; each wire operation stringifies exactly once, and the string-form injectors remain thin wrappers for the Go-ported public surface. `lastProgressCard` stores the un-mutated pre-button card object; rebuild paths clone before injecting, so the cached base never carries buttons.

## Alternatives considered

**Cap the narration at the old constant.** The audit's F4 fix shipped the interval; stopping there leaves the card's other real knob fixed while its sibling is configurable, and the 11310 boundary is exactly the kind of deployment-varying choice the repo requires as a config field.

**Roll the cache back on PATCH failure.** Writing after success is the same guarantee with no rollback path to maintain: the cache never advances past the platform.

**Drop the string-form injectors.** They now have test-only callers, but they are the Go port's public function surface and their specs pin the injection behavior; deleting them buys four fewer exports at the cost of rewriting the specs' construction path.

## Consequences

The narration cap is tunable per deployment without a rebuild; the default is unchanged. A retry-exhausted PATCH no longer poisons stop-card rebuilds with unlanded content — the rendered card and the cache can only agree. Wire serialization drops from 2–3 round-trips per PATCH to one, and the cached base is an object the rebuild paths can clone directly instead of re-parsing a string.

## Testing

`tests/streaming.spec.ts` covers the configured cap (default contract, a 100-char cap truncates). `tests/feishu/cardcache.spec.ts` pins that a failed PATCH does not advance the pre-button cache and that the stop-card rebuild uses the landed entry. The byte-for-byte wire equivalence of the single-stringify refactor is covered by the existing preview/card specs (construction switched to the object path, assertions unchanged).
