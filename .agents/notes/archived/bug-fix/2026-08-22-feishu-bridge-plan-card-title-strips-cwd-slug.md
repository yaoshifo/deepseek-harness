# Agent Note: Plan card title strips the cwd-slug prefix

Status: implemented
Archived: 2026-08-23

English | [中文](2026-08-22-feishu-bridge-plan-card-title-strips-cwd-slug.zh.md)

## Problem

The plan card title was `计划·<plan-file basename>`, and the basename is `<cwd-slug>-<title-slug>.md` — [plan-file persistence](../../implemented/feature/2026-08-21-feishu-bridge-plan-file-persistence.md) aligned the file naming with Claude Code, where the cwd slug exists to disambiguate projects inside the one shared plans directory. Carried into the chat title, the slug of the full project workdir (e.g. `home-hm-workspace-cc-connect-`) led every plan card with ~26 characters of machine noise that carries zero information: a Feishu chat is already bound to exactly one project workdir. The rule was inherited verbatim from Go `engine_send.go`, where the same basename came from Claude Code's own plan files.

## Decision

The card title keeps only the title part. `planCardName` (`engine/plan-file.ts`) derives the display name from the plan-file basename minus `.md` and minus the leading `<cwd-slug>-` prefix when it matches the session workdir; `sendPlanContent` and `sendInlinePlanContent` (`engine/engine.ts`) title their cards through it, passing `planWorkDir()`. The on-disk filename is untouched — the cwd slug still disambiguates the shared plans directory. The `-YYYYMMDD-HHMMSS` revision suffix stays in the title so coexisting revisions remain distinguishable in chat, and a basename that does not start with the workdir slug (a model-written plan file from a worktree session) is returned unchanged. This is a deliberate divergence from Go parity, recorded in `docs/MIGRATION.md`.

## Alternatives considered

**Keep the Go-parity basename title.** Lost: parity is a migration means, not a goal; inside a project-bound chat the prefix is zero-information noise, and the full file name stays one export-button click away for anyone who needs to locate the record.

**Compose the title from the plan heading directly (`extractMarkdownTitle` on the card body).** Lost: two divergent derivations of one title (file name vs. card title), and the timestamped-sibling revision would disappear from the title even when the card was sent from a `-YYYYMMDD-HHMMSS` file.

## Consequences

Cost: the card title no longer equals the on-disk basename, so the title alone does not locate the file; and the TS bridge now differs from Go `engine_send.go` on this one string. Bought: plan cards read as the plan's subject, and worktree-session titles keep their distinguishing workdir slug instead of losing it to a mismatched strip.

## Testing

`tests/engine/plan-file.spec.ts`: `planCardName` prefix-strip, timestamp-suffix-retention, and non-matching-prefix cases; `sendPlanContent` and `sendInlinePlanContent` card-title assertions through a stub card platform, including the generic `计划` title when no file path exists.
