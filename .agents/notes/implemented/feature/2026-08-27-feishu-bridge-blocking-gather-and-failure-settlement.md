# Agent Note: Blocking gather and failure-marked subtask settlements

Status: implemented

English | [中文](2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.zh.md)

## Problem

After B4, `feishu_bridge_subtask` spawn is non-blocking with no Feishu group: the parent turn settles right after dispatch, and between dispatch and the first child report nothing on any card says the work is in flight beyond the static count (the 2026-08-26 note's stopgap). The pre-native `subagent` tool never had this gap — its synchronous call held the parent turn open, streaming child tool calls onto the live card — and its run-settlement mapped every failure mode onto a structured tool result. The bridge path had the inverse gaps: the `subagent/end` listener dropped `stopReason` entirely (a max-tokens child reported its truncated text as if it had finished), a failure with no assistant output was swallowed by the `no result to report` throw, and `reportSubtaskTimeout` had no production caller, so a lost group child left its parent waiting forever.

## Decision

Keep one delegation surface and add the synchronous contract to it. `gather` now blocks: `gatherSubtasksBlocking` arms the same barrier, registers a per-session waiter, and resolves with the combined summary so it lands as the gather tool call's own result in the still-open parent turn — child activity streams on the live card (`fromSubagent` events), the idle timer stays disarmed by the in-flight tool call, and an aborted signal (user stop, teardown) drops the waiter and leaves the barrier armed for the per-report wake. Per-child settlement cards are skipped while a waiter is armed; the summary is the delivery. Settlement text composes the terminal outcome: non-completed stop reasons prefix failure semantics (error / max-tokens / refusal / aborted, plus the provider diagnostic and a no-closing-output notice when the epoch left none), an output-less completion settles with a notice instead of the swallowed throw, and `SubagentRunEndInfo` carries `diagnostic` from the one-shot result. Group-path children get matching notices: error-reasoned turns auto-report with the failure and their own partial streamed text (never a stale earlier reply), mid-turn process exits report partial output with an interruption prefix, and the stall-kill / hard-cap / dead-agent-send / channel-closed paths deliver the synthetic timeout notice (suppressed once the user took the child over).

## Alternatives considered

- **Re-enable the native `subagent` tool (one-shot).** Rejected as the default: it restores the blocking experience with zero engine code, but re-opens a second delegation surface whose overlap the model must arbitrate (worktree and cross-project routing live only on the bridge tool), and its children lack worktree isolation — a repo-writing parallel task dispatched to it collides in the parent tree. Remains the documented fallback: the live profile's `tool-subagent` disable flipped to a `backgroundMode: 'one-shot'` override.
- **A live per-child panel card PATCHed after the parent turn settles.** Still deferred (see [2026-08-26](2026-08-26-feishu-bridge-pending-subtasks-card-visibility.md)): it needs the post-`completeAndDetach` PATCH channel, while the blocking gather restores the same observability through the ordinary live card with no new lifecycle machinery.
- **Feed native children into `backgroundTasksPending` for unsolicited-reader keep-alive.** Rejected (unchanged from the 2026-08-26 note): the counter's one-wake-per-task decrement drifts against gather's N-to-1 banking.

## Consequences

- The typical dispatch flow (spawn N → gather → synthesize) completes in one model request: results arrive as tool results with no wake round-trips, failure information included.
- The waiting parent turn is occupied up to the gather timeout (default 20 minutes, well under the 60-minute hard turn cap); the escape is not calling gather, which keeps the per-report incremental wake.
- The blocking wait is in-memory: a mid-wait restart loses the waiter, and later reports fall back to per-report wakes.
- `subtask_settlement_*` i18n keys own the failure vocabulary; `buildProjectAssembly` engines auto-detect language, so tests pin en wording at the engine level and one REAL case pins the composed chain.

Pinned by `tests/engine/engine-subtask.spec.ts` (blocking gather three states, settlement vocabulary, group-path failure prefixes, timeout-notice guard), `tests/tools/subtask-tool.spec.ts` (routing), and two REAL-composition cases in `tests/engine/native-subtask-assembly.spec.ts` (in-turn resolution with no wake turn; max-tokens failure semantics end to end).
