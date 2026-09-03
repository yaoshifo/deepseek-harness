# Agent Note: chatroom per-turn persona re-anchor on moderator→role turns

Status: implemented

English | [中文](2026-09-03-feishu-bridge-chatroom-persona-turn-anchor.zh.md)

## Problem

Chatroom role personas are injected once, at session create/resume, as a complete system-prompt replacement — a stable, KV-cache-friendly prefix. The 2026-09-03 oc_e51a research session (Xiaomi war room, graham+marks, 8.5 hours) showed what decays over a long session: per-turn session-log analysis found zero catchphrases, zero historical analogies, and zero identity anchors across the whole session, roughly half of the roles' output in bare ops-report language (「台账已登记」「派手」「归队」 register), and signature-term density collapsing to zero in data-verification rounds. The register pull came from the moderator's own task messages — after round 1 every turn prompt was research-ops phrasing, and nothing re-anchored the persona. The persona text itself was not the bottleneck (the voice assets live in the persona files and, after the books-side embodiment @import fix, load with the prefix); the missing piece was a per-turn surface that keeps the persona reachable while the turn register pulls the other way.

## Decision

`askRoleInternal` — the one shared path for serial `ask`, plain `gather` broadcast, and research gather — appends a fixed one-line persona re-anchor after the question (and after the ledger pointer, so it is the freshest instruction in the message): `chatroomRoleAnchorPrompt()` exported from `chatroom-persona.ts` (「以你的人设作答——用你的签名框架与声口，别让研究运营腔替你说话。」). Engine-side anchoring was chosen over prompt-side so all three turn types carry it deterministically, with no dependence on moderator-LLM discipline, and the stable system-prompt prefix stays untouched.

## Alternatives considered

**Teach the moderator priming to include an anchor in its question text** — no engine change. Lost: the enforcement point would be the moderator LLM itself, and the oc_e51a evidence shows the moderator is the entity that drifted into ops register after round 1; anchoring would be inconsistently phrased and eventually dropped.

**Re-register a persona summary into the system prompt mid-session** — strongest signal position. Lost: persona sections are `complete: true` sections registered at session start; mid-session re-registration invalidates the stable prefix (KV-cache) and has no natural trigger point mid-turn. The turn message is the surface that actually reaches the role every round.

**Engine stays silent; rely on persona files alone** — the books-side fix (embodiment/MAP now in the @import chain, voice section loaded) delivers the voice assets, but a one-shot injection still decays into a distant prefix over 8 hours of ops-register turns; per-turn anchoring is the counterweight the files cannot provide.

## Consequences

Bought: every moderator→role turn re-states the persona anchor, so long research sessions keep the role's voice reachable without touching the stable prefix. Cost: one short fixed line per role turn message — it lengthens the message history, not the persona prefix (README token-effect section updated). Live verification signal for the next chatroom: voice trio (historical analogy / catchphrase / identity anchor) present, and no zero-density data-verification rounds.

## Testing

`tests/engine/engine-chatroom-gather.spec.ts` 「role-turn persona anchor」: serial ask injects the anchor line into the injected role turn; gather broadcast carries the same anchor on every role turn. Package suite green except the pre-existing steward timing flake (verified failing identically on a stashed clean baseline).
