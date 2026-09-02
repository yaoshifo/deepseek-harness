# Agent Note: feishu-bridge chatroom interrupt disarms member subtask gathers

Status: implemented

English | [中文](2026-09-01-feishu-bridge-chatroom-interrupt-disarms-gathers.zh.md)

## Problem

The 2026-09-01 oc_0e4b5c92 research chatroom resurrected itself after a clean stop. The user manually stopped the five research-assistant subgroups (22:39:53–22:40:17, `user stopped turn, auto-report suppressed`), then sent `/chatroom stop`; `interruptChatroom` executed correctly at 22:41:15 (hub turn stopped, both chatroom barriers consumed, 10 member groups torn down, all chatroom flags cleared). Thirteen minutes later, at 22:54:18–39, all five role groups started fresh turns by themselves and kept working until the user stopped each one again.

The wake source was the members' own subtask gathers: each role had armed `pendingSubtaskGather` at 22:34:18–39 (expected=1, 1200-second fallback timer) waiting on its assistant subgroup. A user-stopped assistant never reports (auto-report suppression is deliberate takeover semantics), so those barriers could only end at their timeout — 22:34:18 + 1200s = 22:54:18, matching `subtask: gather timed out; woke parent with partial results` to the second. `interruptChatroom` consumed the chatroom barriers on the hub but never touched the member sessions' subtask barriers, and the [gather-abort decision](2026-08-26-feishu-bridge-gather-abort-settles.md) deliberately keeps an aborted gather's barrier armed so the timeout wake still delivers banked reports. Pause semantics met teardown semantics, and the teardown resurrected.

## Decision

`interruptChatroom` disarms subtask gathers across the teardown scope: `Engine.clearSubtaskGather(sessionKey)` stops the fallback timer and drops the barrier without waking, and interrupt calls it on the hub right after `stopInteractiveSession(hubKey)` and on every subtree member inside the existing stop loop — always after the member's turn stop, because the abort listener settles a blocking gather's parked tool promise first and the clear must never resolve or strand a waiter. The `chatroom: interrupted` log line gains `gathers_cleared=N`. A plain user `/stop` keeps the 2026-08-26 semantics unchanged: the barrier stays armed and the timeout wake still delivers partial results.

## Alternatives considered

- **Disarm inside the gather abort listener (every stop).** Rejected: a plain user stop is a pause — the user may come back, and the timeout wake is what delivers the banked partial summary. Disarming on every abort discards collected reports, the exact loss the 2026-08-26 note guards against.
- **Clear member gathers in `finalizeChatroomEnd` (shared with normal end).** Rejected: normal end drains in-flight replies; a role parked on a blocking gather whose barrier silently vanishes never receives its tool result — the parked-turn hazard the 2026-08-26 fix removed. `endChatroom`'s existing escape for dead reply sources (`force: true` / `/chatroom stop`) keeps owning that case.
- **Suppress the wake at delivery time (check "chatroom torn down" in `wakeParentWithGather`).** Rejected: the barrier would linger with a live timer and the check would need a chatroom-aware lookup inside the generic subtask wake path; disarming at the one teardown owner is local and testable.

## Consequences

- `/chatroom stop` is terminal for the whole subtree: no delayed gather timeout (or anything reading the disarmed barrier) can start a turn in a torn-down member afterwards.
- Residual: normal end (not interrupt) still lets a role waiting on a dead assistant ride the gather timeout before its reply can drain the end barrier; bounded by the gather and end timeouts, with `force: true` as the escape.
- Residual: a user-stopped assistant's suppressed report means the parent role's gather can only complete at its timeout even while the chatroom is alive — deliberate user-takeover semantics, unchanged.
- Covered by `packages/acp/feishu-bridge-chatroom/tests/engine/engine-chatroom-interrupt.spec.ts` (barrier cleared by interrupt; the 20-minute fallback advances without waking the role).
