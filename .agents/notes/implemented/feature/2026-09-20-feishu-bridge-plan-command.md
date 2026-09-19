# Agent Note: `/plan` in Feishu chats — run-time plan-mode switching

Status: implemented

English | [中文](2026-09-20-feishu-bridge-plan-command.zh.md)

## Problem

Every chat in this deployment starts in plan mode (project `agent.mode = plan`), but nothing could bring a chat *back* into it. Slash dispatch belongs to the bridge's own command table, and this composition never mounts `dsh-commands`, so the native `/plan` command is unreachable from Feishu: a typed `/plan` reached the model as ordinary text and the logged plan state never moved (first established 2026-08-28, re-verified against the current code for this change). The remaining routes all miss the need: `/spawn --plan` pins plan mode on a *new* group, a cron job may carry `mode=plan`, and the project default only applies to a fresh session start.

Go's `/mode` is not the missing half either. That command was ruled unmigrated on 2026-08-21 (`docs/OPERATIONS.md`), and its semantics are one-shot: it arms the *next* session start, so an existing chat whose plan was approved cannot re-plan without restarting the session.

## Decision

The bridge gains `/plan`, registered through the `Engine.registerCommand` seam under the session help group.

**Three shapes.** `/plan` enters plan mode, `/plan off` leaves it, and `/plan <task>` enters and then falls through as an ordinary message carrying the task — the command line is stripped, the message keeps its own delivery path (busy queue, turn start), and the acknowledgement stays silent unless the switch was deferred or unavailable.

**Live sessions switch through a new capability.** `AgentSession` gains the optional `PlanModeSwitcher` (`setPlanMode(active)` + `asPlanModeSwitcher`), implemented by `DshAgentSession` as a forward to `ctx.planMode.set(handle.agent, active)`. The controller owns the state and applies the selection at the next accepted in-turn pre-step, or immediately between turns. Because the native `set()` reports `noop` when the requested state merely matches an already-pending selection, the capability re-reads `planMode.get(agent).pending` and reports that case as `queued`, so a repeat `/plan` during a queued switch cannot be acknowledged as "already in force".

**Cold chats arm the message, never the adapter.** With no live session, `/plan <task>` sets `msg.modeOverride = 'plan'`, which `processInteractiveMessageWith` → `getOrCreateInteractiveStateWith` consumes when that same message starts the session. The adapter's `setSessionMode` is deliberately untouched: it is process-global and one-shot, so whichever chat started a session next would swallow it. A bare `/plan` on a cold chat only tells the user to start one.

## Alternatives considered

- **Mount `dsh-commands` and expose the native command surface** (`/plan`, `/compact`, `/goal`, …). Rejected by the user during the design interview: a far larger surface, with rendering and permission questions for every command, to answer a single need.
- **Reuse `setSessionMode` for live chats.** Rejected: the engine ignores a mode override while a session is live (it logs a warning instead), so the switch would silently not happen.
- **Make `/plan` set a per-chat default mode.** Rejected: that only takes effect on a restart, which fails the point of re-planning an ongoing chat.
- **Deliver `/plan <task>` by steering the text into the running turn** (the `/ps` shape). Rejected: a new task belongs in the queue path; splicing it into a running turn would hand the model a half-finished context.

## Consequences

- `/plan` stops being plain text for the agent. A message that used to reach the model as the literal string `/plan` is now consumed by the command — deliberate, and the reason the command name matches the native one.
- Plan mode remains prompt-level guidance rather than a hard gate (the 2026-08-28 ruling stands): the command switches the state the guidance reads, and nothing about tool permissions changes.
- The bridge's status line does not render plan state, so the acknowledgement is the only immediate confirmation that the switch landed.
- A parked plan-approval card keeps owning its approval: `/plan off` moves the state and leaves the card clickable.
- Files attached to a bare `/plan` or `/plan off` are dropped with the consumed message (the pure-image case never reaches dispatch); acknowledged as out of scope for this change.
- Tests pin the command (`tests/engine/plan-commands.spec.ts`: dispatch, prefix `pl`, every outcome wording, task fall-through, cold chat with and without a task, dispose), the capability against a fake controller (`tests/agent-dsh/adapter.spec.ts`, including the `noop`→`queued` case) and against the real controller (`tests/agent-dsh/adapter-seams.spec.ts`: a live switch commits `plan/mode` events), plus the wiring (`tests/command-registration-effects.spec.ts`).
