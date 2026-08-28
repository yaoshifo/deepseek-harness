# Agent Note: feishu-bridge round-4 subtask fixes — barrier death accounting, native recursion, epoch re-arm

Status: implemented

English | [中文](2026-08-28-feishu-bridge-subtask-round4.zh.md)

## Problem

The 2026-08-28 round-4 review of the feishu_bridge_subtask replacement (three parallel read-only review subtasks plus one live reproduction child) verified four engine defects and two composition gaps:

1. An interrupted child starved an armed gather barrier: `interruptNativeChild` flipped the record to reported but never removed the child from `pendingSubtaskGather.expected`, and `settleNativeChild`'s reported guard then skipped the `subagent/end` settlement — so the background panel's Stop-all button and the `/done` drain left a blocking gather ([the synchronous delivery contract](../feature/2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.md)) holding the parent turn open to its 20-minute timeout, naming stopped children as missing while the panel showed all-done. The native `interrupt_agent` tool settled correctly because it never touches the engine record — the asymmetry sat in the bridge's own interrupt surface.
2. A native child spawning its own child always failed: the parent anchor `liveNativeSessionID` consults only engine chat sessions, so the recursion the child persona advertises threw "no live agent session" — after `getOrCreateActive` had already minted and persisted a phantom bridge session under the native id (reproduced live: a failed recursive spawn left the child id in `sessions.json`'s `activeSession` and `userSessions` maps). The B4 note's "Native grandchildren work" claim ([native unattended subtasks](../feature/2026-08-24-feishu-bridge-native-unattended-subtasks.md)) was aspirational.
3. A follow-up delivered through the runtime's own send_message tool was answered into a void: the engine re-arms its settlement fallback only on its own send path, so the follow-up epoch's `subagent/end` hit the already-reported guard and dropped the answer.
4. A failed group-path spawn leaked the worktree it reserved, and the shared predicate `worktreeMergedLossless` counted a pristine zero-commit worktree as "not lossless" — so even the native path's no-leak cleanup never actually removed one.

Composition gaps: the repo bundle patch never disabled the generic `subagent`/`subagent_fork` tools (the runtime belongs to `dsh-base` per [the duplicate-provider note](2026-08-24-feishu-bridge-subagent-mount-duplicate-provider.md)) (the disable lived only in the live deployment profile), so a repo composition exposed them with a settlement channel the engine cannot close — not in `native_children`, report tool disabled, `settlementNotice: external`: results silently lost. And `subtask.timeoutSec` was a dead knob since its M4 port (config field → setter → engine field, no reader anywhere).

## Decision

- **Barrier death accounting:** `accountBarrierDeath` accumulates the aborted settlement text into the parent's armed barrier — resolving the blocking waiter once the expected set completes — from both `interruptNativeChild` and `drainNativeDescendants`. Without an armed barrier nothing is delivered, so `/done` teardown stays silent.
- **Native recursion:** a native caller anchors delegation on its own session id (the adapter's `ctx.agents.get` lookup fails loud when the child is not live), mints no engine session, and resolves its dir='' child's inheritance base through the new optional `ContinuableDelegator.childCwd` probe, so worktree auto-mode compares real repository roots. Grandchild records chain through `parent_key` and settle through `reportChildToNativeParent`.
- **Epoch re-arm:** the settlement listener now also listens to `subagent/start` and re-arms owned children, so every epoch that starts — whatever channel delivered its follow-up — settles its own closing output. The bridge's own send re-arm becomes a no-op there, and it now happens only after the delivery lands, so a failed send no longer strands an unreported ghost record.
- **Single-entry backfill:** the bundle patch disables `tool-subagent`/`tool-subagent-fork` with the single-entry rationale; the control tools stay mounted (send_message is now safe through the re-arm).
- **Worktree:** `worktreeMergedLossless` treats "no commits beyond base" as lossless (the uncommitted guard still keeps dirty trees), and both group-path failure sites (fork-source unreachable, spawnGroup error) recycle the reserved worktree.
- **Dead knob:** `subtask.timeoutSec` is deleted outright — pre-release, no compat shim; subtask idle stays governed by `eventIdleTimeout`.
- **Model-facing contract:** the tool description now states what the code does — cross-directory forks work, send queues native children only (attended group children busy-reject), the "assistant" literal is send-only (interrupt addresses native child ids; chatroom assistants are group-path).

## Alternatives considered

- **Settle interrupted children through the full settlement path (card + wake).** Rejected: Stop-all would post N aborted cards and wakes per press; the armed barrier is the only consumer that needs the accounting.
- **Deny send_message in the bridge composition** instead of re-arming on start. Rejected: the control tools serve the runtime-wide agent surface; the re-arm restores correct semantics for every delivery channel at once.
- **Enforce the fork cross-directory prohibition in the engine.** Rejected: the capability works (the fork provider carries `cwdOverride`), the bundled skill already documents cross-directory forks as available, and the description was the odd one out.
- **Wire subtask.timeoutSec into a per-child hard timeout.** Rejected: no current consumer; the knob never worked in TS, and deletion matches the pre-release no-shim stance.

## Consequences

- Recursive native delegation works to the depth cap; the runtime owns depth enforcement, so no bridge-side counter exists.
- `/done` semantics are unchanged for genuinely dirty worktrees; pristine worktrees are now auto-removed, which the README's "uncommitted changes and unmerged commits always keep the worktree" always implied (a fresh worktree has neither).
- Two narrow races remain open and untouched: the native-parent report's post-await reported flip (an interrupt landing inside the report's delivery window can double-deliver), and a `reconstructReplyCtx` rejection consuming the one-shot reported flag (that report is permanently lost).
- The live deployment profile still carries its own tool-subagent disable rows (now redundant with the bundle patch) and its stale silent-loss comment; both should be dropped at the next reload.

## Testing

`tests/engine/engine-subtask.spec.ts` (barrier death accounting ×4, native-caller spawn ×3, failed-send re-arm, group worktree recycle), `tests/engine/done-worktree-merged.spec.ts` (pristine-lossless predicate), `tests/engine/subtask-panel.spec.ts` (posting re-entry guard), `tests/tools/subtask-tool.spec.ts` (contract wording pins), `tests/engine/native-subtask-assembly.spec.ts` (REAL composition, unchanged and still green). Package suites feishu-bridge + chatroom: 2546 passing; the three snapshot-suite failures pre-exist on the clean tree (sandbox environment, verified by baseline re-run).
