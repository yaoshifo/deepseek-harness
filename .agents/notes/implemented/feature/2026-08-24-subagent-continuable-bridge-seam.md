# Agent Note: The continuable seam satisfies the bridge's unattended-subtask preconditions

Status: implemented

English | [中文](2026-08-24-subagent-continuable-bridge-seam.zh.md)

## Problem

The feishu-bridge de-baggage roadmap migrates unattended subtasks (no Feishu group, no user watching) onto native continuable child sessions in batch B4. Two native gaps blocked that migration.

First, `startContinuable` silently ignored `SubagentStartRequest.cwd`. The model-facing consumer (`tool-subagent`) already forwards `cwd` into continuable requests, and the one-shot path validates, capability-gates, and persists it ([the cwd-override note](../architecture/2026-08-23-subagent-cwd-override.md)), but the continuable path had no validation, no capability gate, and dropped the value before `childSessionMeta` — a cross-directory child would have run in the parent's cwd.

Second, `notifySettlement` unconditionally wakes or steers the parent agent. The bridge's engine drives parent turns itself (`agentSession.send` → `Agent.followup`, with the event loop drained only inside engine turns), so the native wake would start a spontaneous parent turn the engine never scheduled — one model request the engine cannot render and the deployment never asked for.

## Decision

**cwd parity.** `startContinuable` now runs the same start-time gates as one-shot `start`, before any identity reservation or persistence work: the capability assertion (a new `ContinuationHost.assertStartCapabilities` hook, implemented by the runtime's `assertCapabilities` over the shared `SubagentCapabilityOptions` subset) and the absolute-path validation with the same error code and wording. The resolved cwd flows into `childSessionMeta`'s fourth parameter and the durable child session header, so cold resume reads it back. Full gating rather than cwd-only was chosen for symmetry with the one-shot path: existing continuable test specs request no capabilities, so full gating breaks nothing, and one seam keeps one gating contract.

**External settlement delivery.** `SubagentRuntime` gains a loader-level config `settlementNotice: 'inbox' (default) | 'external'`. Under `'external'`, `notifySettlement` returns before any wake, steer, inject, or inbox write; settlement remains observable through the `subagent/end` event and the child's own Session. The default is unchanged, so `tool-subagent`'s model-facing promise — an unconditional runtime notice — holds everywhere except deployments that explicitly assert they own the notice channel. The bridge is exactly that deployment: it delivers its own `[子任务完成]` synthetic message through the engine's turn machinery.

## Alternatives considered

- **Gate only `cwdOverride` on the continuable path.** Narrower, but leaves two different gating contracts on one seam. Rejected for symmetry and fail-loud; the planned fallback (narrow the gate if existing tests broke by design) never triggered.
- **Keep the settlement wake and let the bridge suppress it after the fact.** The wake is a direct `Agent.followup`/`steer` inside the manager's disposal transaction; nothing outside can cancel it, and the model request is spent either way. Rejected.
- **A new seam event the bridge could intercept to cancel delivery.** `subagent/end` fires after ownership release and names no parent; intercepting before delivery means inventing another event with the same information the config field carries. The config field is the smaller seam.
- **Make `tool-subagent`'s schema promise conditional.** Model-facing text would regress from "you are told" to "usually". Rejected: `'external'` is a deployment assertion that the deployment delivers the account itself, not conditional delivery — the parent still learns the outcome, through the deployment's channel.

## Consequences

- One-shot and continuable starts enforce the same capability vocabulary. `SubagentCapabilityOptions` (the five optional capability-bearing fields) is the shared gate input, exported for the host hook.
- `SubagentRuntimeConfig` with `static Config` (schemastery) is the subagent package's first loader-level config; direct `ctx.plugin(SubagentRuntime, …)` callers resolve the default themselves.
- The bridge's B4 bridge-half consumes both: it mounts `SubagentRuntime` with `settlementNotice: 'external'` and passes worktree paths as `cwd`.
- The [settlement-delivery note](2026-08-06-manager-owned-subagent-settlement-delivery.md) is amended in place: its unconditionality invariant applies to `'inbox'` (the default); `'external'` is deployment-owned delivery.
- No snapshot: default behavior is unchanged for both features (cwd is opt-in per request, `settlementNotice` defaults to `'inbox'`), matching the cwd-override sibling commit's precedent.
