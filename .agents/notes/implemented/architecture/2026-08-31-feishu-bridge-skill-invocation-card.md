# Agent Note: surfacing slash-gesture skill loads on the tool-process card

Status: implemented

English | [中文](2026-08-31-feishu-bridge-skill-invocation-card.zh.md)

## Problem

A skill reaches a session through two paths with different card visibility. When the model invokes the `skill` tool, the progress card shows a `📚 <name>` entry (tag plus the per-turn 「📚 技能：」 summary line) because `parseSkillToolUse` relabels that tool call. When the user types a `/<name>` gesture, tool-skill's pre-step listener injects the skill body as a synthetic user message (durable source `{kind: 'skill-invocation', name}`) with no tool call at all — and the dsh adapter projected that source to nothing, so the load was invisible on the Feishu tool-process card. Users misread the missing icon as a load failure (observed live: `/explain` in a spawned group, 2026-08-31). The dsh web client already projects `skill-invocation` messages with a skill-name label; the Feishu card was the only surface hiding them.

## Decision

Project the injection through an honest channel event instead of faking tool activity. `EventKind` gains `skill_invocation` (content = skill name, matching the durable source's `name` field); the adapter's `projectSessionEvent` `user/message` case pushes it for `source.kind === 'skill-invocation'` with a non-empty string name. The interactive loop renders it as a `ProgressEntry` with `skillName`, preset `hasResult`/`success`, and the locale-owned `SkillLoaded` result line, flowing through the existing `appendProgress` pipeline — seq assignment, `addSkillName` summary accumulation, and the `📚` tag rendering all come for free with zero `streaming.ts` changes. The spillover and relay switches treat the kind as a card-only frame like `subagent_status`.

## Alternatives considered

- **Adapter fabricates a `skill` tool_use/tool_result pair** (parses through the existing relabel for identical visuals). Rejected: the engine's tool accounting — `toolCount`, active-call balance, generation spans — would record a context injection as real tool activity; a typed union gains one honest member more cheaply than the event stream learns to lie.
- **Summary line only, no entry row.** Rejected: the missing artifact users noticed was the `📚` entry row; a footer line alone is weaker parity with the model-invoked path.
- **Do nothing.** Rejected: the load already costs the same tokens either way (the injection exists regardless); only its visibility was at stake, and the web client had already established the projection precedent.

## Consequences

Token-neutral by construction: card bodies never re-enter model context, and the model-visible inputs (catalog reminder, injected skill body) are byte-identical to before. One extra Feishu card PATCH per slash-skill turn at most, riding the existing flush cycle. Subagent child sessions stay unaffected (`projectSubagentEvent` ignores `user/message`), and resume/replay cannot duplicate the row because `session/event` fires only for live appends — the same premise the recent-turns window relies on. Future card-only event kinds should follow this pattern: typed kind in `EventKind`, projection in the adapter, rendering case in the interactive loop, no-op cases in the text-only switches.
