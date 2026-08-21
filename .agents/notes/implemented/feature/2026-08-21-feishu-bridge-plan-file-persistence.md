# Agent Note: Plan-file persistence — the bridge writes presented plans to ~/.claude/plans

Status: implemented

English | [中文](2026-08-21-feishu-bridge-plan-file-persistence.zh.md)

## Problem

A dsh plan existed only as the `exit_plan_mode` tool call in the session log — no standalone file record like Claude Code's `~/.claude/plans/*.md`. The bridge's Go ancestor bridged Claude Code itself, whose plan mode writes those files (the engine's `Write`-into-`.claude/plans/` substring tracking and the plan-render sibling-HTML logic both grew around them). On dsh sessions that read path is dead — nothing instructs the dsh model to write a plan file, and dsh plan mode restricts writes anyway — so the plan card ran entirely off the inline `plan` argument and no durable, browsable plan library accumulated.

## Decision

The engine persists the plan itself, deterministically, at presentation time: in the ExitPlanMode card branch (`engine.ts`), when no model-written plan file path is known and `planDir` is non-empty, `savePlanFile` (`engine/plan-file.ts`) writes the full untruncated markdown into `planDir` and the written path becomes `activePlanFilePath`, so the card is sent from the file and plan-render HTML lands next to it. Naming follows Claude Code's observed behavior: `<cwd-slug>-<title-slug>.md` where the cwd slug is the project workdir (`getWorkDir()` probe, `process.cwd()` fallback) and the title slug reuses `slugifyTitle`/`extractMarkdownTitle` (CJK preserved, matching the Go-era files already in the directory). A same-name file holding different content gets a `-YYYYMMDD-HHMMSS`-suffixed sibling — revisions never overwrite; identical content leaves the file untouched. `projects[].planDir` configures the directory (default `~/.claude/plans`, `~` expanded; `''` disables). A write failure logs a warning and falls back to the inline card; the turn never breaks. A model-written plan file still wins and is never rewritten.

## Alternatives considered

**Instruct the model to write the plan file (true Claude Code mechanism).** Lost: dsh plan mode is read-only for the workspace, so the harness would need a plans-directory write exemption in core, and delivery depends on model compliance — nondeterministic for the one artifact users treat as the durable record.

**Persist plans in a dsh core plugin.** Lost: `dsh-plan-mode` is deliberately log-only, non-surface state; the plan UX (cards, export, HTML render) is the bridge's domain, and a core file sink would need a directory-policy decision that only this consumer needs.

**Overwrite the same-name file on revision.** Lost: Claude Code keeps a timestamped sibling instead, and the earlier revision is exactly what a user wants to diff after rejecting a plan; overwriting also makes the "identical content" skip impossible to distinguish from a destructive rewrite.

## Consequences

dsh plan records and real Claude Code plan records share one library, disambiguated per project by the cwd slug — the unified-library upside, with the trade-off that the directory's agent provenance is implicit. The record exists from presentation (before approval), so rejected plans leave files too, exactly as Claude Code leaves them. Filenames use the project workdir at presentation time; a `/dir` switch mid-session names the next plan after the current workdir, not the original one. Timestamps are local-clock, and same-second same-name collisions overwrite the timestamped sibling — accepted for parity and atomicity (`atomicWriteFileSync` guarantees no torn file).

## Testing

`tests/engine/plan-file.spec.ts`: helper naming/revision/dedup/dir-creation cases, plus event-loop integration — presentation writes the file with the full plan, `planDir: ''` skips persistence, a model-written `.claude/plans` file is never overwritten and wins the card, and an unwritable directory falls back to the inline card without throwing.
