# Agent Note: Unsolicited-reader duplicate tool-frame drop

Status: implemented

English | [中文](2026-09-04-feishu-bridge-orphan-pump-duplicate-tool-frame.zh.md)

## Problem

The 2026-09-04 oc_1fbe11 chatroom run: a foreground (message-path) turn completed at 02:03:32, and 32 seconds later the runtime re-projected an already-consumed `tool_use` frame onto the event channel — the durable session log records zero events between that turn end and the next engine-woken turn, so the frame had no live turn behind it. The unsolicited reader's spillover grace (assembly default 30s, Go wire.go parity) had expired 2 seconds earlier, so the reader escalated the duplicate to a full orphan-turn pump: a phantom preview card plus a `beginTurn()` session lock, kept alive by the tool-in-flight budget because the duplicate's tool_result never arrives (the original pump already consumed it). The pump sat for 10 minutes until a genuine engine-woken turn's events happened to drain through it. Self-healed with no loss, but the entry path is generic: any late re-projection landing past the grace window opens a phantom pump, and the 2026-08-26 frozen-clock incident is the same entry with a worse ending.

## Decision

- The unsolicited reader drops a substantive first event that is a `tool_use` or `tool_result` whose `toolID` names a call one of this state's pumps already consumed, instead of escalating it: duplicates carry nothing user-visible and must not open a pump, send a card, or take the session lock.
- `InteractiveState.consumedToolIDs` (FIFO-capped at 64, in-memory) records call ids at the two consumption sites — the shared turn pump's `tool_use` case and the spillover relay's. A daemon restart clears the set; acceptable, because strays only matter while states live.
- Frames without a `toolID` cannot be classified and keep today's escalation, as do frames with a fresh id: a genuine engine-woken turn's first tool frame never matches, since call ids are unique per request.
- Deployment-side, the production profile sets `unsolicited.spilloverSec: 120`, so within-window duplicates — including duplicate result/text frames the id ring cannot see — take the plain-text spillover relay instead of a pump.

## Alternatives considered

- **Rely on a wider spillover grace alone.** A grace window only covers bounded lateness; the id ring catches arbitrarily late re-projections and skips the relay's lingering `activeToolCalls` count for tool frames. Both shipped: the grace absorbs text/result duplicates the ring cannot classify, the ring absorbs tool duplicates the window may miss.
- **Relay duplicate tool frames as spillover text.** A bare tool frame relays no text, waits a full idle cycle for a result that never comes, and leaves `activeToolCalls` elevated; dropping is strictly cleaner.
- **Fix the runtime's late re-projection at its source.** Known runtime behavior since the 2026-08-26 incident; the reader exists to absorb engine-side wakes, and the projection layer is shared with surfaces that already tolerate duplicate frames.

## Consequences

- Tests pin: a re-projected `tool_use` after the pump exited opens no pump and leaves the message path free for the next user turn; a duplicate `tool_result` likewise drops while the reader stays armed for a genuine report; a `tool_use` without a call id still opens the pump (fallback), and the pre-existing fresh-id tool-first wake test still opens it.
- The 120s spillover window's cost: a genuine background wake arriving within 120s of a foreground completion is relayed as plain text (reply text still delivered, `lastResult` still recorded) instead of a full carded pump.
- Deployment: bridge rebuild + `/reload`; afterwards, journal `orphan turn pump started` lines should each be followed by a genuine engine-woken turn's events.
