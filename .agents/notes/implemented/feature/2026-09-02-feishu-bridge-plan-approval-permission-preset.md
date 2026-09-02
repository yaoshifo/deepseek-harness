# Agent Note: feishu-bridge plan-approval permission preset switch

Status: implemented

English | [中文](2026-09-02-feishu-bridge-plan-approval-permission-preset.zh.md)

## Problem

A plan-mode bridge session (the live profile's `agent.mode: plan` default, inherited by `/spawn` groups and main chats alike) approved its ExitPlanMode card yet kept running under the composition's sandbox and approval defaults: writing outside the workspace still denied, retried through a sandbox-permissions escalation, and waited on an approval card. The approval the user just gave authorized the plan's execution, but nothing propagated that authorization into the session's permission knobs — plan state and permission state are deliberately independent ([plan-mode's module contract](../../../../../packages/plan/plan-mode/src/index.ts): sandbox mode and approval policy never read or write plan state).

## Decision

Approving a plan review in the dsh adapter now switches the session's permission preset when the project configures `agent.planApprovalPreset` (`packages/acp/feishu-bridge/src/index.ts` → `DshAdapterConfig.planApprovalPreset`): `answerPlanReview`'s allow branch calls `DshAgentSession.applyPermissionPreset`, which delegates to the composed `permissionPresets.set(session, name)` — the service's existing public write path, so the switch lands as the durable `permission/preset` + `sandbox/mode` + `approval/policy` events, takes effect on the session's next confined call, survives resume/restart by replay, and inherits into delegation-spawned children. The field names a preset, not a knob bundle: the deployment's preset table owns what "full permission" means (the default table's `danger-full-access` = full file access + approval `never`), so a deployment wanting full files while keeping hook-driven approval asks defines a custom preset and names that. Absent or `''` (the default) keeps the approval flow permission-neutral.

The knob semantics ride the native services: with `danger-full-access` the fs/bash fence stops denying, so no escalation asks arise at all, and the model learns the new state from the per-request runtime-context snapshot (the "Current DSH file policy / Approval prompts are disabled" sentences) rather than any bridge-side prompt edit.

Degradation is safe and loud, never approval-breaking: a missing `permissionPresets` service or a preset name absent from the table logs `console.error` and leaves permissions unchanged (the given approval still completes). OPERATIONS.md's `agent.mode` row previously asserted "含审批 preset" — an unverified 2026-08-21 doc fill; the real mapping is this separate field, and the row is corrected.

## Alternatives considered

**Flip the adapter's `bypassPermissions` flag on approval.** The flag auto-answers `approval/request` with `allowed-once`, but the sandbox still denies the first outside-workspace write (the model must eat the denial, retry with `sandbox_permissions`, and get auto-approved), the runtime context keeps claiming `workspace-write`, the in-memory flag dies on restart, and every auto-granted ask still writes its audit pair. Worse on every axis; rejected.

**A core-side plan-mode→permission linkage.** plan-mode's module contract explicitly disclaims permission knowledge; wiring preset switching into `exit_plan_mode`'s approval resolution would change every consumer (web, CLI) at once and couple the two deliberately independent systems. The bridge is the consumer that wants the linkage, so the bridge owns it; rejected for the core.

**Implement through a new `permission-presets` public method and link: the package.** The live profile resolves `dsh-permission-presets` from the pnpm store (not `link:`), so any change there needs a profile dependency edit and install; the existing public `set(session, name)` already writes every knob. Kept the change bridge-only; the only cost is the live policy-change notice (`approval.setPolicy`'s injected user message), which the runtime-context snapshot already covers.

## Consequences

The approval card becomes the single authorization moment: after it, the plan's execution runs with the named preset's permissions and no further approval cards (subagents spawned after approval inherit the elevated knobs through the delegation boundary). `/new` re-arms the default preset and plan mode — each session is review-then-full-power, and an elevated session has no in-session downgrade command (escape hatch is `/new`). The `never` approval side of the default `danger-full-access` preset deterministically rejects any residual hook/tool-policy `ask` — none exists in the current deployment; a deployment that needs those asks must name a custom `{danger-full-access, ask}` preset. `tests/agent-dsh/adapter.spec.ts` pins the allow/deny/unset/missing-service/throwing-switch matrix and `tests/assembly-config.spec.ts` pins the config wiring.

## Testing

`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts` (plan-approval permission preset describe: allow-once and allow-always switch, deny and unset and empty leave untouched, missing service and throwing set degrade safe with an error log); `packages/acp/feishu-bridge/tests/assembly-config.spec.ts` forwards `agent.planApprovalPreset` onto the adapter. No keyless recorded-session snapshot yet — deferred until a recording key is available.
