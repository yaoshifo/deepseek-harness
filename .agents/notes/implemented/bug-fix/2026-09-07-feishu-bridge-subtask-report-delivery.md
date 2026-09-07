# Agent Note: Subtask report delivery — the card is best-effort, the wake owns the one-shot flag

Status: implemented

English | [中文](2026-09-07-feishu-bridge-subtask-report-delivery.zh.md)

## Problem

The native-subtask report path — `settleNativeChild` → `reportNativeChild` → `replyNativeToParent` / `replyToParent` → `deliverParentReply` → `deliverMachineMessage` — must uphold one invariant: either the parent is woken, or the child stays re-deliverable. Two gaps broke it. First, `deliverParentReply` awaited `sendAsCard` on a fire-and-forget chain with no `.catch`: any rejection there (card builder throw, or a wake-path throw such as a busy parent's `steer` failing) surfaced as an unhandled rejection and skipped everything after the `await` — including `deliverMachineMessage`, the actual wake. Second, the initiation (`replyNativeToParent` returning true) had already flipped the child's one-shot `reported` flag before the async delivery ran, and nothing rolled it back on failure: the report read as delivered while the parent was never woken, and neither a later settle nor restart recovery (which skips `reported` children) could re-deliver. Same family as the 2026-09-06 wake-chain freeze: a lost wake that the records say was delivered.

## Decision

- **The card is best-effort** (`deliverParentReply`): the `sendAsCard` await is wrapped in try/catch, logging and continuing — the card is the human-facing UI, the wake below is the essential delivery.
- **Only a failed wake rolls the one-shot flag back**: both initiation sites catch `deliverParentReply`'s escape — `replyNativeToParent` resets the native child's `reported` record; `replyToParent` resets the group child's `subtaskReported` and persists. A lost wake therefore stays re-deliverable by settle, follow-up, or restart recovery. Reconstruct failures already had this rollback; the delivery half now matches.
- **Chain-local audit**: the one remaining bare void async call on this path (the monitor-mode done reaction) gets a logging `.catch`. Nothing outside the report chain was touched.

## Alternatives considered

- **Roll back inside `deliverParentReply`.** It cannot: the flag lives in two different stores (project-state record vs. session record) chosen by the caller, and the function deliberately receives only keys and labels.
- **Make `sendAsCard` itself never reject.** Treats the symptom only; a wake-path failure would still strand the `reported` flag.
- **A retry queue for failed wakes.** The recovery paths already exist (settle re-arm, restart recovery); they only need the flag to tell the truth.

## Consequences

- Tests pin: a rejected card send still wakes the parent (`[子任务完成]` lands); a wake-path failure (busy parent, throwing steer) rolls `reported` back and an explicit re-report delivers; the group path rolls `subtaskReported` back the same way.
- A card send that hangs rather than rejecting is out of scope here: the retry machinery's per-attempt deadline eventually rejects it into the same catch.
- The stall-override log (`stall check overridden: … blind pump`) now carries the session key, so triage no longer diffs tail timestamps across every session; pure observability, no behavior change.
