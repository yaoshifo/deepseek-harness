# Agent Note: `/done` interrupts a still-running chatroom

Status: implemented

English | [中文](2026-09-04-done-interrupts-live-chatroom.zh.md)

## Problem

`/done` in a chatroom hub that the moderator never `end`ed left the room's feature state behind while tearing down its sessions: `cmdDone` (`dsh-feishu-bridge` `src/engine/commands.ts`) stops agent sessions and handles worktrees, but nothing calls `finalizeChatroomEnd` — the only place that drops the hub's `chatroomModerator` flag and the roles' `chatroomHubKey` bindings. The residue: the hub's next message starts a turn with the moderator persona over a torn-down room (`chatroom-policy.ts` `decorateSessionStartOptions`), an armed gather stays armed and its timer later wakes that phantom moderator into asking dead roles, and the ledger never records an end line (unfinished forever). This is exactly the abandoned-room deadlock class `interruptChatroom` was built to solve (`/chatroom stop`), reachable through one more user command. Found while answering a production question (2026-09-04, oc_39a120a7900266692ebd685d84cce027) — that room had been ended properly first, so the seam was latent, not hit.

## Decision

The bridge dispatches a new `feishuBridge/pre-done` waterfall at `cmdDone` entry (after `--reply` handling and the Done reaction, before the subtree teardown) with payload `{ engine, sessionKey, handled: string[] }`. Feature plugins owning state under the subtree clean it there; every descendant key a listener pushes into `handled` is skipped by the bridge's own descendant loop (the root chat always stays the bridge's to clean, and the recursive summary counts only what the bridge itself cleaned). The event rides the existing `feishuBridge/*` declaration-merged `Events` interface, so the dependency direction holds: the chatroom plugin imports the bridge's export face, never the reverse.

The chatroom half is one policy listener: when the `/done`d session carries `chatroomModerator` (set at start, cleared only by `finalizeChatroomEnd`, persisted — true means not finalized, which covers armed gathers, end barriers, and pending human questions alike), it calls `interruptChatroom` and pushes the returned `cleanedKeys` into `handled`. `finalizeChatroomEnd` now returns the cleaned session keys instead of a count (callers derive `.length`), making the classification walk the single source of truth for what `/done` must skip — the bridge's loop therefore does not re-run `cleanupOneChat` on role groups (no double worktree pass, no duplicate dirty summaries). An interrupt failure (no spawn-capable platform) is caught, warned, and left unhandled: the plain teardown proceeds, degrading to the old behavior instead of an unhandled rejection in the fire-and-forget command path. An ended hub (flag down) falls through untouched — plain `/done` semantics, byte for byte.

`/done` inside a role/assistant group keeps its current semantics (the room-level escape stays `/chatroom stop`, valid from any member group), and direct-role 1:1 chats are not hubs — both out of scope by design.

## Alternatives considered

- **Detect the live chatroom inside `cmdDone`.** Rejected: `chatroomModerator` lives in the chatroom plugin's opaque `featureState` section; the bridge reading it would break the package seam (`session.ts` keeps the section opaque to the bridge by design).
- **Skip the chatroom plugin's cleanup and let `/done`'s loop do it all.** Rejected: the barriers need `interruptChatroom`'s consumption (timers, no wake), and without the skip list the bridge re-runs `cleanupOneChat` on role groups concurrently with `finalizeChatroomEnd`'s fire-and-forget calls — double worktree passes and duplicate dirty summaries.
- **Lazy cleanup on the hub's next message (flags detected at turn start).** Rejected: heuristic (must guess liveness from role sessions), leaves the armed gather timer live until it fires, and the ledger stays unfinished.

## Testing

`dsh-feishu-bridge` `tests/engine/done-prehook.spec.ts`: the dispatch payload contract, the handled-key skip (a claimed child gets no done mark or phase paint; the rest and the root clean as before), and the no-listener regression (bare fallback — every descendant cleaned, summary unchanged). `dsh-feishu-bridge-chatroom` `tests/engine/engine-chatroom-done.spec.ts`: `/done` on an armed two-role hub via `dispatchCommand` with the real policy listeners (`chatroomPolicyFace`) — moderator flag down, gather consumed, no wake, interrupt card posted, ledger interrupted line written, each role's cleanup ran exactly once (the skip observably prevented a second pass) — and the ended-hub fall-through. Loader-level composition coverage stays with the existing `loader-composition.spec.ts` boot (both plugins mounted). No snapshot update: nothing model-visible changed; the user-visible delta (interrupt card instead of silence-plus-residue) is covered by the specs.

## Consequences

The cost: `/done` on a live chatroom hub is no longer a pure bridge operation — its user-visible outcome now depends on whether the chatroom plugin is mounted (it always is in this profile, but a bare bridge assembly gets the old residue behavior), and `finalizeChatroomEnd`'s return type changed from a count to the cleaned keys, touching every caller. What it bought: `/done`, `end`, and `/chatroom stop` now converge on one teardown path, so no user command can leave a room as persona flags and armed barriers over a dead subtree; the ledger always reaches a terminal line; and the `feishuBridge/pre-done` seam is a generic feature-teardown hook — the next sibling plugin owning subtree state (monitor, relay) can claim its cleanup the same way without another bridge change.
