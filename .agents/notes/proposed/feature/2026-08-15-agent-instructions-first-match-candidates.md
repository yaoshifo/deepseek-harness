# Agent Note: First-match instruction candidate selection

Status: proposed

English | [中文](2026-08-15-agent-instructions-first-match-candidates.zh.md)

## Problem

`@deepseek-ai/dsh-agent-instructions` loads every existing entry of `instructionFileCandidates` in each project directory and collapses only per-directory trimmed-content duplicates ([workspace context](../../implemented/feature/2026-06-24-workspace-context.md); `packages/context/agent-instructions/src/config.ts` and `src/files.ts` own the semantics). A deployment cannot express a preference order: with the default `['AGENTS.md', 'CLAUDE.md']`, two sibling files with different content both render, and no ordering suppresses the later one.

The cc-connect bridge profile (the `dsh-cc-connect-bridge` repository, outside this tree) hit this on 2026-08-15. It wants `CLAUDE.md` to win wherever both files exist and `AGENTS.md` to keep serving projects that carry only `AGENTS.md`. Configuration cannot say that, so the profile pins `instructionFileCandidates: ['CLAUDE.md']` and every project with only an `AGENTS.md` silently loses its project instructions.

## Proposal

Add one validated `agent-instructions` config field selecting per-directory candidate selection, applying the same rule to `instructionFileCandidates` and `localInstructionFileCandidates`:

```ts ignore-check
interface Config {
  // existing fields unchanged; default preserves today's behavior
  candidateSelection: 'all-existing' | 'first-existing'
}
```

Under `first-existing`, each directory contributes at most one file per list: the earliest candidate that is present (regular file, final-component symlink followed, same probe as today) loads, and later candidates in that directory are skipped regardless of content. Under the default `all-existing`, behavior is byte-identical to today, including per-directory content dedup; dedup is subsumed under `first-existing` because at most one file per directory and list can load. The user-global `$DSH_HOME/AGENTS.md` slot is outside candidate selection and unchanged.

`workspaceBaselineIdentity` gains the field so resume detects a semantics change, as it already does for candidate-list precedence. The reconciliation scope set already watches every configured candidate name per directory, so the required file events arrive; selection adds directory-level winner determination when reconciling a changed directory.

The requesting deployment then configures `['CLAUDE.md', 'AGENTS.md']` with `first-existing` (and `['CLAUDE.local.md', 'AGENTS.local.md']` for overlays), once a `dsh-base` release carries the field or its profile links a workspace build. The exact field and value names are open; the selection semantics above are the commitment.

## Alternatives considered

**Keep `['CLAUDE.md']`-only and symlink `CLAUDE.md → AGENTS.md` in AGENTS.md-only projects.** Rejected as the durable answer: it mutates one unrelated project tree at a time, forever, and every new AGENTS.md-only project repeats the manual step with no signal when it is missed.

**Ship the default `['AGENTS.md', 'CLAUDE.md']` and rely on content dedup.** Rejected because dedup collapses only identical content; genuinely different siblings still double-inject, which is exactly the cost the requesting deployment refuses.

**Filter injected instruction messages from a sibling plugin in the bridge.** Rejected: `agent-instructions` owns selection where it composes its projections; intercepting assembled messages from outside re-implements the decision where it cannot be enforced and races the projection queue.

**Hardcode a filename alias list inside the package.** Rejected: tool-specific aliases baked into code are a hidden default; selection policy belongs in explicit, validated configuration.

## Acceptance criteria

- With `first-existing`: a directory holding both `CLAUDE.md` and `AGENTS.md` renders only `CLAUDE.md`; a directory holding only `AGENTS.md` renders `AGENTS.md`; a directory holding neither renders nothing; the local overlay pair follows the same rule; `all-existing` output is byte-identical to today's, with existing tests unchanged.
- Live reconciliation: deleting the preferred candidate in a directory promotes the next existing sibling as an updated instruction set; creating a preferred candidate suppresses the previously loaded sibling.
- `workspaceBaselineIdentity` changes when the mode changes, and the resume precedence-change snapshot gains a mode-flip case.
- The config catalog and both package READMEs document the field in the same change, and a keyless snapshot through a real runnable example covers the selection behavior per testing policy.

## Risks

- One more field on a shipped package's config for a single external consumer; if ecosystems converge on one instruction filename, the field goes dormant without a removal trigger.
- Reconciliation sensitivity widens: under `first-existing`, a change to any candidate in a directory can change which file wins, so directory re-selection must consider every watched candidate, not just the previously loaded one.
- The naming will attract bikeshedding; this note fixes the semantics, not the spelling, and the implementing PR settles the name once.
