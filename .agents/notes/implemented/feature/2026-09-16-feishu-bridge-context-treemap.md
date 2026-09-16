# Agent Note: /context map treemap — segment visualization over the projection snapshot

Status: implemented

English | [中文](2026-09-16-feishu-bridge-context-treemap.zh.md)

## Problem

The /context card compresses the runtime context into six aggregate buckets (how many tokens each of system/tools/user/inject/assistant/tool) and cannot answer "what is each block, in what assembly order, and which one eats the budget." dsh-context's `contextTimeline`/`contextHeaders` projection values have carried that data per item all along — every message node with its token count, opening text, and seq; every tool schema with its token count and description; the system prompt in full — but the bridge's narrow types (`src/context/types.ts`, which by design admit only the fields the cards consume) cut `nodes`/`droppedNodes` and the header's `system`/`description`, and a Feishu card cannot draw a treemap anyway.

## Decision

`/context map` (an argument form of the existing command): the same `ContextSnapshotReader` read, a pure rendering layer emitting a self-contained zero-JS HTML document, delivered as a `.html` attachment over the platform's FileSender capability (the `deliverReplyHTML` pipeline). Three design layers:

- **Widen the narrow types instead of building a new data plane**: `ContextTimelineValue` gains `nodes`/`droppedNodes` (required upstream since 0.11, mirrored faithfully); `HeaderRecordValue.system` and `HeaderToolValue.description` are admitted as optional, mirroring upstream. The adapter copies the wire objects field by field, so widening the types is enough — zero runtime change; four existing fixtures gained the required fields.
- **Two-level layout, hand-rolled**: the top level splits the canvas into three labeled phase bands laid left to right (width ∝ phase tokens) — ① system prompt, ② tool schemas, ③ history — so the horizontal position *is* the assembly order; the second level squarifies each band (`squarify`, ~80 lines, the Bruls algorithm: order-preserving within the band, areas exactly ∝ tokens, greedy row packing keeps aspect ratios square). No d3/echarts: the artifact must open offline self-contained, and the algorithm is smaller than the dependency wiring.
- **Honest coverage**: `current`'s four message buckets cover every live message while `nodes` serves only the newest tail — the difference (with the `droppedNodes` count) renders as one gray "N older messages" placeholder rectangle at the head, so the treemap never pretends to be complete.

Segment order: system prompt (priced at `current.system`, the epoch's full text as hover preview) → the newest epoch's tool schemas (declaration order) → the gray placeholder → served messages by seq; zero-token nodes are skipped (an empty assistant message prices 0 and projects to no rectangle). Message rectangles print their session-log seq beside the token count, so the phase order is exact and the within-band order stays checkable against the log. Every rectangle is filled with its own prompt text — the system prompt's opening, a tool's name and description, the message's opening — fitted per rectangle by `fitRectText` (a fixed advance-width estimator over the box's content width × line count at the real CSS metrics, CJK at a full em and Latin at 0.55em), so a box shows as much of its prompt as it can render and an ellipsis marks the cut. Text outranks the token row: a box too short for both keeps one text line and drops the row, and only rectangles below 24×27px render as plain color blocks. The hover title carries the full capped text. HTML copy is Chinese-only, the same precedent as the chartspec chart labels; chat-side degradation copy routes through the bridge i18n (reusing `ContextEmpty`/`ContextPluginHint`, plus the new `ContextMapNoFileSender`). Every interpolation goes through `escapeHtml` (message previews are arbitrary content → the HTML injection boundary; truncation precedes escaping so an entity is never cut in half). The file name is composed at the command layer with `slugifyTitle` — the pure rendering module does not depend back onto the engine layer.

## Alternatives considered

**Modify the dsh-context plugin client (add the treemap to the dsh web Context tab).** Rejected for this round: third-party-plugin fork drift, and the user's web profile does not mount dsh-context (the profile change plus verifying projections on mounted sessions would come first); kept as a follow-up option.

**Replay a historical request's assembly by seq** (dsh-context `client/assemble.ts`'s liveness rule `seq < R.seq && (gone undefined || gone > R.seq)`). Deferred as a `/context map <seq>` extension: the archive data is already on the wire, but this round delivers the current "next request" view.

**PNG inline image / card-button trigger.** Deferred: a text-dense treemap wants zoom and hover, which an image form loses; the card-action handler contract returns a Card, and a file send there would be a side effect — not breaking that shape yet.

## Consequences

- The bridge gains `src/context/treemap.ts` (segment shaping + squarify + the HTML template, pure functions with a `time` argument for determinism) and the command branch; `render.ts`'s `capRunes`/`formatTokens` become public (their existing home, avoiding a second copy).
- The snapshot is a static view of the generation moment; re-run the command to regenerate after the context moves (the same convenience level as the card's refresh button).
- The treemap file carries opening text of session content — the audience is the chat that ran the command, the same boundary as the /context card, but it exposes more content than the card (the system prompt's opening, message previews).
- Four existing timeline fixtures gained empty `nodes`/`droppedNodes` values for the required fields — the bridge's narrow port of upstream dsh-context is now closer to 1:1, one less trimming account to reconcile at future re-alignments.
