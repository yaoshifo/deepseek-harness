# Agent Note: Pre-commit pairing check covers staged Markdown sides

Status: implemented

English | [中文](2026-09-02-pre-commit-pairing-covers-staged-sides.zh.md)

## Problem

The lefthook pairing job matched only `*.i18n.yaml`, so a commit that staged `foo.md` or `foo.zh.md` without the sidecar never ran `verify-translation-pairing --cached`. Editing one side of a recorded pair without re-recording accumulated silently until a later commit staged an `.i18n.yaml` — typically a merge — and failed on drift it did not cause; the 2026-09-02 dev merge hit exactly this with the feishu-bridge README pair.

## Decision

The pre-commit and pre-merge-commit pairing jobs match `*.{md,i18n.yaml}`, and `--cached` skips an anchor whose `.i18n.yaml` is absent from the index: the hook polices recorded pairs only, while corpus completeness (new pairs, exclusions) stays with doc-sync and CI. Staged sides of a recorded pair follow the existing completeness and hash rules, including partial and complete three-file deletions. `scripts/verify-translation-pairing.spec.ts` covers both directions end-to-end against a fixture index.

## Alternatives considered

**Enforcing corpus completeness in the hook for staged in-scope Markdown without a record.** Rejected: it duplicates doc-sync's corpus job at commit time and turns accepted corpus drift into commit blockers for unrelated edits.

**Filtering unpaired files in a shell wrapper inside lefthook.yml.** Rejected: the glob-and-skip rule lives in one place in the script, where the fixture spec can exercise it.

## Consequences

Drift on a recorded pair surfaces in the commit that causes it instead of a later merge. Every commit staging any Markdown pays one extra script run (about two seconds), and a corpus-wide green remains provable only by doc-sync and CI. Two known corpus drifts were repaired alongside so the widened hook lands on a green baseline: the [2026-08-31-parallel-exploration-default-guidance](../feature/2026-08-31-parallel-exploration-default-guidance.md) pair re-recorded, and the 2026-09-01-feishu-bridge-spawn-mode-flag pair gained its missing record.
