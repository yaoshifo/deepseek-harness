# Agent Note: feishu-bridge listItem rows own their markdown; the projection must not re-bold

Status: implemented

English | [中文](2026-08-26-feishu-card-list-item-double-bold.zh.md)

## Problem

Every interactive list-row card (/dir picker, /sessions, delete-mode, /help, chatroom role and topic pickers) rendered raw markdown asterisks on Feishu — `/dir` rows showed `◻ ** 16. ** /Users/...` instead of a bold row number over a code-styled path. Root cause was a port-time inconsistency with two halves landed in the same M2/M4 port: the card builders (dir-card, session-card via the `list_item` i18n template, misc-commands, chatroom-pick) pass `CardListItem.text` already carrying markdown (`◻ **16.** \`/path\``), while the Feishu projection (`renderElement` listItem case) wrapped that text in another `**…**`. The nested pair then broke `padBoldDelimiters`, whose regex pairs the nearest `**…**` boundaries: it re-paired `**◻ **` as one bold run, inserted its padding spaces at the wrong boundaries, and emitted `**◻ ** 16. ** /path**`, which Feishu renders as raw asterisks. The exact projection string was reproduced from source before the fix.

## Decision

`CardListItem.text` is markdown content the caller owns; the row renders it as the bold row label only when the caller did not style it. The Feishu listItem projection checks `elem.text.includes('**')`: styled text passes through verbatim into `finalizeFeishuCardMarkdown`, plain text keeps the default `**…**` wrap. This matches the two existing consumers of the same field that already treat it as caller-owned markdown — the delete-mode checker transform (lark_md, no wrap) and `Card.renderText()` (no wrap) — so the projection's unconditional wrap was the outlier, not the callers.

## Alternatives considered

- **Drop the wrap entirely and bold the plain-label caller (`ask.ts`) at construction.** Rejected: the ask-card freeze round-trip stores `elem.text` back as the option label (`askCardMeta`) and rebuilds rows through the same builder, so a construction-side wrap double-bolds to `****label****` on every card-action replacement; fixing that means touching `ask.ts` and `platform.ts` for zero visual gain.
- **Fix `padBoldDelimiters` to pair nested bold correctly.** Rejected: the corruption is a symptom; the input was already invalid nested emphasis. Nothing else on this path produces nesting, and model-generated nested bold in preview cards is a separate latent issue noted below.
- **Fail loud at build time when `listItemBtn` receives text containing `**`.** Rejected: five shipped call sites rely on markdown-rich rows; the contract is "caller owns markdown", not "caller sends plain text".

## Consequences

- All five affected surfaces (/dir, /sessions, /help, chatroom pickers) now render single-level bold correctly; plain-label askq rows keep their bold label, including the answered-card freeze path.
- A row whose text contains an unpaired `**` (e.g. a session summary with a literal `2**3`) skips the wrap and may still leak asterisks through Feishu's own nearest-pair parsing — no worse than the pre-fix state, which mangled every row.
- `padBoldDelimiters` still mis-pairs malformed nested bold in model-generated markdown (e.g. `**a **b** c**` in a reply body); with the listItem nesting gone no current caller hits it, but the parser remains pairwise and would need a real tokenizer to fix.
- Covered by `tests/feishu/card.spec.ts` (styled row passes through verbatim; plain row still bolds) and the existing dir-card/session-card/delete-mode specs.
