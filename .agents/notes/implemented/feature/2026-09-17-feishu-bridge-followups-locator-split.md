# Agent Note: Followups options split the plain-language card text from the executing locator

Status: implemented

English | [中文](2026-09-17-feishu-bridge-followups-locator-split.zh.md)

## Problem

A closing followups option's `description` served two readers at once: the user reading the suggestion card to decide what to check, and the executing agent reading the dispatched `[后续处理]` message to find the code. Every prompt layer (the tool description, the per-parameter schema text, the agent-conventions section) mandated the engineering format — `path:line` plus a one-sentence action — so the card the user saw was dense with file paths and mechanism vocabulary, unreadable without opening the code, and the check decision it existed to carry could not be made.

## Decision

The two audiences got separate fields. `UserQuestionOption` carries an optional `locator`, and the `feishu_bridge_followups` schema asks for three single-purpose inputs: `label` (plain-language title), `description` (plain language only — problem, action, cost, for a non-coder), `locator` (`path:line` for the executing agent).

Distribution is structural, not conventional:

- The live card (`buildFollowupsCard`) and the settled card (`buildFollowupsCardSettled`) map options by explicitly picking `label`/`description`/`checked` — `locator` never enters a card face.
- The dispatched selection message (`followupsSelectionMessage`) is the locator's only exit: `settledOptionMarks(..., includeLocator = true)` appends a `📍 path:line` line to each **checked** option (unchecked options carry none — the dispatch is an instruction for the authorized items only).
- The tool's `execute` passes `args.options` through wholesale, so there is no second construction path to keep in sync.

## Alternatives considered

- **Prompt-level two-part format** (description = plain-language body with the `path:line` in a trailing parenthesis). Rejected: it bets format reliability on the model sustaining a composite format inside free text. This tool's own history is the counterexample — the narrowed schema exists because models dropped the re-typed `question`/`id` fields ~3 attempts/day, while option contents were never malformed. Simple fields are reliable; composite free-text formats are not. The card would also still show the locator.
- **Renderer-side stripping of `path:line` patterns from descriptions.** Rejected: the user complaint is illegibility (function names, mechanism vocabulary), not merely the locator being visible; stripping it leaves the terminology problem unsolved, and pattern-matching locators out of prose is fragile in its own right.
- **Pure plain language with no locator at all** (the executing agent re-locates from the finding text). Rejected: execution quality would depend on re-search, wasting the location the closing agent already knew, and it deletes an existing capability of the dispatch for no gain.

## Consequences

- Both card faces are structurally locator-free — a guarantee of the explicit field-picking in the renderers, not of prompt discipline. Turning the option mapping into a spread would break it; the `followups locator separation` describe in `tests/engine/followups.spec.ts` pins it.
- Registrations persisted before this change (followups meta JSON without `locator`) dispatch without `📍` lines and keep working — a degradation to the old behavior, not a failure.
- `UserQuestionOption` mirrors the Go `UserQuestionOption`; the TS↔Go correspondence now carries one more optional field. Followups questions are constructed inside the bridge and never cross the Go wire.
- The model may still write a path into `description` out of habit; the tool description forbids it explicitly and the `locator` field absorbs the location content. Residual drift is watched live (acceptance: of the first cards after reload, ≥2/3 read without code knowledge and carry no path or identifier on the card face).
- Testing: `tests/engine/followups.spec.ts` (`followups locator separation` describe — dispatch carries checked-only `📍` lines, legacy registrations dispatch without them, both card faces never render the locator), `tests/tools/followups-tool.spec.ts` (locator survives the conversion into the registered question), `tests/agent-dsh/adapter-persona.spec.ts` (conventions text updated).
