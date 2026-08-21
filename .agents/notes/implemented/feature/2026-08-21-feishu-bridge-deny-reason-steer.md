# Agent Note: Ordinary-tool deny reasons steered next to the rejection

Status: implemented

English | [中文](2026-08-21-feishu-bridge-deny-reason-steer.zh.md)

## Problem

The permission card's deny path built a native-format rejection message — `buildDenyMessage(note)`, the Claude Code tool_result wording with the user's reason — and passed it as `PermissionResult.message`, but nothing downstream could deliver it for ordinary tools: the Go `dshSession.RespondPermission` non-question branch sends only `{outcome: "rejected"}`, the TS approval answerer returns only `decision.outcome`, and dsh core turns that outcome into the fixed `Error: the user rejected tool "X"`. The `ApprovalOutcome` seam is a plain string union with no message channel, so a typed deny reason reached only the in-place card update, never the model. Verified as Go-parity behavior, not a porting gap — the Go original drops it the same way.

## Decision

The engine's `handlePendingPermission` deny branch steers the raw note when it is non-empty, the pending tool is not `ExitPlanMode`, and an agent session exists: `state.agentSession.steer(note)`, verbatim, same channel as the [plan-approval supplement](2026-08-21-feishu-bridge-plan-approve-supplement.md) and [/ps](2026-08-21-feishu-bridge-ps-steer.md). The model sees the rejection error and the user's reason in the same turn. The wrapped `buildDenyMessage` still rides `PermissionResult.message` unchanged for the plan-review path, which consumes it as keep-planning feedback — hence the `ExitPlanMode` guard, which keeps the reason from being delivered twice.

## Alternatives considered

**Extend `ApprovalOutcome` with a reason-carrying structure.** Rejected: a cross-package contract change (user-approval, plan-mode consumers, apiproxy schema, Web UI, cc-connect-bridge) for one bridge's UX; the bridge-side steer closes the loop with zero contract churn.

**Steer in the adapter's approval answerer (where the drop happens).** Rejected: the answerer receives only the wrapped message — the native preamble plus the reason — while the raw note exists only in the engine, and the engine already owns `state.agentSession`.

**Steer the wrapped message instead of the raw note.** Rejected: dsh core already states the rejection in the tool_result; a user message repeating the native preamble is noise. The bare note next to the rejection error reads as the user explaining how to proceed.

## Consequences

Ordinary-tool deny notes are model-visible in the current turn on the Feishu card flow; the wrapped native deny message remains dead weight on that path (kept for Go parity and the plan-review consumer). If the model ends its turn immediately after the denial, the steer is claimed by the next turn instead of lost — the same edge as the approval supplement.

## Testing

`tests/engine/engine-m3-permission.spec.ts` ("deny reason steer"): a Bash deny with a note still sends the wrapped deny message and steers the note verbatim; an ExitPlanMode deny with a note steers nothing (custom feedback already delivers it); a bare deny steers nothing. `RecordingAgentSession` gains `steerCalls` recording in `tests/stubs/engine-stubs.ts`.
