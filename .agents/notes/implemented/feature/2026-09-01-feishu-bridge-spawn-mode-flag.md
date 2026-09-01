# Agent Note: /spawn --plan/--default per-group mode pin

Status: implemented

English | [中文](2026-09-01-feishu-bridge-spawn-mode-flag.zh.md)

## Problem

The project config `agent.mode` (typically `plan`) was the only way to pick a session's permission mode, and it applied uniformly to every chat of the project. Delegated task groups could not differ: a project running plan-first got plan mode in every spawned group even for trivial errands, and a project running direct execution could not ask for a plan-first child without reconfiguring the bot. Go's `/mode` one-shot override command was ruled out of the migration (2026-08-21), so there was no chat-side knob at all.

## Decision

`/spawn` and `/fork` accept a boolean `--plan` / `--default` flag (mutually exclusive; both present replies `spawn_mode_conflict` and aborts before the group exists). The flagged mode is pinned on the child group's chat, not on one session start, and flows through existing plumbing:

- The pin lives on the bridge `Session`'s `inheritedMode` field — a chat-scoped record that `carryChatScopedState` already carried across `/new` resets, so the pin survives session rotation inside the chat. It stays in-memory (never serialized): a daemon restart drops the pin and the chat falls back to the project default, the same trade-off as `pendingMonitorClarification`. A spawn without the flag writes the parent's `parentEffectiveMode()` exactly as before — always `''` today (`effectiveMode` has no non-`''` writer), so activating the read side changed no existing behavior.
- `buildSessionStartOptions` lifts a non-empty pin into the new `SessionStartOptions.spawnMode` field (the same pattern as `persona.forceMode`).
- The dsh adapter's mode chain is now: unattended-subtask `bypassPermissions` > one-shot `modeOverride` (cron job modes) > `spawnMode` pin > project `defaultMode`, then the `feishuBridge/mode-policy` waterfall (chatroom persona downgrades) as before. The pin is reapplied on every `startSession` of the chat — idle-reaped session restarts and `/new` rotations keep the mode — unlike the one-shot override, which the adapter consumes once.

`--default` under a `plan`-configured project is the headline case: the pin outranks `defaultMode`, so the child executes directly. The reverse (`--plan` under a `default` project) arms plan mode with the full ExitPlanMode card pipeline. Only these two values are accepted — the native plan-mode controller is on/off, and the other mode names (`bypassPermissions`, …) express themselves through the unattended-subtask bypass, which already outranks everything.

## Alternatives considered

**Message-level `Message.modeOverride`** — the engine already consumes it (`handleMessage` → `startAgentLocked` → `setSessionMode`), so the diff would be one line. Lost: it is a one-shot arming consumed by the first `startSession`, so the mode would drop on child-session restarts and on `/new`, and a bare `/spawn --plan` (no task text, no first message) would lose it immediately — the session starts on the user's first message later. A chat-level pin covers all three.

**`persona.forceMode`** — a persona is a whole-prompt replacement with its own permission bypass; a spawn pin is neither, and coupling them would force a fake persona block onto plain spawn groups.

**Serializing `inheritedMode` into `SerializedSession`** — would make the pin survive restarts, but it grows the persisted format for a field whose loss (fallback to project default) is benign. Deferred until a real need appears.

**A generic `--mode <name>` flag** — six mode names exist in cron, but for interactive groups the only meaningful distinction is plan/no-plan; two boolean flags keep the help text and the parser minimal.

## Consequences

Bought: per-group mode control without touching the bot config — one spawn command decides whether that child plans first or executes directly, and the pin outlives `/new` and idle reaping. Cost: the pin is in-memory, so a daemon restart silently returns the group to the project default (users who pinned `--default` on a `plan` project see plan mode return after a restart); and `--plan`/`--default` are the only two values — a group wanting `bypassPermissions`-style behavior cannot ask for it (that mode belongs to unattended subtasks by design).

## Verification

`tests/engine/commands.spec.ts` (flag extraction, pin value, no leak into task text, conflict rejection), `tests/engine/commands-fork-at.spec.ts` (fork symmetry), `tests/engine/engine-subtask.spec.ts` (`buildSessionStartOptions` lift), `tests/agent-dsh/adapter.spec.ts` (chain ranking: pin > default, one-shot > pin, bypass > all, pin persists across starts). Full package suite green (2973 tests). Live-machine smoke pending deploy: `/spawn --plan <task>` should park an ExitPlanMode card in the new group; `/spawn --default` under a `plan` project should execute directly.
