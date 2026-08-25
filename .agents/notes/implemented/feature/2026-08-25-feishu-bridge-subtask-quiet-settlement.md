# Agent Note: Unattended subtask settlements are cardless under features.subtaskQuiet

Status: implemented

English | [中文](2026-08-25-feishu-bridge-subtask-quiet-settlement.zh.md)

## Problem

Every unattended native subtask settlement posted a `[子任务完成]` card into the parent Feishu group unconditionally — `deliverParentReply`'s `sendAsCard` had no gate. A parallel batch of N children therefore cost N cards nobody asked for: the user delegating through `feishu_bridge_subtask` wants the synthesized result, not per-child visibility, and the generic `subagent` tool's silent return is the reference semantics. `features.quiet` only gates thinking/tool progress display; it cannot express this.

## Decision

`features.subtaskQuiet: true` (per project) suppresses the settlement card for unattended native subtask reports. `deliverParentReply` takes a `silentCard` flag: the native callers (`replyNativeToParent`, serving both explicit reports and the `subagent/end` fallback) pass the engine flag; the attended group-path caller (`replyToParent`) always passes `false`. The parent-agent wake — the synthetic `[子任务完成]` message and gather banking — is always delivered; only the user-visible card is suppressed. Attended group children (`/spawn` groups), monitor chats, and the group path keep their cards regardless: those surfaces exist to be watched.

## Alternatives considered

- **Condense gather batches into one summary card.** Rejected: the user asked for silence, not condensation, and per-child cards would still post without gather.
- **A one-line notice instead of the full card.** Rejected: still a per-child message, and the wake already carries the full result into the parent context where the synthesized reply lands.
- **Make quiet the default.** Rejected: carded settlements remain the observable contract of the Go port; quiet is an opt-in matching the deployment's preference.

## Consequences

- The user loses the card's visual diff summary for native settlements; the footprint still reaches the agent through the report content and `subtaskDiffElements` on the parent's own completion card. `/spawn` observation remains the visibility escape hatch.
- The switch wires in `buildProjectAssembly` beside the other feature flags (`tests/assembly-config.spec.ts` covers it); engine behavior is pinned by the quiet cases in `tests/engine/engine-subtask.spec.ts` and a REAL-composition case in `tests/engine/native-subtask-assembly.spec.ts`.
- The Mac deployment profile disables the generic `tool-subagent` rows in its own patch at the same time, leaving `feishu_bridge_subtask` the only delegation door there — a deployment choice recorded in the profile, not a bundle default.
