# Agent Note: Three-state /ps pickup reactions; dead Go-port reaction knobs removed

Status: implemented

English | [中文](2026-09-17-feishu-bridge-ps-three-state-reaction.zh.md)

## Problem

`/ps` acknowledged a mid-turn append with a 'Done' reaction the instant `steer()` returned — but steer only drops the text into the agent's next-step inbox. Between that moment and the model actually seeing the text sit a long tool call or a parked permission card (minutes), so the emoji asserted "processed" while the truth was "queued". Ordinary messages never had this blind spot (the 📬 queued-notice reply plus the next turn's progress card), `/ps` was the only surface lying.

Separately, `reactionEmoji` and `doneEmoji` (Go `reaction_emoji` / `done_emoji`) were ported as config knobs but never wired: the typing-indicator and completion-reaction platform methods had no caller, so a configured knob was inert — the silent-misconfiguration class the 2026-09-14 progressStyle guard named.

## Decision

The /ps acknowledgement is now a three-state reaction on the triggering message, and the two dead knobs are gone.

**Signal — the claim's durable event.** When the agent loop claims the steer batch, it appends the claimed messages as durable `user/message` events in the same synchronous block that builds and dispatches the model request (agent-loop `step()`), so that event is the exact "the text entered a model request" moment. `DshAgentSession.steer` now returns the minted steer message id and records it in a per-session pending set; `projectSessionEvent`'s `user/message` case matches the event's id against that set and pushes a new `steer_claimed` event (carrying `steerMessageID`) onto the engine channel. Unsteered ids (turn prompts, injections) stay silent, and each id projects exactly once.

**Engine — settle states.** `cmdPs` adds the `Get` reaction through `ReactionManager.addReactionWithID` and records `{platform, replyCtx, reactionID}` under the steer id on `InteractiveState.pendingSteerReactions` (a BoundedStateMap whose eviction retracts the oldest Get — the steered text itself stays queued in the agent's durable inbox; only the marker is given up). The interactive pump's `steer_claimed` case settles **claimed**: retract Get, add `DONE`. `stopInteractiveSession` and `cleanupInteractiveState` settle **stopped**: retract Get, fire the platform's `addCancelledReaction` — the configured `cancelEmoji`, now defaulting to `CrossMark` with the previously missing `'none'` normalization fixed. A steer parked at a turn boundary keeps its Get until the next turn claims it (the claim event is consumed by the next pump), which is honest: still queued. Platforms without id-based retraction keep the old single-shot `DONE`.

Emoji keys follow the official Feishu emoji table (`Get`, `DONE`, `CrossMark`; the old code's `'Done'` was evidently case-tolerant — canonical casing now, verified in the live smoke).

**Removal.** `reactionEmoji`/`doneEmoji` are deleted across the config interface, schema, assembly mapping, and platform (fields, `startTyping`, `pendingTypingRemovals`, `addDoneReaction`), along with `StreamPreview.needsDoneReaction` and its tests. Leftover keys in a profile fail loud at load, following the progressStyle/predictNext guard precedent (Schemastery keeps unknown keys alive).

## Alternatives considered

- **The in-process `agent/inbox/claimed` dispatch event as the signal.** Rejected: the durable `user/message` event is the "model-visible ⟺ logged" invariant point, already routed through the adapter's existing `session/event` subscription, and replayable; the dispatch event would add a second subscription for the same fact.
- **Anchor on the first streamed chunk (the model started replying).** Rejected: DONE would lag by TTFT seconds, and a request that fails before the first chunk would never be marked (the error card already owns failure reporting).
- **Accumulate Get and DONE without retraction.** Rejected: a lingering Get reads as "still queued" forever; the monitor flow's remove-and-swap is the established pattern.
- **Persist the pending-reaction map.** Rejected: reactions are ephemeral platform state; a daemon restart leaves a stale Get on rare in-flight steers — the same accepted property as the monitor's reaction ids.
- **Wire `reactionEmoji` (typing indicator) instead of removing it.** Rejected by user decision: the /ps Get covers the actual need; the dead knob goes.

## Consequences

- `AgentSession.steer` (bridge-internal interface) now returns the steer message id; all implementers, stubs, and the two machine-steer callers (which ignore it) updated.
- The Event channel grows one kind (`steer_claimed`); the three closed switches carry it (interactive settles; spillover and relay no-op) and `isSubstantiveUnsolicitedEvent`'s default-false already ignores it for the unsolicited reader. Machine steers (`deliverMachineMessage`) also project claims — the engine settles nothing for ids without a record; ordinary turn prompts emit nothing.
- **Deploy ordering**: profiles still setting `reactionEmoji`/`doneEmoji` fail loud at load — remove the two keys from the live profile (both bots) before reloading the new build; `cancelEmoji: CrossMark` can stay (it is now live and matches the new default).
- Accepted races, documented: a claim event drained in a stall-retry channel swap can leave a Get on an already-claimed steer (under-reports, never lies); a daemon restart loses in-memory records (stale Get). The stop/cleanup settlements cover every engine-initiated teardown path.
- No model-visible change: the `user/message` durable event already existed; no session-format or snapshot impact.
