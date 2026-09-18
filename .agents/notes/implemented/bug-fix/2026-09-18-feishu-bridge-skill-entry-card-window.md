# Agent Note: Fill the skill entry's input line and keep the model envelope off the card

Status: implemented

English | [中文](2026-09-18-feishu-bridge-skill-entry-card-window.zh.md)

## Problem

The tool-process card renders every tool entry as a five-line code block — one input line, a `---` divider, and a three-line result window — because the card's block area must keep a constant height across PATCHes and as entries rotate in and out (`padToFixedLines`, `minCodeBlockLineWidth`).

A model-invoked `skill` call puts the skill name in the header tag (tail-truncated to 16 characters) and leaves only the call's optional `args` as the entry body. A call without `args` therefore rendered the input line as a 100-column run of spaces, and the result window showed the first two lines of the model-facing envelope — `<skill_content name="…">` and `<skill_resources>` — plus an overflow marker. The entry read as a broken card and carried no usable information: reproduced 2026-09-18 on the live profile (`08:44:07 📚 -pre-push-checks · 1`, `... (138 more lines)`).

## Decision

- The entry factory leaves the skill name in the entry body when the call carries no `args`, so the input line always carries the call's own input. The full name also becomes readable there, which the header tag cannot do at more than 16 characters.
- `ProgressEntry.resultNotice` carries replacement text for the result slot; `render` shows it instead of the payload only for a successful result. The engine sets it to `Msg.SkillLoaded` on every entry whose `skillName` is set (the `tool_use` arm), and the `/<name>` gesture arm sets the same field, so both skill paths render one shape: input line / divider / notice.
- A failed load keeps its payload. The skill tool throws on an unknown, invalid, or non-model-invocable name, the adapter reports `toolSuccess: false`, and the diagnostic text stays visible in the result window under the red tag.
- The five-line block is now pinned by tests for three shapes (tool with input, skill without args, skill with args) — the invariant had no test, only code and comments.

## Alternatives considered

- **Drop the input line and the divider for entries with no input** (a three-line block). Rejected: the fixed five-line block is what keeps the card's block area from jumping, and the entry height would then vary by entry shape.
- **Substitute the notice inside `updateToolResult`.** Rejected: the `/<name>` gesture entry never passes through that method, so the identical visual would come from two different fields.
- **Parse the `<skill_content>` envelope to preview the skill's own instructions.** Rejected: it couples the bridge to a text format owned by `packages/skill` and degrades silently when the envelope changes, and the instruction payload is model-facing material, not card content.

## Consequences

- A skill call without args renders the full skill name on the input line; the header tag keeps its tail truncation, which remains an open presentation question.
- A successful skill load settles to one status line instead of the envelope's two boilerplate lines; failed loads render exactly as before.
- Block height and width behaviour are unchanged: five lines per entry, first line padded to `minCodeBlockLineWidth`.
- The notice is locale-owned (`Msg.SkillLoaded`), so no new copy was introduced and the English profile reads "Skill instructions loaded".
- Every other tool's entry is unchanged. A non-skill tool called with an empty input string would still render a blank input line; no such call exists in practice (argument-less calls carry `{}`).
- Live effect requires the operator's `/reload`; rollback is a revert of the commit.
