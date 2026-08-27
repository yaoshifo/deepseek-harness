# Agent Note: chatroom research assistants carry hard data-reliability constraints

Status: implemented

English | [中文](2026-08-27-feishu-bridge-research-data-reliability.zh.md)

## Problem

In a research-mode chatroom, the pre-provisioned assistant children are the only participants that actually fetch online data, yet their assembled prompt (report preamble plus `subtaskResearchAssistantPrompt`) carried workdir, no-chart, and source-attribution discipline with nothing about source quality: which sources may ground a conclusion, how many sources must confirm a number, and what to do on discrepancy or missing data. The one authoritative-data clause that existed (the safety floor's "only multi-source-verified or authoritative-institution data for time-sensitive facts") rides the bare-persona path (role / moderator / direct sessions), which assistant children never see, and neither dispatch surface (the gather research prefix, the moderator round-1 task template) relayed it. The agent hitting the network was the one participant unconstrained on source reliability.

An investigation of the production commodity-research project (`~/workspace/production`, skill `commodity-supply-research`) showed reliability there is a six-layer mechanism — source registry with primary-source priority, quantified cross-validation, audit trails, honest gap handling, scripted validation gates, independent recomputation. The layer transferable to a prompt-only, infrastructure-free assistant is the operational discipline.

## Decision

- `subtaskResearchAssistantPrompt` gains one hard-constraint bullet (「只用权威一手数据」): conclusions (values, shares, rankings) come only from authoritative primary sources — official statistics, international organizations, regulators, primary papers; secondary citations (media, encyclopedias, aggregators) only locate primary sources and never ground conclusions. A key number needs either two mutually independent corroborating sources (an upstream aggregate of downstream officials is the same data chain, not independent) or sum-closure back to its parent total. Cross-source discrepancies are attributed (definition difference, timing misalignment, publication lag) or explicitly downgraded — never silently picked. Missing data is reported as missing; no low-quality stand-ins, no fabrication.
- The report bullet's annotation extends from source + fetch date to include a per-number confidence grade (high/medium/low) and an explicit unverified/gaps list.
- Both dispatch surfaces relay the requirement so roles demand it from their assistants: the gather research prefix (`chatroom.ts` `gatherRoles`) and the moderator round-1 task template (`chatroom-priming.ts` `buildChatroomResearchModeratorPriming`) each carry one data-reliability sentence.
- Role-side prompts are unchanged: the safety floor already binds role, moderator, and direct sessions.

## Alternatives considered

**A one-line "use authoritative sources" instruction.** Rejected: the production investigation showed the enforceable content is the four operational rules — primary-only, independence-or-closure, discrepancy attribution, honest gaps. A one-liner gives the model no decision procedure for conflicts or missing data, which is where fabricated or low-quality numbers enter.

**Inject the safety floor into every subtask child.** Rejected: the floor addresses sessions that are not coding agents; assistant children need the assistant-specific rules (independence, closure, report grading) rather than the floor's phrasing, and their preamble is the seam that already carries their contract.

**Port the production infrastructure (source registry, validation scripts, recomputation).** Rejected for this change: chatroom research assistants are domain-generic; the registry and scripts are domain assets. A per-domain skill carrying its own registry remains the upgrade path if a chatroom settles on one domain.

## Consequences

Each research-assistant session carries roughly 120 extra prompt characters. Assistants now hold a decision procedure for the dominant failure mode — plausible but wrong online data — instead of after-the-fact traceability alone; reports gain confidence grades and explicit gap lists the synthesizing moderator can weigh. The constraints are prompt-level: no gate mechanically rejects a non-primary source, the same enforcement posture as every other persona contract.

## Testing

`chatroom-persona.spec.ts` asserts the constraint markers on the registered research-assistant section; `engine-chatroom-gather.spec.ts` asserts the research gather prefix carries the relay clause and the round-1 priming template carries the data-reliability sentence. Both suites (50 tests) pass.

## Related

[Research assistants keep cwd discovery; the workspace moved instead](../bug-fix/2026-08-25-feishu-bridge-research-assistant-workspace-relocation.md) owns the assistant prompt-assembly seam this note builds on.
