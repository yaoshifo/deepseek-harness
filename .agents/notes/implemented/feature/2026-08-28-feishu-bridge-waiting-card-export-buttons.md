# Agent Note: feishu-bridge waiting cards carry the export/reply button row

Status: implemented

English | [中文](2026-08-28-feishu-bridge-waiting-card-export-buttons.zh.md)

## Problem

When an ask or permission parks the turn, `captureReplyForExport` (engine.ts, called before `completeAndDetach(true)`) already registers the partial reply — the trailing 实时播报 segment, falling back to the full text — under the progress card's message ID in `InteractiveState.exportContent`. The card then renders the blue「等待中」header from [the parked-ask cap-exemption note](../bug-fix/2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.md). But `injectReplyButtons` injected only on a green header, so while the user sat on the choice card there was no way to retrieve that text: the 实时播报 segment may be truncated on the card, and until the turn settles the export key serves nothing. The user sees the agent's question but not the reply that preceded it.

## Decision

`injectReplyButtons` (progress.ts) injects the「📄 导出文件」/「💬 查看完整回复」row on green **and** blue headers. Blue is safe only because the progress-card PATCH path maps the blue template exclusively to the `waiting` state a park entered after `captureReplyForExport` registered the partial reply under the same key the buttons present; any new blue progress state must stay out of this precondition. The click path (`export:`/`sendreply:` → the engine export handler) is unchanged, including its fallback to `lastBaseResponse`.

## Alternatives considered

**Injecting on running (yellow) cards too.** Rejected: this turn's content is not registered until the EventResult export block runs, so a click falls back to the previous turn's reply — misleading — and the 实时播报 section keeps updating on a running card, so the full text is not yet frozen.

**Registering an empty string under the key when a park captures no text.** Rejected: the export handler treats an empty registration as failure, which would degrade the common path where — after the user answers and the turn completes — the old parked card's buttons correctly fall back to `lastBaseResponse`, by then this turn's final reply.

**Delivering the partial reply as chat messages at park time.** Rejected: the speculative reply render (`renderAndDeliverReply`) already delivers over-threshold text at the park, and short segments are visible on the card; extra messages are noise.

## Consequences

A waiting card carries two button rows:「⏹ 停止执行」plus the export/reply row. After the user answers, the card still finalizes green with its buttons, and the parked-partial content remains retrievable. For a plan-review park the blue Tool Process card exports the non-plan segment while the plan card exports the plan itself — complementary. A park with no preceding text (a turn that asks first) falls back to the previous reply on export, matching the existing green-card fallback semantics. Deferred alongside it: stopped (⏹ 已停止) and failed (red) cards still have no export entry — the same retrieval gap, not addressed here.

## Testing

`tests/feishu/progress.spec.ts` injectReplyButtons case table: blue injects both buttons; yellow, violet, and red inject nothing.
