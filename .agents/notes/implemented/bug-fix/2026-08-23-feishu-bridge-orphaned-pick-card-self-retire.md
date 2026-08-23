# Agent Note: orphaned chatroom pick cards self-retire on the next click

Status: implemented

English | [中文](2026-08-23-feishu-bridge-orphaned-pick-card-self-retire.zh.md)

## Problem

Chatroom picker state (`#43` role pick, `#59` topic pick) lives in engine-keyed in-memory maps. A daemon restart drops them, but the pushed pick cards survive in the chat with live buttons (surfaced while triaging the 2026-08-23 fb-envfix restart): clicking `confirm` on the orphan replied the purple 正在启动聊天室 card while starting nothing — the state machine returned early on the missing state and the starting card rendered unconditionally — and `toggle` was consumed silently (undefined replacement card). A user following the card's own words gets a silent dead end or a fake success; both mislead worse than a frozen card.

## Decision

`executeChatroomCardAction` short-circuits both `/chatroom-pick` and `/chatroom-topic-pick` when no picker state is armed for the session: every action (confirm, toggle, cancel) returns the same grey expired card (`chatroom_pick_expired`: 本次选择已失效（服务重启或超时），请重新发送 /chatroom). The existing in-place card refresh path (`handleCardAction` → platform `refreshCard`) swaps the pressed card for it, so one click retires the orphan. The no-state check cannot distinguish a restart from the pick watchdog's timeout, so the wording names both.

## Alternatives considered

**Persisting picker state across restarts to keep the card functional.** Only the `select` phase is restorable — `picking` holds a moderator turn that died with the process — and persistence adds a shutdown-time write that `SIGKILL` and crashes skip anyway. The state is 5-minute watchdog-scoped; keeping it live across restarts buys one rare confirm and costs a durable-state seam.

**PATCHing orphaned cards to the expired state at shutdown.** Depends on a graceful stop path (`kill -9` still orphans); the next-click retirement covers every loss mode with no persistence at all.

## Consequences

Picker state stays in-memory (faithful to Go); an orphaned pick card no longer pretends to work — any click turns it into the expired card prompting a fresh `/chatroom`. A restarted chatroom discussion itself is still not resumed; only the misleading card surface is fixed.

## Testing

`tests/engine/engine-chatroom.spec.ts` ("orphaned picker cards") drives `executeChatroomCardAction` with no armed state across both pickers and all three actions, asserting the grey expired card and zero spawns. feishu-bridge suite: 2104 passing.
