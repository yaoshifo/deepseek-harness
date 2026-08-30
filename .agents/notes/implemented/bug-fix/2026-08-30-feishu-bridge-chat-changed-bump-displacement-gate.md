# Agent Note: feishu-bridge chat-changed bump — gated on the displacement ledger

Status: implemented

English | [中文](2026-08-30-feishu-bridge-chat-changed-bump-displacement-gate.zh.md)

## Problem

Field observation (2026-08-30): during an executing turn, avatar/name-change system notices (agent-driven avatar updates through lark-cli, phase repaints, family stamping) triggered the tool-progress card's recall+resend even when the notice had not pushed the card off the chat tail — a card already reissued past the notice by the content-flush heal was deleted and resent a second time, and thread-isolated cards (whose topic the root-chat tail never applies to) churned on every avatar change. The [2026-08-28 displacement ledger](2026-08-28-feishu-bridge-preview-displacement-ledger.md) deliberately did not track chat-change notices (they arrive as `im.chat.updated_v1`, not messages), so `bumpToEnd` reissued unconditionally: the tombstone-count-equals-displacement-count invariant broke for exactly these events.

## Decision

`onChatUpdated` touches the per-chat activity ledger in the same branch that fires the chat-changed handler — the change's system notice physically lands at the chat tail at event time, so it counts as tracked activity like any message. `StreamPreview.displacedLocked` becomes tri-state (`undefined` when the platform has no prober); the flush heal requires `=== true`, and `bumpToEnd` skips when the verdict is `false` — the card still owns the tail (it was reissued past the notice, it was placed after the event, or it lives in an isolated thread), so no recall+resend happens. A prober-less platform keeps the unconditional bump.

## Alternatives considered

**Gate on the chat-change event timestamp instead of the ledger.** Rejected: a parallel timestamp channel duplicating the ledger's exact purpose — the ledger already answers "did anything land after the card" with one comparison against `placedAtMs`.

**Never reissue on chat-change events.** Rejected: during a silent tool run no content flush comes to heal, and the sidebar summary tracks only the newest message — the push bump stays as the silent-run backstop (the 2026-08-26/28 product decision stands).

**Query the chat's latest message before bumping.** Rejected: system notices are not retrievable through the message-list API, and one read per bump reintroduces the polling the ledger removed.

## Consequences

The bump now fires exactly when the ledger says the card was displaced: a notice above a live card still loses the tail to the card (silent-run sidebar guarantee unchanged), while the already-healed and thread-isolated cases no longer produce tombstones. Streaming turns additionally heal notice displacement at the next content flush (~800ms) instead of waiting out the 2-second debounce, and the debounced bump then no-ops. Known residual race: the ledger touch stamps event-receipt time, an approximation of the notice's landing moment — a card reissued inside the webhook lag between the two still takes one extra reissue; the failure direction is safe (the card keeps the tail).

## Testing

`tests/feishu/preview-tail.spec.ts`: avatar/name chat changes touch the ledger (displaced before, latest after a later send); changes without name/avatar do not. `tests/streaming.spec.ts` "bump to end": the bump skips when the prober reports the card at the tail and reissues when it reports displacement; the existing no-prober tests pin the fallback. Package suite green (2847 tests).
