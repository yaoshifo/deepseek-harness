# Agent Note: single-select ask cards drop the on-card text input; text answers go through chat

Status: implemented

English | [中文](2026-09-16-feishu-bridge-askq-single-select-no-text-input.zh.md)

## Problem

On a single-select question card, the option buttons and the text-input form were two unrelated submit paths: the option buttons rendered as list rows outside the form, so a button click could not carry the input's draft. This produced two user-facing ambiguities:

1. A recommended option renders as a primary (highlighted) button, which read as "pre-selected" — typing into the input and tapping "Answer with text" felt like it would submit the recommendation plus the text. It submitted text only.
2. Typing a draft first and then tapping an option button felt like it submitted both. It submitted the option only; the draft stayed in the input, unsent.

Multi-select cards and the followups suggestion card have always treated their in-form note as a supplement to the selection; single-select was the sole exception, and that inconsistency was the breeding ground for both misreadings.

## Decision

An option-bearing single-select question no longer renders an on-card text-input form (input + "Answer with text" submit button). The closing hint note now points at chat: "Not choosing? Reply in chat instead". Chat free text was already a working answer path (resolveAskAnswer's custom branch; multi-question asks accept `N: answer` addressing), so the card keeps no text channel of its own.

An optionless question keeps its text-input form — it is that card's only on-card answer path, and with no options to combine with, the input carries no ambiguity.

"Select an option, then add text" gets no native support: a chat message right after a submitted answer is understood as a supplement (the model sees both in adjacent context), and the residual timing race — the answer settles and the agent continues immediately, so a slow supplement lands next turn — is the natural rhythm of chat, not a defect. A question whose options routinely need a supplement is a question-design problem, fixable by better options or an optionless ask, not by interaction-layer patches.

## Alternatives considered

**Fold the option buttons into one form so a click rides the input draft** (unifying "text = supplement" across all card kinds). Rejected: four-file chain (card render, callback parsing, card-meta extraction, i18n), a brand-new callback decode path alongside the legacy one, an unvalidated in-form list-row layout on the Feishu card schema, and a real-device smoke gate — all for a non-mainstream scenario.

**Two-step submit** (checkbox form + submit button, matching the multi-select shape). Rejected: loses tap-to-answer immediacy for the common case.

**Copy-only mitigation** (sharper placeholders and button labels, behavior unchanged). Rejected: the silently-dropped draft remains; treat-the-symptom.

## Consequences

- `askq_text:` callback handling stays — optionless cards and cards sent before this change still use it; pre-change single-select cards in users' chats keep working unchanged.
- The `askq_text_placeholder_options` message key is deleted (only the with-options card used it); `askq_text_placeholder` ("Type your answer") now serves the optionless form alone.
- The single-select vs multi-select card shapes stay different, but without semantic conflict: text appears only on multi-select cards, where it is always a supplement; single-select cards carry no text at all.
- A text supplement sent after an option click lands on the next turn (the timing race above), by design.
