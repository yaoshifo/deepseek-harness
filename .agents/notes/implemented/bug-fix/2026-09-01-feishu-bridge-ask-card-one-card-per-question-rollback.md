# Agent Note: feishu-bridge ask cards rolled back to one card per question

Status: implemented

English | [中文](2026-09-01-feishu-bridge-ask-card-one-card-per-question-rollback.zh.md)

## Problem

The B2 ask-card rewrite (`9422ef636e`, 2026-08-24) collapsed a multi-question ask onto one card as a live form: every question stays interactive, each answer rebuilds the whole card through the card-action callback response, and any question can be revised until the ask settles. Within 8 days of that change the ask path accumulated 7 fix commits (the 08-31 live-form series `ddc8a8fd1b`/`80ae39f2d2`/`4e8104d485`/`8ee498dbaa`/`5011cb9862`, plus `aa61da55fa` checker namespacing) and 2 production incidents, against 3 minor fixes and 0 incidents in the preceding 14 days:

- 2026-09-01 09:05, oc_cd832bf1: two multiSelect questions on one card collided on checker names (`askq_opt_1` twice), Feishu rejected the card (ErrCode 11310), and the ask silently degraded to plain text (`aa61da55fa`).
- 2026-09-01 14:28, oc_52c9347bd: a 5-question card (3 single-select + 2 multiSelect) answered fine for questions 1, 2, and 5 — each answer swapping the whole card via the callback response — but from the third replacement on, every later button click stopped producing `card.action.trigger` callbacks at all. Four layers stayed silent: no card change, no hint message, no journald line, no session event. Triage could only proceed by exclusion; the session log proved the clicks never reached the engine (the `ask_user_question` tool call never settled), and the group message list proved the visible answer marks came from card callbacks, not chat text.

The architecture put the ask state machine on the Feishu card platform, which is a black box on exactly the axes the design depended on: whole-card replacement can be silently rejected (200673/200830: a JSON 2.0-stored card rejects 1.0 response bodies), per-answer replacement chains multiply that risk (N questions = N−1 replacements, each through 1.0→2.0 conversion, name validation, and the 30 KB cap), the card-wide component namespace is a failure surface a per-question card never has, and a dual answer ledger (platform `askqAnswered`/`askqMetaCache` vs engine `pending.answers`) needed its own sync fixes (`4e8104d485`, `8ee498dbaa`).

## Decision

User decision: roll back to one card per question. Implemented as a forward rewrite, not a git revert — the general-purpose fixes that landed after B2 (cron slot click routing `475652edbd`, i18n-owned ask copy, empty-submit rejection `80ae39f2d2`, the per-question text channel `ddc8a8fd1b`) survive; the multi-question live form does not.

- `engine/ask.ts`: `buildAskQuestionsCard` (live form with per-question revision state) replaced by `buildAskQuestionCard(q, qIdx, total)` — one prompt card per question — and `buildAskQuestionCardSettled(q, qIdx, total, answer)` — the read-only answer snapshot that replaces a prompt card exactly once, on its answer callback. The title carries the progress suffix `(N/M)`, baked in at send time; the settled rebuild recovers `total` from that suffix.
- `engine.ts`: `sendAskQuestionPrompt` sends the first unanswered question (card → inline buttons → plain text fallback chain preserved); `routeQuestionResponse` records every answer in the engine ledger and, when the answered question WAS the open one (first unanswered before the write), fire-and-forgets the next question's card. An addressed text answer (`3: …`) to a later question records it without advancing — the open card stays.
- `platform.ts`: the multi-question ledger is gone (`askqAnswered`, `askqCardMsgIDs`, `syncAskCard`, `buildAskCardResponse`, and the platform-side dedup that swallowed exact-repeat clicks in total silence — the direct source of the "clicked, nothing happened" experience in the oc_52c9347bd incident). `askqMetaCache` now holds ONE open question per session. The askq callback branch reads AND consumes the meta BEFORE dispatch — dispatch settles the answer and the engine then sends the next card, whose send overwrites the same cache key — then returns the settled snapshot as the callback response. A callback without cached meta still dispatches (the engine's ask state is the sole answer ledger) but warns on the console: that silent branch cost hours of exclusion-method triage once already.
- Question-number addressing (`2: …`) survives for revision: free text answers the open question, an address revises any other recorded one.

Known tradeoffs, accepted by the user: a multi-question ask now sends N cards (the message-noise regression B2 set out to fix), and "revise any question from the card" narrows to "answer the open card or address by number".

## Alternatives considered

**Keep the one-card architecture and patch observability** (toast on dedup hit, logs on silent branches, PATCH dual-write so a rejected replacement cannot freeze the card). Rejected: it treats symptoms — the replacement chain, the card-wide namespace, and the dual ledger remain, and each new Feishu-side conversion quirk buys another incident.

**One card per ask but without the live form** (answered questions freeze in place, open question gets a fresh card). Rejected: keeps half the multi-question ledger for no clear win over the simpler rollback.

## Consequences

A question card has no intermediate state: sent → answered → frozen. Each card sees at most ONE terminal replacement, and its failure is harmless — the next question's card is an independent message, so the flow never depends on a replacement landing. The engine's `pending.answers` is the single answer ledger; the platform cache is advisory (freeze rendering only). Frozen cards carry no controls, which removes the repeat-click surface outright; a racing duplicate callback re-dispatches (engine-side recording is idempotent) and surfaces the `ask card callback without cached question` warn instead of vanishing.

## Testing

`tests/engine/ask.spec.ts`: the per-question card builders — progress title, header fallback, single-select rows, multi-select checker form, optionless text form, settled snapshot with frozen marks and custom text, i18n faces. `tests/engine/engine-ask.spec.ts`: one card for the first unanswered question, advance on answering the open one (card action and free text alike), addressed answers to later questions record without advancing, settle only when all are answered. `tests/engine/engine-m3-askq.spec.ts`: the send fallback chain per question and already-answered skipping. `tests/feishu/card-action.spec.ts`: meta caching at send (title suffix carries the total), callback freeze with the answer marked, text-submit and multi-submit payloads, empty-submit rejection, meta-miss dispatch-with-warn, repeat-click re-dispatch behavior, localized copy.
