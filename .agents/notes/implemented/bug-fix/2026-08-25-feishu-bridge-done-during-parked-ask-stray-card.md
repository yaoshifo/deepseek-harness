# Agent Note: feishu-bridge /done during a parked ask no longer restarts ask surfaces

Status: implemented

English | [中文](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.zh.md)

## Problem

Production incident 2026-08-25 (chat oc_d22d, 「上游变更检查」): the group's last turn parked at 08:44 on a closing `ask_user_question` card the user never answered; the `/done` 26 minutes later left a fresh 「执行中 · 09:11:00」 running card with a stop button in the chat, one minute after the teardown (session log: the ask's `tool/call` at 08:44:25.970, its `tool/result` plus `turn/end` at 09:10:57.544 — the `/done` abort). Two defects compounded:

- `askUser` resolved the parked ask via the stop signal (`decided = cancelled`) but still ran `restartAskSurfaces` unconditionally — minting a fresh `StreamPreview`, pushing its placeholder running card, and re-binding the engine-level active preview to it. Every stopSignal trigger (stopInteractiveSession teardown, interactive-state recycling, cleanup) discards or replaces the state, so nothing would ever finalize the new card. The restart exists so post-decision execution lands on a new card ([post-permission restart](2026-08-20-feishu-bridge-post-permission-card-restart.md)); a torn-down session has no post-decision execution.
- The `/done` avatar-dim fired `im.chat.updated_v1` → `onChatChanged` (2 s debounce) → `bumpActivePreviewForSession` → `bumpToEnd`, which reissues the preview as a new card and deletes the old one — refreshing the ghost into 「执行中 · 09:11:00」. `bumpToEndLocked` guarded `previewMsgID`/`degraded`/`completed`/`failed` but not `stoppedCardRendered` (`markStopped` leaves `degraded=false`), and the bump binding was never dropped by the teardown — so even a correctly rendered ⏹ card ([stop finalizes the preview](2026-08-22-feishu-bridge-stop-finalizes-preview-card.md)) would have been replaced by a fresh running card, and every later rename/avatar change for the dead chat would resurrect it again.

## Decision

Three coordinated changes, one per hole:

1. `askUser` runs `restartAskSurfaces` only when the outcome is `decided`. The stopped/aborted outcomes return the cancelled decision without new surfaces.
2. `bumpToEndLocked` adds `stoppedCardRendered` to its guard list: a stopped card is terminal, and a bump is a reissue, not a resurrection. `resumeFromFreeze` re-arms the flag, so a legitimately resumed freeze still bumps.
3. `stopInteractiveSession` drops the engine-level bump binding when `activePreviewSession` matches the stopped session: post-teardown rename/avatar notices have no preview left to reissue.

## Alternatives considered

**Fix only the bump guard.** Rejected: the placeholder from `restartAskSurfaces` would still be sent at teardown — one stray running card per `/done`-while-ask-parked, merely never refreshed afterwards.

**Fix only the askUser branch.** Rejected: with the event loop racing the ask continuation, the stop arm may render ⏹ on the old preview first, and the avatar-dim bump still resurrects stopped cards — the incident's card survives on roughly half the interleavings.

**Detaching inside bump instead of guarding.** Wrong owner: terminal-ness is already carried by the preview's flags; the guard just had a hole.

## Consequences

`/done`, `/stop`, `/new`, `/switch`, and interactive-state recycling during a parked ask no longer emit any new preview card; a rendered ⏹ card survives later rename/avatar notices for the same chat. A decided ask still restarts surfaces — post-decision execution keeps landing on a fresh card. The bump binding now dies with its session instead of with the next turn anywhere in the engine.

## Testing

`tests/engine/engine-ask.spec.ts`: the aborted and stopped settle tests assert `state.preview` stays undefined; the allow-path test pins that a decided outcome still restarts surfaces. `tests/streaming.spec.ts` "bump to end": a `stopped` case joins the no-op table (with `degraded=false`, exactly as `markStopped` leaves it). `tests/engine/engine-chat-renamed.spec.ts`: bind → `stopInteractiveSession` → `bumpActivePreviewForSession` is a no-op, and another session's binding survives an unrelated stop. Red-checked by stashing the src changes: exactly these four assertions fail. Focused suites and repo typecheck green.
