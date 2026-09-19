# Agent Note: The closing followups card folds factual details into one collapsed panel

Status: implemented

English | [中文](2026-09-18-feishu-bridge-followups-card-fold.zh.md)

## Problem

The [factual-detail layer](2026-09-18-feishu-bridge-followups-details-layer.md) put each finding's evidence under its own checker on the live closing card. That made every option three lines tall (bold label, plain-language description, grey detail), and a closing with a handful of findings ran past a phone screen: scanning and checking an option meant scrolling past evidence the user was not reading at that moment. The same card asked the description to carry three things at once — what the problem is, what handling it would do, what it costs — which pushed descriptions to two or three lines by themselves.

## Decision

The live card renders two lines per option and folds the evidence into one collapsed panel.

- `CardCheckOptions.detailsPanel` (`src/card.ts`) is an optional panel title. When set, the Feishu renderer (`src/feishu/card.ts`, `case 'checkOptions'`) keeps the checker text at `**label**` + description and appends one `collapsible_panel` inside the form — after the checkers, before the text input and the submit row — whose single markdown child holds one line per detail-bearing option: `**label** · detail`.
- Without a title the element keeps its inline grey detail line: the fold is opt-in, so a producer that never sets the title cannot silently drop details off the card face.
- `buildFollowupsCard` (`src/engine/ask.ts`) counts the options with a non-empty detail and passes `i18n.tf(Msg.FollowupsDetailsPanel, n)`; with no details anywhere it passes no title and the card carries no panel. The new message key (`followups_details_panel`) is translated in all five locales.
- `details` stays on the options in the card model, so the send-time read-back (`askCardMeta`), the dispatched `[后续处理]` message, and the card-less plain-text degradation are unchanged.
- The settled snapshot folds the same panel instead of inlining the details (`settledOptionMarks`, face `card-panel`, plus `followupsDetailLines` in `src/engine/ask.ts`), so submitting the card never unfolds the evidence the live card folded (2026-09-20 user report).
- The writing guidance moved in the same change: the tool contract (`src/tools/followups.ts`) and the resident conventions section (`src/engine/agent-conventions.ts`) now ask for a description of one sentence, roughly 30 characters — what the problem is plus what handling it would do, with the cost only when there is one — and describe `details` as folding into the bottom panel. Both surfaces are guidance only; no gate rejects an over-long description.

## Feishu nesting rule

Verified against the vendor documentation before shipping, because a form holding both checkers and a collapsible panel was a new combination for this card: a form container's children "support all components except table and form", and the form itself must sit at the card root and contain a submit button — all three hold here. A collapsible panel must not embed a form, which is not this direction. The container nesting limit is five levels; this card uses three (body → form → panel → markdown).

## Alternatives considered

- **Render the fold as a separate top-level card element.** Simplest card-model-wise (no new field) and it keeps the panel out of the form. Rejected: it places the fold below the submit row, away from the options it annotates, and it would require deleting the checker's inline detail rendering — dropping the element's default and rewriting its pinned tests. It remains the fallback if the in-form panel ever renders badly.
- **One fold per option.** Rejected: a checker option is a single text node, so a fold cannot live inside it, and a panel per option adds a header line per option — taller than the inline rendering it replaces.
- **Carry the panel body on the element instead of deriving it.** Rejected: it would duplicate every detail inside one card model (options plus panel content) with no gain; the renderer derives each line from the same option array the send-time read-back reads.
- **Keep the detail inline and only shorten the description.** Rejected by the same complaint: it leaves the evidence in the scan path.
- **Truncate the inline detail line.** Rejected: evidence is exact by contract (`path:line`), and a truncated line loses the fact it exists to carry.
- **Enforce the ~30-character description with a schema or validator gate.** Rejected by the user: a rejected call costs a model round trip at closing time; the guidance is watched on real cards instead.

## Consequences

- The card is two lines per option plus one collapsed header, so a closing with several findings fits a screen; the evidence sits one click away instead of always visible.
- The panel title counts detail-bearing options (`🔎 事实细节（2 项）`), not options: a title claiming three while listing two lines would read as a bug.
- The separator is ` · ` with its own spaces: `padBoldDelimiters` pads only a delimiter glued to neighboring text (Feishu renders bold only when the delimiters keep whitespace), so a `：` separator would have rendered as `**label** ：detail`.
- Supersedes the live-card rendering decision — and nothing else — of the [followups details layer](2026-09-18-feishu-bridge-followups-details-layer.md), which now points here.
- Shorter descriptions also shorten the dispatch message the executing agent reads, shifting context onto `details`, the field that rides the dispatch too.
- Testing: `tests/feishu/card.spec.ts` (fold position, collapsed state, per-option lines, the settled card folding instead of inlining, no panel without details, the inline default without a title), `tests/engine/followups.spec.ts` (title count, options keeping their details, the settled panel and its absence without details, dispatch unchanged), `tests/feishu/card-action.spec.ts` (the send-time read-back still dispatches details through both egresses), `tests/tools/followups-tool.spec.ts` and `tests/agent-dsh/adapter-persona.spec.ts` (the two prose surfaces' pins), `tests/i18n.spec.ts` (the new key carries en/zh).
