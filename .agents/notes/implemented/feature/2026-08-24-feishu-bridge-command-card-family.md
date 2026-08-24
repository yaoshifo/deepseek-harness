# Agent Note: feishu-bridge command card family (list / status / switch / help / delete-mode)

Status: implemented

English | [中文](2026-08-24-feishu-bridge-command-card-family.zh.md)

## Problem

On card platforms the bridge rendered `/list`, `/status`, `/switch`, and `/help` as plain text while every other interactive surface (dir picker, cron manager, ask cards) was a button card: session switching meant typing `/switch 3`, and the help output was one long markdown blob. Two buttons were dead by construction: the cron card's back button (`nav:/help`, `cron-commands.ts`) fell through `handleCardAction`'s hardcoded branch chain into the silent no-handler drop, and the `/dir` card deliberately omitted its back button because the help card it should navigate to did not exist. Go cc-connect ships the whole family — `renderListCard`, `renderStatusCard`, `renderHelpGroupCard`, and the delete-mode card state machine — none of it ported.

## Decision

`packages/acp/feishu-bridge` gains the family in three modules:

- `src/engine/session-card.ts`: `renderListCard`/`renderListCardSafe` (one `act:/switch <agentSessionID>` row button per session, active row primary, `nav:/list` paging, `nav:/help` back, and a danger `act:/delete-mode enter` entry), `renderStatusCard` (the status text split by `splitCardTitleBody` into a green title plus markdown body), and the delete-mode state machine (`select → confirm → deleting → result`, `executeDeleteModeAction` + `performDeleteModeAsync`). The deletion effect runs through the optional `SessionDeleter` agent capability (new in `src/core/types.ts`) when the agent implements it, then always drops the bridge's own ledger mappings (`deleteByAgentSessionID` + `setSessionName('')`); the requesting chat's active session is protected.
- `src/engine/misc-commands.ts`: `renderHelpGroupCard` — four group tabs (`nav:/help <group>`: session/agent/tools/system), rows generated from the registered command table via a static group assignment, provider shortcuts injected into the agent group. Row buttons dispatch `cmd:/<id>` (platform-routed command) except card-backed commands (`list`, `status`, `dir`, `help`) which refresh their card in place via `nav:`.
- `src/engine/engine.ts` `handleCardAction`: new branches for `nav:/help`, `nav:/list`, `nav:/status`, `act:/switch` (stop interactive session → `switchToAgentSession` → `clearHistory` → re-render the list card), and `act:/delete-mode`; a shared `refreshOrReplyCard` helper replaces the copy-pasted refresh/fallback pattern. `cmdList`/`cmdStatus`/`cmdHelp` route card platforms to the cards and keep the existing plain-text replies otherwise; `/switch` with no argument renders the list card as the picker. `dir-card.ts` regains its back button.

The delete-mode entry is a button on the list card rather than Go's `/delete` text command: the bridge has no `/delete`, and the roadmap's B5 batch names the list card as the entry point.

## Alternatives considered

**The roadmap's `act:/list switch|delete N` button form.** The Go reference does not have it: `renderListCard` emits per-row `act:/switch <id>` values and deletion is a separate delete-mode card. Ported the real shape; the roadmap line was aspirational shorthand.

**Porting Go's `/delete` text command as the delete-mode entry.** Rejected for this batch: it drags in Go's batch-index deletion grammar (`/delete 1,3-5,8`) that the bridge never ported, while the card entry delivers the same picker with one button.

**Implementing `SessionDeleter` on the dsh adapter by deleting native session storage.** Rejected: the native `sessionPersistence` service is append-only by design and its on-disk layout (jsonl vs sqlite) is backend-private. Reaching into it from the bridge duplicates the session-ledger rework that B7 owns; until a native delete surface exists, deletion is ledger-only.

## Consequences

Card platforms get pickers for sessions and a tabbed help browser; the cron card's back button and the `/dir` card's back button now navigate to the help group card instead of dead-ending. Plain-text platforms are unchanged (`/list`, `/status`, `/help`, `/switch` keep their text replies). Deleting a session currently removes only the bridge's own mappings and names: with the default `filter_external_sessions: false`, a deleted session can still be listed by the native persistence store and reappear in `/list` — the gap closes when the session ledger goes native (roadmap B7). The bridge does not implement `SessionDeleter`, so the capability is exercised by tests only.

## Testing

`tests/engine/session-card.spec.ts` — list card rows/values/paging, status card split, help tabs, `act:/switch` side effect plus in-place re-render, `nav:/help`/`nav:/list`/`nav:/status` routes, and the delete-mode state machine including SessionManager side effects, active-session protection, and the result-card push. `tests/engine/dir-card.spec.ts` and `tests/engine/engine-card-action.spec.ts` updated for the `/dir` back button and the now-routed `nav:/help`. feishu-bridge suite: 2194 passing.
