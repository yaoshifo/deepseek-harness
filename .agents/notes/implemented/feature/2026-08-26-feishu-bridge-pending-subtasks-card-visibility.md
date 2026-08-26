# Agent Note: Settled cards state how many native subtasks still run

Status: implemented

English | [中文](2026-08-26-feishu-bridge-pending-subtasks-card-visibility.zh.md)

## Problem

After a parent agent dispatches work with `feishu_bridge_subtask` (native continuable children), `spawn` returns immediately, the parent turn settles, and the progress card greens to 执行完成 while the children keep running — under `features.subtaskQuiet` their settlement cards are suppressed too. Between dispatch and the first child report (6.5 minutes in the 2026-08-26 oc_b46da516 review batch) nothing on any card says the work is still in flight. The pre-native `subagent` tool never had this gap: its synchronous `Task` call held the parent turn open, so the card stayed 执行中 and streamed the child's tool calls.

## Decision

Keep the header terminal — it reports the parent turn's lifecycle, and that turn genuinely finished — but carry the unreported-children count on three surfaces, recomputed from the persisted `native_children` records (`parent_key` match, `reported: false`) at each render point:

- The settled card title appends `· N 个子任务运行中` via `ProgressStatus.pendingSubtasks` (`progressTitleAndColor`); the body shows the `subtasks_running_hint` line through the existing `bgTaskHint` terminal rendering.
- A live spawning turn shows the hint beside the stop button immediately (`spawnSubtaskNative` fires `setBackgroundHint`).
- The ✅ completion push appends the same hint line (`sendTurnCompletionCard`), because that push is the phone-glance done signal.

`interruptNativeChild` now marks the record `reported: true`: an interrupted child never reports, and the count must not overstate forever.

## Alternatives considered

- **Flip the settled header back to 执行中 while children run.** Rejected: the header drives turn-lifecycle affordances (spinner, stop button, ✅ push already fired), the parent turn is genuinely idle, and a concurrent new turn would render a second honest 执行中 card the lie cannot be told apart from. Mechanically it also needs a post-`completeAndDetach` PATCH channel — new lifecycle machinery for a misleading signal.
- **Feed the count into `backgroundTasksPending`.** Rejected: that counter's decrement assumes one wake per counted task (`handleTurnEnd` consumes one slot per background turn), while gather banks N reports into one wake — the count would drift and mislead the unsolicited reader's grace and the idle reaper. This count is display-only.
- **A live per-child panel PATCHed on every child event.** Deferred: needs the post-freeze PATCH channel above. The count self-corrects on every child-driven wake (each native report or gather timeout opens a new parent turn whose card recomputes), so the stale window ends at the first child report.

## Consequences

- The count freezes on the settled card between wakes: a fast child that reports before the card settles never appears (the recount sees `reported: true`), and children finishing mid-gather stay counted until the gather wake's card. Worst case the number overstates until the next parent turn.
- Terminal statuses now route through `progressStatusLocked()` in `finish()` and `completeAndDetach()` too, so text-only turns (no tool calls) carry `pendingSubtasks` as well; `toolCallSeq` on those cards changes from a hardcoded 0 to the preview's counter (0 there — no behavior change).
- Pinned by `tests/feishu/card.spec.ts` (title format), `tests/streaming.spec.ts` (status field, dedup flush), `tests/engine/engine-subtask.spec.ts` (settlement recount, zero path, interrupt settle), and a REAL-composition case in `tests/engine/native-subtask-assembly.spec.ts` (parent turn settling while a hung child runs).
