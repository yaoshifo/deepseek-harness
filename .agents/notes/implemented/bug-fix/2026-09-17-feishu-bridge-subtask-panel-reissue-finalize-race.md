# Agent Note: A late subtask-panel reissue must not delete the finalized card

Status: implemented

English | [中文](2026-09-17-feishu-bridge-subtask-panel-reissue-finalize-race.zh.md)

## Problem

The follow-tail reissue ([feature note](../feature/2026-09-17-feishu-bridge-subtask-panel-follow-tail.md)) and the panel's finalization are asynchronous against each other, and neither side could observe the other's progress:

- Finalization — the refresh tick's zero-rows branch and `/done`'s `clearSubtaskPanel` — sent the terminal PATCH first and deregistered the panel (`clearInterval` + `subtaskPanels.delete`) only after that PATCH resolved.
- The reissue's resolve callback ran unconditionally: `panel.handle = handle`, then `deletePreviewMessage(old)`.

A reissue send resolving while the terminal PATCH was in flight therefore saw the map entry still present, deleted the card that was receiving the terminal content, and left the just-posted running card as the panel's only survivor — the chat shows 「后台子任务 · N 个运行中」 permanently after every child reported, with no map entry or timer left to correct it. The reject side had the mirrored defect: its fallback PATCH pushed running content onto a card that had just taken its terminal state.

## Decision

Finalization deregisters synchronously; the reissue callbacks verify panel identity at settle time:

- **Deregister before the terminal PATCH leaves** (`refreshSubtaskPanel`, `clearSubtaskPanel`): `clearInterval(panel.timer)` + `subtaskPanels.delete(parentKey)` + the activity forget run synchronously on the finalize decision; the terminal PATCH then goes fire-and-forget to the captured pre-deregistration handle. The tick's map guard stops later ticks on its own, so the dead-card catch path reduces to a warn — no timer or map entry can outlive the tick that decided to finalize.
- **Generation guard** (`reissueSubtaskPanel`, both callbacks): `this.subtaskPanels.get(parentKey) !== panel` — the exact-entry pattern `stopInteractiveSession` uses against the same class of race — means the panel finalized while the send was in flight. The resolve side deletes the just-landed running card (it is panel-orphaned) and writes neither `panel.handle` nor `placedAtMs` nor the reissued log line; the reject side skips the fallback PATCH, so running content never lands on a terminal card.
- The cleaner platform is captured at initiation: `reissueSubtaskPanel` receives the caller's platform (the tick's resolved platform, or the reclaim's report-capable one) and closes over its `asPreviewCleaner` view, instead of re-resolving `reportCapablePlatform() ?? platforms[0]` inside the callback. The card and its deletion go through the same platform even when the report-capable set changes mid-flight.

## Alternatives considered

- **Await the terminal PATCH before deregistering, keeping the original order.** Lengthens the exposure window instead of closing it: any reissue resolving inside the await still deletes the terminal card. Rejected.
- **A `finalizing` flag on the panel state that the reissue callbacks poll.** Adds a third state to a two-state object for what map identity already expresses; the exact-entry comparison is the established pattern for concurrent-teardown races in this engine. Rejected.
- **Let the late reissue win and PATCH the terminal content onto the new card.** Costs a second terminal PATCH per finalize plus a window where running content sits at the tail; deleting the orphan is one operation and keeps the terminal card where the user last saw it. Rejected.

## Consequences

- The finalized card always survives its own finalization: a reissue landing afterwards removes only its own card. The visible cost is a card that appears at the tail and disappears within the send-to-resolve window (rare — it needs displacement and finalization inside that window).
- Both finalize paths share one order — deregister, then fire-and-forget the terminal PATCH — where previously the tick path cleaned up only after the PATCH settled (`clearSubtaskPanel` already deregistered first).
- A terminal PATCH that fails (recalled card, deleted chat) leaves no map entry and no timer; the warn log is the only trace.
- A reissue whose send outlives the panel no longer re-resolves the platform inside its callback, so a mid-flight change to the report-capable set cannot split the card send and its cleanup across platforms.

## Tests

`tests/engine/subtask-panel.spec.ts` `panel reissue vs finalization race` drives four interleavings over gated `sendCardWithHandle` / `updateCardWithHandle` stubs: the reissue resolving after the terminal PATCH landed, inside the deregistered-PATCH-in-flight window (the tightest interleaving), before finalization (the guard's no-over-fire pin — the reissued card is the one that finalizes), and the late-failure fallback. Each asserts which handle carries the terminal content, which handle gets deleted, that no `subtaskPanels` entry remains, and that later ticks PATCH nothing.
