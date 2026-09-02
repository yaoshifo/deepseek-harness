# Agent Note: A resolved bypassPermissions mode grants approval bypass in the bridge

Status: implemented

English | [中文](2026-09-02-feishu-bridge-mode-bypass-permissions-grants-approval-bypass.zh.md)

## Problem

The bridge's mode vocabulary promises six values (`default`, `bypassPermissions`, `acceptEdits`, `plan`, `auto`, `dontAsk` — validated by the cron store and advertised by the cron tool's schema), but `startSession` consumed the mode string for exactly one thing: `planMode.set(agent, mode === 'plan')`. A cron job configured `mode: 'bypassPermissions'` therefore only turned plan mode off — its tool-approval asks still routed to cards, where an unattended run fails closed as `unavailable`. [The cron unattended-mode note](2026-08-24-feishu-bridge-cron-unattended-mode-default.md) explicitly names the per-job `mode` field as "the deliberate stronger escape hatch for jobs that want bypass"; the implementation never cashed that promise. Only the unattended-subtask base (and chatroom personas via the permission-policy waterfall) actually flipped the session's `bypassPermissions` flag.

## Decision

`startSession` now computes the mode first (one-shot override > `/spawn` pin > project default, then the `feishuBridge/mode-policy` waterfall) and derives the session's `bypassPermissions` from the resolved value: `unattended || mode === 'bypassPermissions'` (`packages/acp/feishu-bridge/src/agent-dsh/adapter.ts`). Any source that lands on `bypassPermissions` — a cron job mode, a spawn pin, or a project `agent.mode` default — now auto-approves tool permissions the same way the unattended base does. Deriving from the post-waterfall mode keeps the listener chain authoritative: a future listener that rewrites the mode rewrites the bypass with it. The other mode values (`acceptEdits`, `auto`, `dontAsk`) remain label-only, unchanged.

## Alternatives considered

**A cron-only bypass flag.** Rejected: the gap is in the mode vocabulary's shared meaning, not the cron path; a cron-specific flag would leave a spawn pin or project default saying `bypassPermissions` while meaning "plan off".

**Fail loud instead: reject `bypassPermissions` at the cron store.** Rejected: the value is documented vocabulary (the cron tool schema and the 2026-08-24 note both promise it); making it real is smaller and matches Go effectiveMode's original semantics.

## Consequences

A cron job (or any session) explicitly set to `bypassPermissions` runs without approval cards — including sandbox-escalation asks, which auto-approve as `allowed-once`. That is the documented trade the escape hatch makes; an operator who wants cards keeps `default`. The status footer's YOLO label now corresponds to real behavior. `tests/agent-dsh/adapter.spec.ts` pins the override and default paths (no delegate wired: without the bypass the answerer fails closed as `unavailable`).

## Testing

`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts` (`effectiveMode bypass wiring`): a `setSessionMode('bypassPermissions')` override and a `setDefaultMode('bypassPermissions')` project default each auto-approve an `approval/request` as `allowed-once` with no ask delegate composed.
