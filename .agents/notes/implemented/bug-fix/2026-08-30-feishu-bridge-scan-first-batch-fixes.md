# Agent Note: feishu-bridge × chatroom parallel scan — first batch of high-severity fixes

Status: implemented

English | [中文](2026-08-30-feishu-bridge-scan-first-batch-fixes.zh.md)

## Problem

A five-track parallel read-only scan of `packages/acp/feishu-bridge` (46.7k lines) and `packages/acp/feishu-bridge-chatroom` (5.1k lines) — engine core, Feishu platform layer, plugin wiring, the chatroom package, and cross-cutting hygiene — produced 41 findings. Eight were verified line-by-line as high-severity bugs and fixed in this batch; the rest are recorded below as a backlog. The unifying patterns: Go→JS porting gaps where Go's runtime model covered for free (microtask semantics, cancellation), single-project-era residue in a now-multi-project deployment (the approval waterfall), and extraction seams from the chatroom repackaging (the persona workdir key).

Each fix was driven test-first; every failing test reproduced the bug for the right reason before the fix landed.

## Decision

**A1 — debounce microtask spin (engine.ts:4117).** `Promise.race([plainSleep(...), Promise.resolve()])` always resolved via the pre-settled branch, degrading the merge loop into a microtask spin that starved every timer and I/O callback in the process for the whole 600ms default window — every queued-message drain froze all sessions' streaming PATCHes, cron ticks, and WS receives. Measured: 174k iterations per 100ms window; a 5ms timer could not fire inside it. Fix: poll-sleep directly (`await plainSleep(Math.min(remaining, 10))`), the semantics the Go original had.

**A2 — approval/request waterfall veto (adapter.ts:786).** When the session was unknown, the listener returned `'unavailable'` without calling `next()` — in cordis waterfall semantics that vetoes every later listener including the fail-closed base. Multi-project deployments share one plugin ctx, so the first adapter's registration silently denied every other project's approval cards. Same collision class as the 2026-08-22 userQuestions incident, whose fix (`return next()`) this mirrors. A bare call without `next` (tests) still fails closed via `next?.() ?? 'unavailable'`.

**A3 — card-button callback bypassed allow_from (platform.ts:975).** `onCardAction` gated only on `allowChat`; `onMessage` gates on both. A user excluded by `allow_from` could press `perm:allow` / stop / export buttons in an allowed chat. Fix: the same operator gate as the message path (empty allow_from still permits everyone).

**A4 — gather cap rejection left an orphan barrier (chatroom.ts:709).** The research-round cap check ran after the barrier was installed and persisted: a rejected round left a barrier with no timer and no broadcast that never completes, and `end` refuses to run while `pendingGather` is set. Fix: the cap check now runs before any state is installed; a rejected round consumes neither the seq nor the round counter.

**B1 — chatroom personas never entered the system prompt (chatroom-policy.ts:182, 200).** The persona prompt resolved the workdir with `engine.sessionWorkDir(session.id)` — the internal `s${n}` registry id — while `startChatroom` persists the role's persona dir under the interactive session key. The lookup always missed, fell back to the agent base dir, and (persona sessions replacing the whole system prompt with `complete: true` plus cwd-instruction suppression) every role lost its CLAUDE.md persona, all roles sharing the base dir's file instead. The 08e1428c75 refactor introduced this while claiming "zero behavior change"; every existing test bypassed the resolution chain. Fix: resolve through `options.sessionKey` (same key and transform as the writer, timing-independent direct override-map read), plus an end-to-end test asserting the persona text comes from the role directory.

**B2 — interrupted ask re-parked by the late deliverCards continuation (engine.ts:5000).** The park write sits after the first network await in `deliverCards`; the interrupt branch's cleanup guard (`pendingAsk === pending`) is a no-op until that write happens. A stop landing in the delivery window let the in-flight continuation re-park the cancelled ask — every later message routed into the dead permission request and was swallowed, the idle reaper skipped the session, and the card froze. Fix: an `askInterrupted` flag set by the interrupt branch before cleanup; the continuation bails before parking.

**B3 — full async-sender queue dropped terminal PATCHes (async-sender.ts:87).** `markCompleted` / `markFailed` / `markStopped` rode plain `enqueue`, whose full-queue behavior is a silent drop: the card froze in running color and the answer delivery inside the same closure never ran (a single blackholed PATCH can pin the queue for ~124s). Fix: new `enqueueTerminal` — a full queue warns and enqueues beyond the cap instead of dropping; terminals are at most one per turn, so overflow is bounded. The three terminal call sites switched to it. The companion defect on the text path: `flushLocked` optimistically records `lastSentText` before the queued coalescable PATCH runs, and on a queue-full drop the closure never executes so its failure rewind never fires — `finish()` then saw `finalText === lastSentText` and returned "delivered" without sending the card's final content. `enqueueCoalescable` now returns whether the snapshot was queued, and `flushLocked` rewinds the optimistic claim (text and via-update flag) when it was dropped.

