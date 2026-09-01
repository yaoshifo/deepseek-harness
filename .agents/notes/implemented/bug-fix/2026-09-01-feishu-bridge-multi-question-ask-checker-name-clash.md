# Agent Note: feishu-bridge multi-question ask cards duplicated checker names and were rejected by Feishu

Status: implemented

English | [中文](2026-09-01-feishu-bridge-multi-question-ask-checker-name-clash.zh.md)

## Problem

When one ask carries two or more multiSelect questions, both questions' checker forms rendered their checkers starting at `askq_opt_1` — the checkOptions renderer numbered checker names by the option's index within its question only. Feishu validates interactive-control names card-wide and rejects card creation with HTTP 400 (code 230099, ErrCode 11310 `name(askq_opt_1) duplicate`). `sendAskQuestionsCard`'s `sendCard` catch is silent, the Feishu platform has no `sendWithButtons`, so the ask degraded to the numbered plain-text fallback: the questions stayed answerable by replying with digits, but the card with clickable checkers never appeared. First triggered in production on 2026-09-01 09:05 by a dida todo-triage ask with two multiSelect questions (9 + 8 options). Single-question cards never collide, and single-select questions in multi-question cards take the listItem-button path whose payloads carry the question index — only the multiSelect checker path was misnamed.

## Decision

Checker names carry the question index: `askq_opt_{q}_{n}`, with `q` extracted from the checkOptions action (`askq_multi:{q}`) — the same pattern the adjacent submit button already uses (`askq_multi_submit_{q}`). The submission parser `collectAskqMultiSelected` takes the option index after the last underscore of the key, which reads both the new `askq_opt_{q}_{n}` form and the bare `askq_opt_{n}` form of pre-fix single-question cards (those cards remain clickable for as long as the daemon keeps their interactive state). The engine's ask- and permission-card send cascades (`sendCard` → `sendWithButtons` → plain text) now log `console.warn` with the session key or tool name and the error message at every fallback step: the production incident left no engine-level trace and was diagnosable only through the axios global error handler.

## Alternatives considered

**Deriving checker names from labels or hashes.** Rejected: the parser would need a reverse mapping; the numeric segments carry the index directly and sort naturally.

**Strictly splitting `{q}_{n}` and matching `q` against the submit's question index.** Rejected: form_value only carries components of the submitting form (a Feishu guarantee), so the question segment is redundant there; the last-underscore read also covers the legacy single-question form without a second branch.

## Consequences

Multi-question multiSelect ask cards are creatable again. The legacy-name compatibility window is the daemon's lifetime: after a restart the interactive states are gone and old cards are dead buttons regardless (pre-existing behavior). No other consumer reads checker names — a repository-wide search finds only the renderer and the submission parser.

## Testing

`tests/feishu/card.spec.ts`: a two-multiSelect-question card renders card-wide unique control names (the minimal repro of the 400). `tests/feishu/card-action.spec.ts`: new-format keys `askq_opt_1_2`/`askq_opt_1_10` parse to `askq:1:2,10`; the pre-existing bare-name test keeps passing.
