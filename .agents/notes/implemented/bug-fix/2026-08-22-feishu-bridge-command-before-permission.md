# Agent Note: Slash commands dispatch before the pending-permission gate

Status: implemented

English | [中文](2026-08-22-feishu-bridge-command-before-permission.zh.md)

## Problem

With a permission card pending (e.g. a plan review), every registered slash command was swallowed: `/done` typed to tear the session down matched none of the allow/deny/allow-all keywords, hit `handlePendingPermission`'s hint branch, and was consumed with the "⚠️ Waiting for permission response" reply. The turn stayed parked on the permission race — no stall timer is armed during the wait — so the session hung until the user typed a keyword or pressed a card button. In Go cc-connect, `/done` reaches `cmdDone` and tears the session down, unblocking the parked wait via its stop signal.

Root cause: the M3 commit `c86779ae21` routed **all** messages through `handlePendingPermission` before normal dispatch, claiming Go semantics — a misreading. Go `HandleMessage` dispatches slash commands first (`handleCommand`, guarded by `!msg.IsAskqCardAction` since fix `60e20ef6`, which kept commands first precisely so they keep working during a pending permission) and routes permission responses after. The free-text-answer motivation of the TS commit (AskUserQuestion replies like "1") is unaffected by command-first: those replies never start with "/".

## Decision

`handleMessage` restores the Go ingress order: attachment staging → session creation + spawn-user capture → chatroom pending-human routing → slash-command dispatch (`!msg.isAskqCardAction && no images && "/"` prefix; unregistered commands fall through) → `handlePendingPermission` → `!` shell shortcut → session lock. Moving session creation and spawn-user capture above dispatch matches Go and keeps a spawned group's first slash command from losing its spawner attribution. Staging above pending-question routing also restores Go's behavior for image-only messages in a chat with a pending ask-human question (stage instead of routing empty text to the role).

## Alternatives considered

**Allow-list specific commands inside the permission gate (e.g. let `/done` through).** Rejected: invents a TS-only rule; Go's behavior is simply "commands first", and per-command carve-outs would drift from the ported engine.

**Guard the permission gate to skip "/"-prefixed messages.** Rejected: an unregistered `/nope` must still fall through to the hint in Go (command dispatch returns false, permission handling consumes it); skipping all slash messages in the gate would let `/nope` leak into the agent turn instead.

## Consequences

A slash command now executes while a permission card is pending — `/done` and `/stop` can tear down or stop the session (the parked permission wait resolves via its stop signal; the approval request is never answered, the agent session is killed with the chat). A free-text answer starting with "/" to an AskUserQuestion is dispatched as a command instead of an answer — the tradeoff Go accepted in `60e20ef6`; unregistered commands still fall back to the permission path. Permission-card button payloads (`allow`, `deny\x00<note>`) never start with "/", so card answers are unaffected either way.

## Testing

`tests/engine/engine-m3-permission.spec.ts` ("handleMessage routing: slash commands vs pending permission"): `/done` during a pending ExitPlanMode dispatches the command (p2p reply) with no hint and leaves the pending untouched; an askq card answer whose label starts with "/" resolves the question (answers ride the permission response) instead of running a command; free-text "1" still resolves a pending question (the `c86779ae21` motivation); non-keyword free text still gets the hint; an unregistered `/nope` falls through dispatch to the hint.
