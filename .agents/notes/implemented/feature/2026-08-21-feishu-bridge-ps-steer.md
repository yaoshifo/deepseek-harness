# Agent Note: /ps mid-turn delivery via the agent-loop next-step inbox

Status: implemented

English | [中文](2026-08-21-feishu-bridge-ps-steer.zh.md)

## Problem

`/ps` appends text to a running task. The initial port routed mid-turn text through `AgentSession.send()` → `followup()`, whose semantics are a next-turn FIFO: the message becomes the next turn's prompt only after the current turn ends. That is the engine busy-queue under another name, so the Go behavior — writing the text to the running task's stdin so the model sees it inside the current turn — was lost in the port. The port's `pending` branch (queue when the turn is blocked on a permission) worked around the same stdin problem: a direct write would sit behind the CLI input queue while the permission prompt held it.

## Decision

`AgentSession` gains `steer(prompt: string): void`; `dshAgentSession` implements it by refreshing `lastActivityAt` and calling `handle.agent.steer` with a plain user text message. The dsh core `Agent.steer` appends the message to the agent's next-step inbox and wakes the driver, which claims inbox messages between steps, so the text joins the next LLM request inside the same turn. `cmdPs` collapses to three synchronous branches: empty argument → usage reply; idle → strip the prefix and fall through as a normal message; otherwise `steer` plus a Done reaction.

The `pending` branch and the async send chain are deleted. The in-process inbox has no stdin-swallowing problem: text steered while the turn waits on a permission is claimed at the next pre-step once the approval lands — same-turn delivery, which Go reaches only approximately by queueing. The `ps_send_failed` i18n key is deleted with it; steer is synchronous and has no failure path. A steer arriving exactly as the turn closes stays in the next-step inbox and is claimed at the next turn boundary — delivery degrades to next-turn, never lost. Steered text and queued followups coexist: the inbox is claimed between steps of the current turn, queued followups at the next turn boundary.

## Alternatives considered

**Keep `send()` plus the pending-permission queue.** Rejected: `followup()` is the busy-queue again, so mid-turn injection stays lost, and the async path needs a failure reply the steer path does not.

**Optional steer by structural detection instead of an interface method.** Rejected: every dsh session supports steer; a pre-release interface with no compatibility shims lets the compiler name any stub that lacks it.

**Steering every mid-turn plain message by default.** Out of scope: a product-semantics decision beyond `/ps`, not taken here.

## Consequences

Mid-turn `/ps` text is model-visible in the current turn. Model-visible ⟺ logged holds without a new session event: steer goes through the agent-loop's persistent inbox. Abort wake classification (`wakingAfterAbort`) is owned by agent-loop and needs no bridge handling.

## Testing

`tests/engine/misc-commands.spec.ts` rewrites the `/ps` block: mid-turn asserts `steerCalls` receives the text and `sendCalls` stays empty with a Done reaction; a turn blocked on a permission still steers, with `pendingMessages` unchanged and no queued-reply message; idle strips the prefix and falls through. `tests/agent-dsh/adapter-steer.spec.ts` (2 cases): `steer()` routes a user text message into `handle.agent.steer` rather than the followup queue, and `send()` stays on the followup queue. Nine existing stubs gain a no-op `steer` to satisfy the interface.

## Related

Supersedes the `/ps` slice of [seven more cc-connect commands](2026-08-20-feishu-bridge-seven-commands.md); the other six commands and the generated `/help` in that note are unchanged.
