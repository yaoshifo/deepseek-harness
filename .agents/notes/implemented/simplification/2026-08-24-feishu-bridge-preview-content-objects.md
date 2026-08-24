# Agent Note: feishu-bridge de-baggage batch 8 — preview content as structured objects across the Platform seam

Status: implemented

English | [中文](2026-08-24-feishu-bridge-preview-content-objects.zh.md)

## Problem

The progress-preview pipeline carried two Go-era text protocols even though every hop is an in-process function call; the only real wire is the Feishu PATCH HTTP request, which carries rendered card JSON:

- The `__cc_connect_progress_card_v1__:` JSON-in-string: `CompactProgressWriter` serialized `ProgressCardPayload` into a prefixed string and pushed it through `sendPreviewStart`/`updateMessage` (`content: string`), where `FeishuPlatform` re-parsed it before rendering.
- The `__cc_state__:`/`__cc_ts__:`/`__cc_tc__:` header lines: `StreamPreview` prepended three pseudo-header lines to every progress display text, and the Feishu renderer stripped them back out to recover (state, ts, tool count).

The cc Event model was also lossy in ways unrelated to text encoding: the adapter dropped the native `tool/result.meta` presentation payload entirely and folded per-request `assistant/message` usage into a turn accumulator, so only the turn sum ever reached the engine.

## Decision

Preview content crosses the Platform interface as a structured discriminated union; card state travels beside the display text instead of inside it.

- **`ProgressContent`** (`core/types.ts`) is the parameter type of `MessageUpdater.updateMessage` and `PreviewStarter.sendPreviewStart`: `{kind:'card', payload: ProgressCardPayload}` or `{kind:'text', text, status?}` with named member interfaces (`TextPreviewContent`, `CardPreviewContent`). `CompactProgressWriter` builds and passes the payload object directly (dedup compares a JSON signature with the builder's fixed key order); `FeishuPlatform` renders the card branch through `buildProgressCardJSONFromPayload` without any encode/decode round trip.
- **`ProgressStatus`** (`{state: running|completed|failed|thinking, ts, toolCallSeq}`) replaces the header lines. `StreamPreview.progressStatusLocked()` computes it from the same conditions that used to pick the header lines; every progress flush sends `progressContentLocked(display)` and the terminal paths (`finish`, `completeAndDetach`'s text branch) send an explicit completed status with `toolCallSeq: 0`. Status-bearing flushes always PATCH — an empty body still renders the 思考中/执行中 header, and progress flushes have their own 300 ms throttle — while plain-text flushes keep the old skip-on-unchanged/empty rule. `buildPreviewCardJSON(text, spin, status?)` takes the status and `progressTitleAndColor` maps it to the same titles, colors, and spinner icons as before.
- **Verification recorded during implementation:** the rendered card JSON never embedded the serialized payload (`buildPreviewCardJSON` rebuilds from the parsed object) and no code writes card text read back from Feishu into `lastProgressCard`, so the prefix codec was never the Feishu wire format. The `__cc_connect_progress_card_v1__:` codec therefore shrinks to the text-path decoder at the Platform seam and stays (`parseProgressCardPayload` and the prefix constant); its V1 legacy constructor (`buildProgressCardPayload`'s entries form) and `extractProgressTimestamp` are deleted as dead code, and `buildProgressCardPayloadV2` becomes the object-returning `buildProgressCardPayload`. `extractProgressState` is deleted too — verified that progress_style=legacy produces no header lines (the headers were exclusively StreamPreview→FeishuPlatform), so it had no remaining producer.
- **Event model lossy fields completed** (adapter `projectSessionEvent`): `tool/result.meta` projects as `Event.toolResultMeta`, and per-request `assistant/message` usage rides the projecting event (`inputTokens`/`totalInputTokens`/`outputTokens` on the text event, or on the thinking event of a text-less message) while the turn sum still rides the result event. Step boundaries (`turn`/`step` from the native events) stay unprojected: no consumer exists today, so adding the fields would be dead surface — revisit when a per-step consumer lands (e.g. per-step timing on the card).
- **Deviations from byte-identical behavior, all on unreachable-in-production paths:** (1) the payload-style writer without a `PreviewStarter` now sends the markdown fallback text instead of the raw prefix string (Feishu always implements the starter); (2) `bumpToEndLocked`'s `display === ''` fallback to `lastSentText` was dead code (the old display always carried header lines) and is removed — an empty body bumps with a running-status card, same visuals; (3) a status flush whose body is byte-identical to the last one is now deduplicated where the old ever-changing `__cc_ts__` header forced a redundant PATCH — visually identical.

## Alternatives considered

- **Keep the string codec at the Platform seam.** Rejected: the seam is a typed same-process interface ("Trust TypeScript at typed same-process boundaries"); the only serialization that must survive is what actually crosses a wire, and the card JSON on the PATCH request is that wire format. The prefix codec remains only as a tolerant text-path decoder, not a transport.
- **Thread status as new header constants in `progress.ts`.** Rejected: replacing one text protocol with another leaves the parse/strip coupling and loses exhaustiveness checking on the state enum.
- **Put `status?` on both union members.** Rejected: the card branch carries lifecycle state inside the payload; a shared optional field would admit meaningless combinations and force every consumer to re-narrow.
- **Project step boundaries now.** Rejected: no consumer reads them; the Event model fields would be written by the adapter and read by nobody, which fails the current-owner requirement. The note records the revisit condition instead.

## Consequences

- Card visuals, button injection, re-attach (`lastProgressCard` + `renderStoppedCard`/`updateRenderStatus`), and the legacy markdown fallback are unchanged; covered by the rewritten `streaming.spec` (70), `progress-compact.spec`, `engine-events`/`engine-stall-retry` suites (structured-status assertions on recorded platform calls), `cardcache` re-attach cases, `spinner` icon cases, `card.spec` header-from-status cases, and new `adapter-projection` cases for usage/meta passthrough. The old header-line and prefix-string assertions were rewritten to object/status assertions, not re-serialized.
- Real-machine visual comparison (JSON assertions + screenshots) remains with the user, as for the other de-baggage batches.
- Any future Platform implementation now receives `ProgressContent` and must switch on `kind`; test stubs share `tests/stubs/preview-content.ts` (`previewText`, `statusOf`) to keep assertions text-based where they check bodies.
- Extracting the per-request usage from events (e.g. a live token meter) is now possible without adapter rework; until a consumer lands, the fields document the projection contract only.
