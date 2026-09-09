# Agent Note: Truncated turn-end cards title the cut, not a completion

Status: implemented

English | [中文](2026-09-09-feishu-bridge-max-tokens-card.zh.md)

## Problem

A turn cut by the output-token cap settled its progress card as a green
`执行完成 · <ts> · <n>` header, indistinguishable from a completed turn
(2026-09-09 oc_9eed: a turn truncated mid-reasoning while the agent was
working around a render failure — the user saw "finished" with no image and
no closing text). The loss started at the projection: the adapter's
`turn/end` handler mapped only `error` reasons onto the bridge `result`
event (`errorText`); every other non-completed reason kind was dropped, and
the engine's settlement collapsed to `errored ? failed : completed`. The
subtask settlement path already carried a non-completed stop-reason
vocabulary (`settlementDeliveryText`'s `SubtaskSettlementMaxTokens` prefix);
the main-chat card path had none.

## Decision

Carry the terminal stop-reason kind through the projection and add a
terminal card state that names the cut:

- The `result` event gained an optional `stopReason` (the `turn/end` reason
  kind, set only for non-`completed` non-`error` turns — error turns already
  carry `errorText`).
- The card-state vocabulary gained `truncated`: orange header, title
  `输出截断` / `Truncated`, rendered by both card surfaces (structured
  payload cards via `progressStateMeta`, preview text cards via
  `progressTitleAndColor`). It is terminal: the stop button and the running
  spinner treat it like green/red, and the in-flight-subtasks title suffix
  applies.
- The engine routes a `max-tokens` turn to `truncated` on all three
  terminal renders: the compact writer's `finalize`, the stream preview's
  `markTruncated` (new; `markCompleted` refactored onto a shared locked
  core), and `finish(text, truncated)`.

Scope: only `max-tokens` changes its rendered outcome. `refusal` and
`aborted` keep their current settlement (user stop renders the stopped card
through its own path); widening their card semantics is a separate decision.

## Alternatives considered

- **Prefix the reply text like the subtask settlement does:** rejected —
  the progress card is the glanceable terminal signal; a text prefix is
  invisible to a user who never opens the reply.
- **Reuse `failed` red for max-tokens:** rejected — the turn did not fail;
  its work up to the cut stands. Red would prompt retry/panic where the
  honest state is "cut, resume by asking to continue".

## Consequences

- `truncated` joins `ProgressStatus['state']` and `ProgressCardState`; card
  renderers outside this package that switch on the state string see a new
  terminal value (the stop-button and spinner whitelists already treat
  unknown non-running templates as terminal by default).
- The ✅ completion-notification footer still reads `✅ 完成` for a
  max-tokens turn; aligning that footer is left open (it is a status
  digest, not the turn's terminal claim).
- Coverage: adapter projection (max-tokens carried, completed omitted),
  engine finalize (truncated, and not completed), preview `markTruncated`,
  title/color localization both languages, stop-button and spinner hiding.
