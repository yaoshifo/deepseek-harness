# Agent Note: Research auto mode runs uncapped; the round-cap machinery is removed

Status: implemented

English | [中文](2026-09-04-chatroom-research-auto-uncapped.zh.md)

## Problem

Research auto mode hard-capped its own iteration: the moderator priming promised「最多 N 轮，达到上限强制收尾」and `gatherRoles` rejected the round that exceeded the cap (default 3; `--max-rounds` per-invocation override; `maxResearchRounds` config, clamped to [1, 20]). The cap predates the per-round 60-minute research gather timeout and the ending-condition priming; with both in place it fired only as a forced wrap-up while substantive disagreements or unverified assumptions still stood — truncating the research the mode exists to run — and it kept a full machinery alive (config field and clamp, CLI flag, durable session fields with codec/reset-carry/bridge v2-lift and v1-mapping entries, i18n strings, card copy) whose override paths no deployment ever configured.

## Decision

Research auto mode iterates as long as the moderator judges the picture incomplete; nothing in the engine limits research rounds. The entire cap machinery is removed in one change: the `maxResearchRounds` config field and its clamp, the `--max-rounds` flag parsing and range error, the durable `chatroomResearchRound`/`chatroomResearchMaxRounds` session fields (state accessors, codec encode and reset-carry, the bridge's version-2 flat-field lift, and the version-1 snake_case mapping), the `gatherRoles` cap check, and every priming/i18n/mode-card mention. The auto-mode ending condition now reads 无轮数上限，按需迭代 with an each-round-has-a-target discipline; the wrap-up intro drops the「达上限被 engine 拦截」case; the mode card says the rounds auto-advance with no cap. `chatroomResearchRound`'s only consumer was the cap comparison, so the counter was removed with it rather than left as write-only state.

## Alternatives considered

**Keep `--max-rounds`/`maxResearchRounds` as an opt-in cap over an uncapped default.** Rejected: no current consumer sets either (the production profile never configured the field), so the opt-in path would be unowned surface; the pre-release stance prefers removing the foundation over carrying compatibility shims.

**Raise the default cap instead of removing it.** Rejected: any finite number re-creates the same forced wrap-up at a different point; the moderator's ending-condition judgment (substantive disagreement / unverified assumption vs complete picture) is the terminator this mode already trusts, and the plain roundtable runs uncapped the same way.

## Consequences

Termination rests on the moderator's judgment and the user (`/chatroom stop`, the wrap-up `ask_user_question`); no engine-side round backstop remains. Each round is still bounded by the research gather timeout (60 minutes default), and `/chatroom stop` still interrupts the whole subtree. A habitual `--max-rounds` now behaves like any unknown flag — skipped, with its numeric value joining the topic — and the usage text no longer advertises it. Old `sessions.json` entries carrying the removed fields drop them on the next save (no compatibility promise pre-release). The clarify-stage caps (最多 2/3 轮追问) are a separate limit and untouched. Verification: package specs assert auto-mode research gathers proceed past 6 rounds and pin the 无轮数上限 priming text verbatim; 386 chatroom-package and bridge session tests green, repo typecheck clean.
