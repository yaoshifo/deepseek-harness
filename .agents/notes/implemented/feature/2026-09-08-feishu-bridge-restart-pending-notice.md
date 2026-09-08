# Agent Note: A daemon crash leaves queued input visible through a restart notice

Status: implemented

English | [中文](2026-09-08-feishu-bridge-restart-pending-notice.zh.md)

## Problem

Inbox input queued during a running turn is durable (`agent/inbox/spliced` session events), but a daemon CRASH kills the driver with the input still pending: nothing tells the chat its next message will also claim messages it cannot see. The pending data was already readable through the session-query cold observation and the inbox projection — nothing consumed them at restart.

## Decision

At platforms-ready the engine reports recovered pending input: for every active chat session (excluding machine-facing side sessions — `relay:` pipelines, `#cron` slots) whose persisted agent session still holds pending messages, the chat receives a one-time orange card stating the count and that the messages arrive with the next message. Visibility only — nothing is auto-woken.

## Mechanics

- The engine delegates the cold read to a host-wired `EngineInboxReader` (`pendingCount(sessionId)`) and addresses sessions by their agent-side session id, not the engine's internal record id.
- `createPendingInboxReader` registers `inboxProjectionDefinition` on the projection registry before observing: the unit otherwise only exists once some agent owns an inbox, and at platforms-ready none does — without the registration every read silently returns 0. The definition is now exported from `@deepseek-ai/dsh-agent-loop` (one-line upstream graft, ledger-tracked).
- The observation requests `projectionMode: 'all'`; the default leaves projection state untouched and returns no values.
- The engine's session id comes from `findActive(key)?.agentSessionID` (the persistence key).

## Alternatives considered

- Auto-wake the chat with a synthetic "continue" message: rejected — spends a model request on content the user never sent; left as a product decision if the notice proves insufficient.
- Fold the `agent/inbox/spliced` events manually instead of registering the projection unit: rejected — duplicates the released-format fold and drifts silently if the splice semantics change; the exported definition keeps the fold canonical.

## Consequences

- The notice fires after a crash (kill, power loss). A GRACEFUL shutdown cancels pending input first (`outcome: "canceled"` splices during turn unwinding), so clean reloads produce no notice — the two paths are distinguishable and both are intended.
- `SessionManager.activeSessionKeys()` is a new public enumeration accessor; `EngineInboxReader` is optional and the report stays silent without it.
- The REAL-cold-read test pins the crash semantics: a queued steer flushed to the log, no unwind, then a fresh composition over the same root counts it; a never-persisted id reads 0.
