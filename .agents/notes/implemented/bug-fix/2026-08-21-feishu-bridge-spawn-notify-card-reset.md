# Agent Note: feishu-bridge /spawn readiness card usage reset and send observability

Status: implemented

English | [中文](2026-08-21-feishu-bridge-spawn-notify-card-reset.zh.md)

## Problem

Go cc-connect sends the `/spawn`/`/fork` readiness card into the new group immediately and zeroes the engine's per-turn completion-usage fields first (`core/engine_cmd_session.go:1550`), so that card never carries the parent chat's last-turn duration or output-token rate. The TS port's `spawnGroupCommon` kept the card but dropped both halves: no `buildCompletionUsage(0)` reset, and a fire-and-forget `void buildSpawnNotifyCard(...).then(...)` send with no catch and no logging (Go warns via slog.Warn on failure). The reported symptom — "a freshly spawned group's first card shows a token rate" — was the child session's first-turn completion notification (real stats, Go parity), but two real defects stood behind it: in the unit environment the readiness card carried the parent chat's residue (red test title `📁 repo · 18s · 500 t/s`), and on the live daemon the readiness card never appeared at all (three groups spawned 2026-08-21 verified by full chat history), silently because the old code logged nothing.

## Decision

`spawnGroupCommon` (`src/engine/commands.ts`) now awaits `e.buildCompletionUsage` with the zero-argument literal — same shape as the subtask path (`engine.ts` spawnSubtask) and `/notify` (`spawn-family-commands.ts`); three parallel zero-argument call sites, no helper extraction — before building the card, then sends it through an awaited try/catch that warns `spawn: card send failed` on failure. This is Go's synchronous SendCard + slog.Warn semantics; `/spawn` consequently waits one card-send round trip before injecting the first message. The chatroom readiness card keeps its missing reset deliberately: Go `engine_chatroom.go:726` also builds it without zeroing.

## Alternatives considered

**Extracting a shared `zeroUsage()` helper.** Three call sites with identical literals is the existing style; the literal mirrors Go's positional `buildCompletionUsage(0, false, 0, ...)` argument list, and a helper would hide which Go source line each site parallels.

## Consequences

The readiness card shows only workdir/branch, matching Go, and send failures are observable. The real-machine absence of the card is not explained by unit reproduction (the stub platform sends fine), so the open follow-up is the post-merge reload smoke: if the card still fails to appear, the new warn pinpoints the Feishu layer; if it appears, the old fire-and-forget path was the whole story.

## Testing

`tests/engine/commands.spec.ts` `/spawn readiness card (Go buildCompletionUsage(0) parity)`: parent-chat residue (`500 t/s`, `18s`) must not reach the card title or elements on either the bare or the with-message spawn path, and the usage fields are zeroed after the send. Full package suite 1934 tests green.