**B4 — stale ask-human flag swallowed user messages (chatroom.ts:953).** Only `routePendingHumanReply` cleared `pendingHumanQuestionRole`; `finalizeChatroomEnd` and `interruptChatroom` did not, and the flag is durable across `/new`. After a chatroom was torn down with a question pending, the hub's next normal message was routed into a dead `askRole` that only warned, and the engine consumed it. Fix: `finalizeChatroomEnd` clears the flag (interrupt lands there too), and the router pre-validates that the role session still lives — a stale flag falls through to the normal agent path (`false`) instead of eating the message.

## Alternatives considered

**Fix everything the scan found in one pass.** Rejected: the remaining 33 findings split cleanly into performance/memory (LRU bounds for per-messageID and exportKey maps, tenant-token caching, appendThinking throttling), robustness (cron timeout cancellation, modeOverride fail-loud, retry classification, parsePicks validation), and hygiene (i18n hard-coded copy, ghost dependency declarations, dead exports) — different risk profiles and review surfaces; batching them with the bug fixes would bury the latter. They stay a recorded backlog.

**Guard B2 by settling deliverCards before cleanup instead of a flag.** Rejected: the interrupt branch must stay prompt (it settles the caller), and waiting on a possibly-hung platform send would reintroduce the oc_29bb dispose-hang class the file's own comments guard against.

**B3 via `enqueueOrInline`.** The inline path re-enters the StreamPreview lock (markStopped's fallback calls `this.locked`) and would execute the terminal ahead of queued stale snapshots, letting them overwrite the terminal card. Queue-overflow keeps ordering and the lock discipline.

## Consequences

Multi-project approvals, card-button authorization, and chatroom personas work as documented. Every queued-message drain yields to the event loop (no more 600ms process-wide freezes). Interrupted asks can no longer blackhole a session's messages. Terminal PATCHes survive queue saturation. Rejected research rounds and torn-down chatrooms leave no trap state behind.

A second batch closed the side-effect-free backlog items: tenant-access-token caching at both minting sites (expiry-gated by the server-declared `expire`), parsePicks schema validation at the model-JSON trust boundary, the adapter's dead-session unregistering (dispose hook fired from close/markDisposed — the leak behind /list zombie rows), locale-owned copy for the /context card plus the stray engine/chatroom strings (29+3 new en+zh keys; the six-bucket chart labels stay verbatim from dsh-context's zh-only i18n by documented alignment), the enqueueOrInline rejection guard, the invariant companion spec, four dead exports with their orphaned interfaces, and the cosmokit/dsh-system-prompt dependency-section corrections.

Still open (policy or semantics decisions, deliberately not taken unilaterally): per-messageID cache growth in platform.ts and exportKey map growth in InteractiveState (bounded retention trades away old cards' export buttons), cron turn non-cancellation on timeout and the same-job overlap guard, modeOverride silent drop on live-state reuse, HTTP 5xx non-retry plus the per-project token bucket, and the EventKind switch exhaustiveness sweep.

## Testing

- `tests/engine/engine-debounce.spec.ts` (new): a 5ms timer fires inside the debounce window; a message queued inside the window merges into the lead turn. Both failed against the spin (301ms starvation; no merge).
- `tests/agent-dsh/adapter.spec.ts`: a session owned by a later adapter delegates down the waterfall (delegateB receives the ask) instead of the first listener failing the chain closed.
- `tests/feishu/card-action.spec.ts`: an operator excluded by `allow_from` cannot trigger card buttons in an allowed chat; a listed operator can.
- `tests/engine/engine-chatroom-gather.spec.ts`: a cap-rejected round installs no barrier and consumes neither seq nor counter.
- `tests/engine/engine-chatroom.spec.ts`: the role persona prompt resolves the role directory through the session key (contains the role's `# CLAUDE.md` heading).
- `tests/engine/engine-ask-interrupt.spec.ts`: a delivery interrupted before the park write never re-parks the cancelled ask when the platform send later resumes.
- `tests/streaming.spec.ts`: markCompleted still delivers the terminal PATCH when the queue is full.
- `tests/async-sender.spec.ts`: enqueueTerminal never drops — the terminal runs once the backlog drains.
- `tests/engine/engine-chatroom-end.spec.ts`: finalizeChatroomEnd clears a stale ask-human flag; a stale flag routes the next message back to the agent (`false`).

Full suites: feishu-bridge 2,560 tests and feishu-bridge-chatroom 219 tests green; both compiler faces (`tsc -b tsconfig.host.json`, `tsconfig.client.json`) and the workspace tsdown build pass, with all eight fixes grep-verified in the built bundles.
