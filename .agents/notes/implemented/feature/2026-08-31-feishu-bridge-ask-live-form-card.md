# Agent Note: feishu-bridge ask card is a live form with a per-question text channel

Status: implemented

English | [中文](2026-08-31-feishu-bridge-ask-live-form-card.zh.md)

## Problem

The merged multi-question ask card ([B2](../simplification/2026-08-24-feishu-bridge-ask-delegate.md)) had exactly one free-text channel: chat text, routed to the first unanswered question. Live incident (2026-08-31, ops group): after clicking question 1's option, a clarification meant for question 1 — 「直接复用 记账驴 不再新建」 — bound to question 2 as its custom answer, because question 1 was already answered and the router only ever falls forward.

Three more defects shared the same root:

- No revision path. Answered questions froze (buttons removed from the replacement card), the platform callback dropped re-clicks on answered questions despite its comment promising updates, and chat text could not name an answered question.
- A card click after the ask settled leaked the raw `askq:N:M` payload to the model as its next prompt.
- The card's only teaching was a 「也可以直接文字输入」 note that never said which question the text would answer.

## Decision

The card is a live form until it settles.

- **Every not-yet-settled question stays interactive and shows its current answer**: single-select rows keep their buttons with a `当前：` line above them, multi-select checkers keep their submit with the current selection ticked, and card-input answers show as `✍️ text`. Once every question is answered the replacement is the read-only terminal card — frozen marks, custom text, no controls, title stamped `· 已全部作答`.
- **Each question carries its own text channel**: an input (`askq_text_{q}`) plus a form_submit 「✍️ 文字作答」 button (`askq_text_submit_{q}`), including on option-less questions where the input is the only on-card answer path. The wire gains `askq_text:{q}` and riding text after a NUL separator on any payload (`askq:{q}:{idx}\x00{text}`) — the same convention as `perm:` verdict notes. `parseAskqSelection` splits on NUL before parsing indices, so answer text containing colons cannot break the wire format; `resolveAskAnswer` lets `custom` accompany `selected`, which the upstream user-questions type always allowed.
- **Chat text can address a question**: on multi-question asks an `N: answer` prefix binds (and revises) question N. A half-width colon requires a following space, so `2:30` stays a plain answer; a full-width colon accepts none, matching IME habits. Out-of-range prefixes stay plain text. The ✅ echo carries `（n/total）` progress and, while other questions are also open, teaches the prefix (`Msg.AskqTextAddressHint`).
- **Revision passes, retries don't**: the platform dedup swallows only exact repeats (double-click / callback retry); a changed answer updates the recorded answer and re-dispatches, and the engine overwrites per question — last write wins.
- **Stale clicks are consumed**: an askq card action with no parked ask replies `AskqStaleQuestion` instead of leaking the payload.

## Alternatives considered

**Roll back to one card per question** (the pre-B2 Go behavior). Splitting into N simultaneous cards leaves the first-unanswered routing ambiguity untouched — only the sequential cursor variant (next card sent after the current one answers) removes it, and that rewrites `routeQuestionResponse` plus both behavioral spec suites (`engine-m3-askq`, `card-action`). More work than the live form, and N cards per ask spam the chat.

**An explicit 「完成作答」 submit gate** (maximal revision window). Rejected: it adds a mandatory step to every ask — including the single-question majority that already works — and parks the turn forever when the user forgets to submit; normal sessions have no ask timeout (only chatroom research-manual has a 10-minute default). The live form plus auto-settle plus next-message correction covers the same scenarios with zero extra steps.

**Drop the first-unanswered fallback; require addressing always.** Rejected: single-question asks work today precisely because plain chat text answers them; the closing-question convention (`agent-conventions.ts`) depends on unprefixed free text carrying 「treat as a new task」 instructions.

## Consequences

- Card shape changes observably: every interactive question carries a text-input form, answered-but-open questions show their current answer instead of freezing, and settled cards are read-only with `· 已全部作答`.
- Feishu rebuilds the card from every callback response, so a draft typed into one question's input is discarded when any button on the card is pressed. Inputs are per-question, so the blast radius is one question's draft; accepted answers are echoed on the card itself.
- Residual ambiguity, accepted: an unprefixed chat answer that happens to start with `N:` (half-width colon plus space, or a full-width colon) binds question N; a plain numeric answer still means an option index. Corrections after settle are ordinary next-turn messages — the ask tool has already returned.
- `AskCardAnswered` values widen from `number[]` to `{ indices, custom? }`; the chatroom consumer reads only the engine's answers map and is unaffected.
- An empty text submit (`askq_text_submit_{q}` with a blank input) is a no-op — it neither dispatches nor churns the card.

## Testing

`tests/engine/ask.spec.ts`: NUL-split parsing (`askq_text:`, riding text, colons in text), custom-alongside-selected resolution, live-form card shape (input form, revisable answered questions, terminal card, per-card teaching note). `tests/engine/engine-ask.spec.ts`: prefix addressing and revision, out-of-range fallback, clock-time non-address, progress echo with the addressing hint, card text submit settling, stale-click consumption. `tests/engine/engine-m3-askq.spec.ts`: card element shape with the text form. `tests/feishu/card-action.spec.ts`: text-submit dispatch and terminal replacement, multi submit riding its input, empty-submit no-op, exact-repeat dedup vs revision pass. `tests/feishu/card.spec.ts`: the input rendered inside the checker form with the chat-text hint dropped.
