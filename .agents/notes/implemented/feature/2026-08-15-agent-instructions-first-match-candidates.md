# Agent Note: First-match instruction candidate selection

Status: implemented

English | [中文](2026-08-15-agent-instructions-first-match-candidates.zh.md)

## Problem

`@deepseek-ai/dsh-agent-instructions` loaded every existing entry of `instructionFileCandidates` in each project directory and collapsed only per-directory trimmed-content duplicates ([workspace context](../../implemented/feature/2026-06-24-workspace-context.md); `packages/context/agent-instructions/src/config.ts` and `src/files.ts` own the semantics). A deployment could not express a preference order: with the default `['AGENTS.md', 'CLAUDE.md']`, two sibling files with different content both rendered, and no ordering suppressed the later one.

The cc-connect bridge profile (the `dsh-cc-connect-bridge` repository, outside this tree) hit this on 2026-08-15. It wants `CLAUDE.md` to win wherever both files exist and `AGENTS.md` to keep serving projects that carry only `AGENTS.md`. Configuration could not say that, so the profile pinned `instructionFileCandidates: ['CLAUDE.md']` and every project with only an `AGENTS.md` silently lost its project instructions.

## Decision

The validated `agent-instructions` config field `candidateSelection: 'all-existing' | 'first-existing'` selects per-directory candidate selection, applying the same rule to `instructionFileCandidates` and `localInstructionFileCandidates`. The default `all-existing` keeps the load-everything behavior byte-identical, including per-directory content dedup.

Under `first-existing`, each directory contributes at most one file per list: the earliest candidate that is present (regular file, final-component symlink followed, same probe as `all-existing`) loads, and later candidates in that directory are skipped regardless of content. Dedup still runs, so a base-list winner and a local-overlay winner that share trimmed content collapse to the earlier one. Reconciliation re-runs the directory-level winner determination on every pass: deleting the preferred candidate promotes the next existing sibling, and creating a preferred candidate removes a previously loaded sibling. `workspaceBaselineIdentity` carries the field, so a mode flip supersedes a visible baseline on resume. The user-global `$DSH_HOME/AGENTS.md` slot is outside candidate selection and unchanged.

The requesting deployment configures `['CLAUDE.md', 'AGENTS.md']` with `first-existing` (and `['CLAUDE.local.md', 'AGENTS.local.md']` for overlays).

## Alternatives considered

**Keep `['CLAUDE.md']`-only and symlink `CLAUDE.md → AGENTS.md` in AGENTS.md-only projects.** Rejected as the durable answer: it mutates one unrelated project tree at a time, forever, and every new AGENTS.md-only project repeats the manual step with no signal when it is missed.

**Ship the default `['AGENTS.md', 'CLAUDE.md']` and rely on content dedup.** Rejected because dedup collapses only identical content; genuinely different siblings still double-inject, which is exactly the cost the requesting deployment refuses.

**Filter injected instruction messages from a sibling plugin in the bridge.** Rejected: `agent-instructions` owns selection where it composes its projections; intercepting assembled messages from outside re-implements the decision where it cannot be enforced and races the projection queue.

**Hardcode a filename alias list inside the package.** Rejected: tool-specific aliases baked into code are a hidden default; selection policy belongs in explicit, validated configuration.

## Consequences

A directory holding both `CLAUDE.md` and `AGENTS.md` renders only `CLAUDE.md` under the requesting profile, while AGENTS.md-only projects keep their instructions; the default behavior is unchanged for every other deployment. Reconciliation sensitivity widens: under `first-existing`, a change to any candidate in a directory can change which file wins, so directory re-selection probes every watched candidate rather than only the previously loaded one, and the baseline-excluded fast path that skips re-probing deduped siblings does not apply in this mode. The field exists for deployments that must rank tool-specific filenames; if ecosystems converge on one instruction filename, it goes dormant with no removal trigger.

## Testing

Unit tests in `packages/context/agent-instructions/tests/agent-instructions.spec.ts` cover first-existing selection per list, overlay independence, promote-on-delete, suppress-on-create, and the mode-flip baseline replacement; the pre-existing suite passes unchanged, pinning `all-existing` byte-identity. The keyless snapshot `examples/headless-agent/tests/workspace-context-resume.snapshot.ts` exercises both paths through a real Loader composition: a mode flip supersedes the seeded baseline, and a created preferred candidate suppresses the loaded sibling on resume.
