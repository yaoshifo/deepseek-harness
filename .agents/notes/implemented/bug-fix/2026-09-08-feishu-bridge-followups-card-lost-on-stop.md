# Agent Note: A stop must salvage a deferred followups card, not discard it

Status: implemented

English | [中文](2026-09-08-feishu-bridge-followups-card-lost-on-stop.zh.md)

## Problem

The 2026-09-08 oc_469693e0 incident (spawned group 「图片查看分析」, tingting bot): the agent's closing-card ask was converted to a non-blocking followups registration mid-turn (three options). The turn then completed with a message already queued (the user had written during execution), so the turn-end emission skipped both the ✅ completion card and the followups card, keeping the registration for "the drain loop's final turn" — by design. The queued message took over as the next turn, and the user ran `/stop` on it. `stopInteractiveSession` tears down the whole `InteractiveState`, and the pending registration died with it: the question card never reached the chat, with no notice. The user read this as "sending a message during execution suppressed the card."

## Decision

`stopInteractiveSession` now salvages a live `pendingFollowups` registration before teardown: when the registration exists and `state.platform` is set, it fire-and-forgets the existing `sendFollowupsCard` (`packages/acp/feishu-bridge/src/engine/engine.ts`). That method already clears the registration before sending, drops it silently on card-less platforms, and never retries — the stop path stays synchronous and cannot wedge on the send. The turn-end drop for errored/non-completing turns is unchanged: a stop is an explicit user halt, not a failed turn, and the registration's underlying analysis already streamed to the user.

## Alternatives considered

- **Deliver the card at the completing turn's end even with a queued takeover.** Changes the designed card ordering for every queued takeover to close a loss window that only manifests when the takeover gets stopped; over-broad.
- **Mark registrations as earned (owning turn completed) and salvage only those.** Adds state for a distinction with no incident behind it: after a mid-turn stop the analysis is already visible on the pinned card, and the suggestion menu helps the user resume.

## Consequences

- Tests pin the salvage: `stopInteractiveSession` with a live registration sends exactly one followups card and clears the registry; with nothing registered it sends nothing (`packages/acp/feishu-bridge/tests/engine/followups.spec.ts`).
- The salvaged card races the ⏹ stop finalize (both fire-and-forget); their ordering is not guaranteed — acceptable for a non-blocking suggestion card.
- Queued messages are unaffected: stops already notify dropped senders (`notifyDroppedQueuedMessages`), which is how the incident's 「排队」 message was dropped with a visible error reply.
- Deployment: bridge rebuild + `/reload`.
