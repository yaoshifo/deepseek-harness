# Agent Note: Subagent activity on the tool-progress card — lineage projection behind the routing drop

Status: implemented

English | [中文](2026-08-21-feishu-bridge-subagent-card-projection.zh.md)

## Problem

The cc-connect-era card showed only the parent session's events: a delegated subagent child runs its own session (its own durable log, its own `parentSession` header), `DshAgentAdapter` routes `session/event` by session id through `liveSessions`, and child ids never match, so a child's internal tool calls were invisible during a delegation — the card showed only the parent's `subagent` tool call and its result. The user watching a card could not tell what a running child was doing or how many children the session had used.

The events were already arriving: `session/event` is a process-wide firehose whose scope filter admits untagged listeners globally (`packages/core/scope/src/index.ts`, `scopeTarget`), and the adapter's listener is untagged. Child events were received and dropped at the `liveSessions` lookup.

## Decision

`DshAgentAdapter`'s `session/event` handler falls back to lineage attribution when the session id is not a live bridge session: walk `session.header.parentSession` links upward through `ctx.agents` (capped at 8 hops) until a live bridge session matches, then project the event into that session's channel. Direct children, grandchildren, and deeper descendants attribute to the same bridge session; a broken chain (a mid-lineage session no longer live) drops the event, preserving the old invisible-child behavior. `/fork` sessions and one-shot query sessions carry no attribution risk: forks register in `liveSessions` themselves (direct route), and one-shot sessions set no `parentSession` meta.

`DshAgentSession.projectSubagentEvent` projects only `tool/call`, `tool/result`, and the first `turn/start` of each child — a child's assistant text and reasoning stay on its own transcript, or one chatty child would flood the parent card. Child tool ids are namespaced `${childSessionId}:${callId}` so results match their own calls while parent calls interleave (the card's positional fallback matching would otherwise close a parent entry with a child result). A cumulative `seenChildren` set counts every child session that ever ran a turn, emitting a `subagent_status` channel event when the count grows — never when it shrinks, because it never does: a continuable child running many turns counts once, and the count on a completed card stays true for background children still running.

The engine renders child tool calls with the delegation label — the header line reads `⚙️ subagent` (the real tool name rides the code block as `read -> /path` via the entry's `fullName`) — and consumes `subagent_status` into the card's pinned stats section as `🤖 Sub Agent：N` (hidden at zero; N is the cumulative count of children that ever ran). Child events are excluded from parent surfaces they would corrupt: a child's `todo_write` never replaces the parent's Task List section, a child's `Write` never promotes a plan file path, and a child's tool result never falls through to a standalone chat message when the compact writer rejects it.

## Alternatives considered

**Count running subagents from open `subagent` tool calls.** Rejected: background delegations return their tool result immediately (the runtime notice arrives later), so open-call counting undercounts by design; the per-child count tracks actual activity for both foreground and background children.

**Project child assistant text and thinking too.** Rejected: the card is a tool-progress surface; a child's prose would interleave with the parent's 实时播报 section and overwhelm the ring buffer.

**Extend the structured card payload (`ProgressCardPayload`) with a subagent count field.** Rejected for now: this deployment renders the streaming-preview card; the structured `card` style would need its own count plumbing. The structured path gets the label only (entry `tool: 'subagent'`), a no-schema-change courtesy.

**Count running children via turn-edge add/remove with a `session/disposed` leak guard.** Rejected: the cumulative count needs no teardown at all — the set only grows, so a child that dies mid-turn without a `turn/end` cannot leak or under-count.

## Consequences

The card now shows child activity during delegation. Grandchild tool calls display identically to child calls — no depth indicator. The count is per bridge session and cumulative across the whole session lifetime, so a long-lived chat's number reflects every subagent it ever spawned, not concurrency; buffered child events arriving between turns are discarded at the next turn's channel drain, so the count catches up on the next `subagent_status` emission. `subagent_status` and `fromSubagent` are engine-internal event vocabulary (`EventKind`/`Event` in `src/core/types.ts`), not a wire or durable format: nothing crosses a process boundary.

## Testing

`tests/agent-dsh/adapter-subagent.spec.ts` (7 cases): direct-child projection with namespaced ids, cumulative count emission (first turn edge only; duplicates and later turns add nothing) with non-tool events filtered, distinct-child counting plus grandchild chain attribution, and drop paths for no-lineage, broken-chain, and depth-capped sessions. `tests/engine/engine-subagent-card.spec.ts` (4 cases): the `⚙️ subagent` label with real tool name in the body, per-entry result backfill, parent todo-section preservation against a child rewrite, and standalone-message suppression for child results while parent results still deliver. `tests/streaming.spec.ts` adds entry-label rendering and the show/hide behavior of the count line (unchanged counts skip the flush). Real-device smoke follows the MIGRATION.md reload flow.
