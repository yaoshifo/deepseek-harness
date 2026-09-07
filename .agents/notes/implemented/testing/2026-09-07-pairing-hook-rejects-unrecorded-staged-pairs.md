# Agent Note: the cached pairing check rejects a completely staged pair without its record

Status: implemented

English | [中文](2026-09-07-pairing-hook-rejects-unrecorded-staged-pairs.zh.md)

## Problem

The `--cached` hook mode of `verify-translation-pairing` filtered its anchors down to pairs whose `.i18n.yaml` record already exists in the index — by design, corpus completeness (a staged pair with no record at all) stayed with doc-sync. On the fork's dev branch doc-sync is policy-skipped, so nothing ever caught a new bilingual pair committed without its record: five such gaps accumulated silently (found while clearing the full-corpus check on 2026-09-07), including one written the same day by the agent itself — the failure mode is ordinary omission, not exotic.

## Decision

The index-mode filter keeps its semantics for recorded pairs, but a new branch rejects a pair whose BOTH language sides are staged while its record is absent (`verify-translation-pairing.ts`): the error names the source, explains pairs-merge-whole, and points at the fix (`verify-translation-pairing --write <source>` then stage the sidecar). A single staged side without a counterpart stays skippable exactly as before — the hook still does not police one-language edits; only the commit that merges the pair whole must carry the record. The lefthook glob already covered `.agents/notes/**` (the skip previously seen was the separate archived-notes job), so no hook config change was needed.

## Alternatives considered

- **Extending lefthook's pairing glob or adding a notes job.** Rejected: the glob already includes notes; the gap was in the script's index-mode anchor filter, not the hook wiring.
- **Dropping the filter entirely (hook enforces full corpus completeness).** Rejected: it would reject routine one-language staged edits that doc-sync legitimately owns on upstream, breaking the documented division of labor for a fork-local pain.

## Testing

`verify-translation-pairing.spec.ts` gains two hook-mode cases over the fixture git repo: a completely staged `feature/new-note` pair without the record exits 1 naming the source and the `--write` fix; the same pair with the record in the index passes. The five pre-existing cases (stale hash either side, out-of-corpus skip, single-side no-record skip, three-file deletion) stay green, and the full corpus check still reports 1358 pairs consistent.

## Consequences

A commit that stages both languages of a new pair now fails fast at pre-commit until the record joins the same commit — on a fork without doc-sync this is the only gate at that moment. Upstream behavior narrows identically (the branch is unconditional), which matches the pairs-merge-whole rule the corpus check already enforces; if upstream prefers the old hook/doc-sync split, the branch can move behind a flag at absorption time. Cost per hook run is one existence probe per staged anchor.
