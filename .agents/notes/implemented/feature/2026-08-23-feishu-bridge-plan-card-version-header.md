# Agent Note: Plan card header shows a version identifier

Status: implemented

English | [中文](2026-08-23-feishu-bridge-plan-card-version-header.zh.md)

## Problem

The plan card header title was derived from the plan-file basename ([cwd-slug stripped](../../archived/bug-fix/2026-08-22-feishu-bridge-plan-card-title-strips-cwd-slug.md)), so it repeated the card body's first `# heading` in slugified form — one card showed the same subject twice, and the derivation added truncation and character-replacement drift on top. The title was also hardcoded Chinese (`计划·`), bypassing the bridge's five-language i18n, while the reserved i18n keys `plan_content_header` / `plan_content_header_revision` carried markdown-styled values with no consumer at all.

## Decision

The header carries only a version identifier; the plan's own title lives in the card body. `Engine.planCardTitle(revision)` (`engine/engine.ts`) returns the localized bare header (`Plan` / `计划`) for the first presentation and the `(v%d)` variant from the second on, and both `sendPlanContent` and `sendInlinePlanContent` title their cards through it. The two i18n keys hold plain card-header text in all five languages (card headers render no markdown), `sendInlinePlanContent` lost the `filePath` parameter that existed only for the old title derivation, and `planCardName` (`engine/plan-file.ts`) was deleted. On-disk plan-file naming from [plan-file persistence](2026-08-21-feishu-bridge-plan-file-persistence.md) is untouched: the `-YYYYMMDD-HHMMSS` revision suffix stays on disk, and coexisting plan cards are told apart in chat by `(vN)`.

## Alternatives considered

**Keep the basename-derived, cwd-slug-stripped title.** Lost: the header still duplicates the body's first heading semantically, and the user ruled the duplication not worth an at-a-glance subject. Supersedes the archived strip note above.

**Show the full on-disk basename.** Lost: the only added information is the cwd-slug prefix, zero-information noise in a chat already bound to one project workdir; the title words would still duplicate the body.

## Consequences

Cost: the header alone no longer identifies the backing plan file — the export button delivers the content, and revisions are distinguished by version number instead of the on-disk timestamp. Bought: no duplicated subject on the card, a header that localizes with the session language, and two reserved i18n keys with their first consumer.

## Testing

`tests/engine/plan-file.spec.ts`: card-title assertions through a stub card platform for both send paths at revision 1 and 2, pinning the localized bare header (en) and the `计划 (v2)` variant (zh); the `planCardName` cases were deleted with the function.
