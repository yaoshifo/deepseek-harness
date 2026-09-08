# Agent Note: Chatroom open/close persistence follow-ups — poll attendance self-heals, the ended hub goes done

Status: implemented

English | [中文](2026-09-08-chatroom-end-persistence-follow-ups.zh.md)

## Problem

Two state-persistence gaps surfaced by re-reading the 2026-09-07 oc_94b41a session end to end (follow-ups to the picker-bootstrap fix landed the same day):

- **Opening-poll attendance lines were dropped on the floor.** The guided flow's opening lightning round settles before `start` initializes the ledger, so `persistPollStatements`' appends hit `ENOENT …/RECORD.md` — 13 warns at 22:34:50, every attendance line lost, and the moderator re-summarized the round by hand into the synthesis instead. The attendance record existed precisely to be independent of the moderator's writing.
- **The moderator-tool end path never marked the hub's own spawned-group entry done.** Roles get their done mark through `cleanupOneChat`; the `/done` command path additionally drives the generic teardown that marks the hub — but the moderator's `end` tool call runs `finalizeChatroomEnd` with no `/done` behind it, so the ended hub kept `active=true / phase=discussing` in the spawned-state file and its color discussing avatar (observed 6 h after the 05:41 ended log line).

## Decision

- **`appendChatroomLedger` self-heals** (`chatroom-ledger.ts`): the append path creates the ledger dir and the `## 讨论记录` heading when RECORD.md is absent, so pre-init appends land instead of throwing. **`initChatroomLedger` writes RECORD.md only when absent** — SYNTHESIS/SUBPROBLEMS stay overwrite semantics (a new chatroom is a new discussion), while pre-start attendance lines survive the init that follows. Per-run ledger dirs already isolate distinct chatrooms, so preserving is never stale-data reuse; the only same-dir init-after-append path is this pre-start sequence and same-run retries, where preserving is the wanted behavior. **`persistPollStatements` resolves the dir as the NEXT run pre-start** (`pollLedgerDirFor` in `chatroom.ts`): the guided opening round settles while the moderator flag is down, and plain `max(run, 1)` would resolve a second chatroom on the same hub into the PREVIOUS run's dir — attendance from run 2 polluting run 1's ledger; pre-start uses `run + 1` (exactly the run `start` will consume), post-start keeps the current run.
- **`finalizeChatroomEnd` marks the hub done** (`chatroom.ts`): `void e.markSpawnedChatDone(p, hubKey)` next to the hub-flag cleanup, covering every end path (tool end, `/done`-driven interrupt, forced interrupt). The `/done` command path marks the hub again afterwards — idempotent (`active=false` re-set), and the done/undone avatar axis already treats a done-mark as terminal until the next user message restores baseline.

## Alternatives considered

- **Defer poll persistence until after start (buffer in memory).** Loses attendance when the user never confirms the cast; the ledger is the durable home, the buffer would be a second source of truth.
- **Have the moderator's priming re-state the round into the ledger (prompt-level).** The attendance record was designed to be independent of moderator writing; re-relying on it recreates the dropped-lines failure mode.
- **Mark the hub done from the bridge's generic teardown listener only.** That listener runs for `/done`, not for the tool end; moving the mark into `finalizeChatroomEnd` is the single point every end path already shares.

## Consequences

- Tests: append before init creates dir + heading + the line; init keeps pre-start lines while rewriting SYNTHESIS; an end-to-end opening poll without start lands three attendance lines and a following `startChatroom` keeps them; a second chatroom's pre-start poll on a hub whose run 1 ended lands its lines in the NEXT run's dir and leaves the previous run's RECORD.md byte-identical; `endChatroom` on a started room marks both roles and the hub done; the `/done`-driven interrupt path now marks the hub twice (idempotent — assertion relaxed to ≥1 with the roles' exactly-one guard kept).
- The pre-start dir (`run + 1`) matches the run `startChatroom` consumes next by construction (start increments then uses); a moderator flag that survives without a live room (interrupted rooms clear it) keeps the mapping coherent because the flag, not wall-clock state, is the started/pre-start discriminant.
- Deployment: bridge-chatroom plugin rebuild + `/reload`; no config change.
