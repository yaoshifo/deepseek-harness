# Agent Note: Waiting out agent-session teardown before a resume degrades

Status: implemented

English | [中文](2026-08-21-feishu-bridge-stop-resume-live-guard.zh.md)

## Problem

Production incident 2026-08-21 (chat oc_6ee6): a user stopped a turn (⏹ 停止执行 or `/stop`), typed 「继续」 a moment later, and the engine replied `session_resume_degraded` — the chat silently lost its whole conversation context. The resume had failed with dsh's live guard (`cannot prepare session "cc-…" while it is live`, coordinator `prepare` throws immediately while the session is still registered) because `stopInteractiveSession` deleted the interactive state at once and closed the agent session fire-and-forget with `void close()`, unlike `cleanupInteractiveState` which arms a `state.closing` guard. The same teardown window can also be entered through `closeAgentSessionWithTimeout`'s silent 130 s race loss. Two compounding defects made the incident worse: the degraded fallback kept `compareAndSetAgentSessionID`'s sticky semantics, so the session record stayed pinned to the unresumable id (chat s129 kept pointing at `cc-…140944` after the degrade), and every path involved was silent — the service log showed nothing between the turn's completion and the failed resume.

## Decision

Three defenses in `dsh-feishu-bridge`'s engine, each independently sufficient to avoid the observed degrade:

1. `stopInteractiveSession` now detaches `agentSession`, arms `state.closing` with the close promise, and removes the map entry only when the close settles (identity-checked against a newer claimant). The existing concurrent-teardown wait in `getOrCreateInteractiveStateWith` then holds a racing 「继续」 until the teardown finishes instead of resuming the still-live session.
2. A resume rejected by the live guard polls `startAgentLocked` within `liveGuardRetryBudgetMs` (default `agentCloseTimeout`, 500 ms interval; `setLiveGuardRetryBudgetMs` is the test hook) before degrading. Non-live-guard errors degrade immediately as before — only "in-flight teardown" is worth waiting for.
3. The degraded fallback rebinds the record with `setAgentSessionID` (the old id moves to `pastAgentSessionIDs`), so a poisoned id cannot pin the chat; the normal resume path keeps `compareAndSetAgentSessionID` semantics.

`stopInteractiveSession`, the live-guard retry warning, and `closeAgentSessionWithTimeout`'s race loss now all log, closing the diagnosis vacuum. Tests: `tests/engine/engine-resume-race.spec.ts` pins stop-then-continue waiting, live-guard retry, and degrade-rebind; the `/stop` command test was updated to the new contract (the entry lingers with `closing` armed while close is blocked — still returning to the user immediately, as before).

## Alternatives considered

**Fix dsh's `prepare` to await an in-flight live teardown instead of throwing.** Root-correct but a coordinator-semantics change: the guard also protects against a genuine second holder, and distinguishing "teardown in flight" from "still actively used" inside `prepare` needs registry knowledge the coordinator does not own. Deferred; the bridge-side wait covers the known window.

**Reuse `cleanupInteractiveState` for `/stop`.** It awaits the full close inline (bounded by 130 s); `/stop` must return to the user immediately (Go parity — the /stop test pins a 500 ms return while close is blocked). The armed-`closing` variant keeps the return contract while making the race safe.

**Keep fire-and-forget close but clear the record's id on stop.** Loses the transcript by design on every stop; stop-then-continue is a primary card flow (⏹ then ▶ 继续执行), not an error path.

## Consequences

A 「继续」 typed right after a stop now waits out the teardown (up to the close timeout) before its turn starts — a brief delay instead of silent context loss. The interactive-state map briefly holds a stopped entry with `closing` set; `getOrCreateInteractiveStateWith` already treats that as a wait, and readers that check `agentSession` see `undefined`. If dsh later adopts prepare-side waiting, defense 2 becomes redundant and can retire. The untracked half-finished `/ps` i18n removal in the working tree (missing `Msg.PsSendFailed` reference cleanup) predates this change and is not touched.
