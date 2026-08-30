# Agent Note: feishu-bridge tool-progress tag color carries the call status

Status: implemented

English | [中文](2026-08-30-feishu-bridge-tool-tag-status-color.zh.md)

## Problem

Every tool row on the streaming Tool Process card ended with a status emoji: 🟢 success, 🔴 failure, 🟡 running, and a fixed 🟢 on thinking rows. The emoji repeated on every row and occupied a channel the row already had — the colored `text_tag` on the tool name. Since the per-family icon subdivision (a0c1bf027c), each tag encoded its family twice: once in the icon (💻 📝 🔍 🤖 🌐 …), once in the color (blue/turquoise/purple/orange). The color channel was redundant and free to carry the status instead.

## Decision

`ProgressEntry.render` derives a `ToolCallStatus` (`'running' | 'success' | 'failed'`) from `hasResult`/`success` and threads it into the tag: `toolTagForProgress` takes a new optional third parameter (default `'running'`, so the exports-face signature stays backward compatible) and the skill-tag branch goes through the same `tagColorForStatus` mapping. A settled result takes `green` (success) or `red` (failure); a running entry keeps its family color. The trailing status emoji is gone from tool rows and thinking rows.

Family identity stays readable through the icon on every row and, while a call is in flight, through the family color — the running row is simply the one that is not green or red. `green`/`red` are used by no family, so settled and running colors never collide. Skill entries take the status color on their 📚 tag the same way. `markCompleted`'s terminal finalization flips pending rows green, matching the old 🟢-for-finalized semantics. Registration-time declarations ([`declareToolFamily`](../architecture/2026-08-27-feishu-bridge-chatroom-service-events.md)) still color running rows of sibling-plugin tools.

## Alternatives considered

**A dedicated running color (yellow), retiring family colors entirely.** Rejected: color would carry one semantics only, but every running row would look alike and the family color — still meaningful mid-turn — would vanish from the card; yellow also sits visually close to the orange family. Keeping the family color for running rows lets "not green/red" itself signal in-flight, with no extra color vocabulary.

**A colored dot tag replacing the emoji.** Rejected: it moves the trailing mark one glyph left without removing it; the ask was to drop the trailing status mark.

## Consequences

Settled rows show a green or red tag; the in-flight call is the row still in family color. Parked cards keep their pending rows in family color forever — the old rendering showed an eternal 🟡 there, the same "never settled" meaning with no new state. Red-green colorblind users lose nothing relative to the emoji scheme (🟢 vs 🔴 was equally indistinguishable). Thinking rows lose their fixed 🟢, which never reflected a real success. Known limitation: after a turn settles, the family is readable only from the icon, not the color — icons are the single family channel on settled rows.

## Testing

`tests/streaming.spec.ts` `tool tag status colors`: success renders a green tag, failure red, a result-less entry keeps its family color, skill tags take the settled status, thinking rows carry no status emoji; the `toolTagForProgress` status-override case table pins the third parameter against the default; the markCompleted finalization test asserts green tags. `tests/engine/engine-subagent-card.spec.ts` pins the settled child row and the terminal-finalized parent row both rendering green tags.
