# Agent Note: Unattended bridge subtasks ride the native continuable seam

Status: implemented

English | [中文](2026-08-24-feishu-bridge-native-unattended-subtasks.zh.md)

## Problem

The `feishu_bridge_subtask` tool's spawns were the last Go-shaped machinery without a native counterpart: every dispatch — attended or not — created a real Feishu group, a bridge-side session, and the engine's own parent/child registry, depth counters, report routing, and worktree bookkeeping. Unattended children (no group member will ever look at them) paid the group's whole surface for nothing, and the bridge duplicated lineage/depth/resume machinery the native `SubagentRuntime` already owns durably.

The blocker had been that the native runtime (a) ignored `cwd` on `startContinuable` and (b) always woke the parent itself — a wake the bridge's engine never scheduled and cannot render. Both were closed by the [continuable bridge seam note](2026-08-24-subagent-continuable-bridge-seam.md): cwd now validates and persists on the continuable path, and `settlementNotice: 'external'` suppresses the runtime's own delivery.

## Decision

The bridge mounts `SubagentRuntime` itself (`settlementNotice: 'external'`) plus the in-process spawn/fork providers, so profiles need no subagent entries. The tool's `spawn` action delegates through a new structural adapter capability (`asContinuableDelegator`: `startContinuableChild` / `followupChild` / `interruptChild` / `reportChildToNativeParent`); the engine keeps only what the native seam cannot express:

- **Parentage records** (`native_children` in the project state, surviving restarts): child id → parent session key, parent's native id, label, worktree coordinates, reported flag. Worktree creation stays bridge-side (git conventions are deployment policy per the cwd-override decision).
- **Settlement fallback**: a `subagent/end` listener delivers each epoch's final assistant output through the group path's exact card + `[子任务完成]` wake machine — `deliverParentReply` was refactored to take (parentKey, childKey, label) so group children and native children share one delivery path. Explicit reports idempotently skip; a follow-up re-arms. Since [the quiet-settlement note](2026-08-25-feishu-bridge-subtask-quiet-settlement.md), `features.subtaskQuiet` suppresses the card half for native children while the wake always delivers.
- **Gather barrier**: `gatherSubtasks` folds unreported native children into the same in-memory barrier; their reports bank through the shared delivery path's accumulate.
- **Send queues** (`ctx.subagents.followup`) instead of Go's busy-reject — the deliberate deviation, recorded in the tool's model-facing wording.
- **Interrupt**: a new tool action routing to the native interrupt under the live parent's authority.
- **Teardown**: `/done` and chatroom end drain native descendants (interrupt, clean-worktree recycle, record cleanup) — worktree handling mirrors the group path's dirty-keep semantics.

A native child whose parent is itself native reports through the runtime's `reportFrom` (one wake per report, native inbox semantics); the gather barrier is not offered there — the tool answers honestly instead of arming nothing.

## Alternatives considered

- **Migrate all spawns to native.** Rejected: attended groups (`/spawn`, monitor children, chatroom pre-spawned assistants) are user-visible surfaces the native seam deliberately does not model (the D1 rationale); they keep the group path.
- **Let the native runtime wake the parent and teach the engine to render spontaneous turns.** Rejected: the engine's event loop drains only inside its own turns; absorbing foreign wakes means a second turn scheduler with re-entrancy hazards. `external` settlement keeps one scheduler.
- **Keep bridge-side lineage for native children too.** Rejected: durable lineage/depth/resume is exactly what the native seam owns; duplicating it re-creates the de-baggage target.
- **A `native_children` entry per bridge Session instead of the project state.** Rejected: native children have no bridge session; the project state is the engine's existing durable side-channel and survives restarts without a new file.

## Consequences

- The unattended tool path no longer creates Feishu groups; the skill and tool wording state the new contract (send queues, interrupt exists, observation goes through `/spawn`).
- Native children omit the agent-conventions persona section (like group subtask children): its closing ask_user_question findings card addresses a user chat an unattended child does not have.
- A profile that also loads `dsh-subagent` collides on the `subagents` service name — documented in the README; the bridge owns the service in its own composition.
- Native grandchildren (native child of a native child) work: spawn chains natively, reports ride `reportFrom`, teardown drains transitively through native records.
- REAL-composition coverage (`native-subtask-assembly.spec.ts`) boots the real stack (AgentLoop, jsonl persistence, SubagentRuntime external, buildProjectAssembly) with only the LLM scripted and the platform stubbed, running spawn → child turn → settlement → card + parent wake end to end; real-machine smoke (unattended dispatch + gather + report on the live bot) stays with the user.
