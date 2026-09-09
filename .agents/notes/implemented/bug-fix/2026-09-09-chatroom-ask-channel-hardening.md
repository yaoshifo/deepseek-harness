# Agent Note: Chatroom ask-channel hardening — machine delivery, honest wakes, early caps

Status: implemented

English | [中文](2026-09-09-chatroom-ask-channel-hardening.zh.md)

## Problem

Three latent hazards surfaced by the 2026-09-08 oc_9b99f postmortem, after `1be82d7682` fixed the stale-relay incident itself. First, the serial-stall supervisor wake quoted `role.lastResult` — the same stale-answer-as-current-status pattern that had misled the moderator into treating an old clarification reply as a fresh answer. Second, chatroom asks and gather broadcasts were injected through the human message pipeline (`receiveMessage`): a busy role's queue caps at five messages and then drops silently (QueueFull), rate limiting drops, and agent death drops the queue — the role is never asked, its `pendingSerialAsks` entry lingers, and nobody learns the question was lost. Third, every start path that bypasses the role picker (the explicit multi-role command, `--continue` reuse, the moderator start tool, start-picker continue) enforced `maxRoles` only deep inside `startChatroom` — after venv provisioning, mode-card arming, or picker-state deletion — so an over-cap cast burned side effects before failing, and retrying meant rerunning `/chatroom`.

## Decision

- **The serial-stall wake drops the lastResult excerpt**; role name, elapsed minutes, and the re-ask-or-move-on guidance remain. The steward wake keeps its excerpt — it is load-bearing facts phrased in the past tense ("last reply: …"), a framing its tests document and the moderator relies on to weigh a long task against a genuine hang.
- **Asks and gather broadcasts deliver through `deliverMachineMessage`.** An idle role takes the same handling chain as before — metadata, including the ask identity, rides along and the turn-start stamping hook is unchanged — only now flagged machine. A busy, live role gets the question steered into its current turn; landing exactly at a turn boundary leaves it in the durable inbox for the next turn. Content is never silently dropped, and the human pipeline's queue cap and rate limit no longer gate coordination messages. Because steer is content-only (it opens no turn, so the stamping hook has nothing to consume), the ask-identity pre-stamp becomes unconditional: busy-steer relays route by it, and the idle turn-start restamps the same value (idempotent).
- **`assertChatroomRoleCount(e, names)`** (chatroom-roles.ts) throws the same `chatroom: too many roles (N > max M)` as the `startChatroom` backstop, which stays. Every bypassing start entry calls it before its first side effect — venv provisioning, mode arming, ledger inherit scan, picker-state deletion. The card-action seam converts the throw into an error card and keeps the picker state. The guided path needs no fifth check: its cast originates from the now-pre-checked entries or the picker's own confirm gate.

## Alternatives considered

- **Annotating the wake excerpt** ("stale, not this round's answer") instead of dropping it: still feeds an LLM moderator old answer text adjacent to a question; the ledger already holds the last reply when needed.
- **Extending the machine channel to carry metadata through steer**: steer never opens a turn, so the turn-start stamping hook has nothing to consume; a channel-level parameter cannot fix a primitive-level fact.
- **Pre-writing `chatroomAwaitAssistant` on busy-steer research dispatch**: a deferred await consumed by an unrelated turn end mis-attributes research; assistant reports arrive through the subtask report wake regardless.
- **Relying on the `startChatroom` backstop alone** (status quo): the backstop remains, but early failure is the point — the side effects before the throw defined the failure cost.
- **Auto-trimming an over-cap cast**: silently discards explicit user/moderator choices; the fail-loud rejection with the cap stated on the card is the designed path.

## Consequences

- Tests pin the wake without the excerpt (the fixture keeps a `lastResult` to prove absence), machine delivery for asks and broadcasts (steer for busy roles, no `receiveMessage`), the unconditional stamp pre-write, and the four early-cap entries (venv steps = 0, mode not armed, inherit scan skipped, picker state kept). Four existing tests were adapted to the new delivery timing; their routing assertions are unchanged, including the oc_97be4a1c protection scenario under busy-steer timing.
- Known residuals: the startup and dead-agent window still falls back to pipeline queuing (the machine channel's pre-existing fallback, shared with gather injections and supervisor wakes); `chatroomAwaitAssistant` does not ride a busy-steer research dispatch (low-frequency path, content still arrives via the report wake); a steer landing just before a turn ends can be absorbed as the round's answer while the message itself waits in the inbox — accepted, content is never lost.
- Deployment: bridge rebuild + `/reload`.
