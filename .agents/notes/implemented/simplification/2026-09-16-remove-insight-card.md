# Agent Note: Remove the feishu-bridge insight card

Status: implemented

English | [中文](2026-09-16-remove-insight-card.zh.md)

## Problem

The insight card (ported from cc-connect #33 Predict Next + turn_summary) fired after every completed turn: a one-line summary of the turn plus a predicted next user message, posted as a purple card with send and block buttons, backed by two lightweight side queries per turn. The user ruled the card useless (2026-09-16): it added post-turn noise and two side-query costs per turn while its suggestions stopped being read. `/btw` — the manual side-question command ported in the same module — is a different capability and stays.

## Decision

The bridge ships without the insight card. Removed with it:

- The post-turn trigger, both generation forks, the incremental card send, and the `act:/nopred` block action, plus the engine's config fields and setters.
- The `predictNext` / `turnSummary` project config keys and their wiring. Schemastery keeps unknown keys in a validated object, so a leftover key would load as a configured-but-inert knob; `buildProjectAssembly` fails at load instead — the same guard class the 2026-09-14 `feishu.progressStyle` removal introduced.
- Five i18n entries: `predict_insight_title`, `predict_send`, `predict_block`, `nopred_title`, `nopred_body`.
- Two surfaces whose only production consumer was the prediction's resume mode: the `forkSessionWithProvider` capability member (the `ForkQuerierWithProvider` interface drops to three members) and `getProviderModel` in `engine/provider.ts` (file deleted).

`engine/predict.ts` shrinks to `/btw` alone and renames to `engine/btw.ts` (`registerPredictCommands` → `registerBtwCommands`). Kept: `/btw` via `forkQuery`, group naming and monitor triage via `lightweightQuery`, chatroom statements via `pollQuery` — all still origin `oneshot` and bare per the [one-shot side-query decision](../architecture/2026-08-26-oneshot-origin-bare-side-queries.md). The [per-chat route fallback](../feature/2026-09-03-feishu-bridge-per-chat-provider-routes.md) and the [flying-turn fork seed](../feature/2026-08-30-feishu-bridge-flying-turn-fork-seed.md) lose the two consumers but keep their mechanisms.

## Alternatives considered

**Keep the code, default off.** Retains a maintained dead path — two fork modes, a card action, five i18n entries — with no consumer; the ruling retired the capability, not its default.

**Remove one half only (summary or prediction).** The ruling named the card as a whole; both halves share the trigger, the card, and the config block.

**Strip the config keys silently.** A leftover `predictNext` block would load as configured-but-inert — exactly the misconfiguration class the progressStyle guard rejects.

**Remove `/btw` too.** Out of the ruling's scope; it is a manual command with its own demand and shares only the module file.

## Consequences

Chats receive no post-turn card, and the two per-turn side queries disappear with their token cost. A config still carrying either removed key fails at load with removal instructions (the Mac live profile carries neither — verified). `forkSessionWithProvider` leaves the shared capability interface; chatroom's test stub drops its reject member, and a future provider-routed seeded fork re-adds a method. About twenty tests that exercised the removed behavior are deleted; `/btw` keeps its five. `docs/config-catalog` and the tool-cordis API catalog keep stale entries until the next upstream sync regenerates them (accepted fork drift); `MIGRATION.md` keeps the porting history.

Two assembly tests pin the residue guard: a leftover `predictNext` or `turnSummary` key survives schemastery validation and `buildProjectAssembly` refuses it.
