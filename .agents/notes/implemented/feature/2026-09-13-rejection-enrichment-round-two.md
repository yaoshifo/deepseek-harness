# Agent Note: Rejection-enrichment extended to edit match failures, write unread-overwrite, and skill unknown

Status: implemented

English | [中文](2026-09-13-rejection-enrichment-round-two.zh.md)

## Problem

After the [edit unread-rejection content attachment](2026-09-13-edit-unread-rejection-content-attachment.md) shipped and was verified live, the remaining model-visible surfaces were surveyed under the same criterion (a rejection the model cannot heal without another information round). Three same-shaped frictions were confirmed: `edit`'s `FS_EDIT_NOT_FOUND` carries zero clues and `FS_AMBIGUOUS_EDIT` reports only a count without locations (the model cannot write a more specific old_string without re-reading); `write`'s unread overwrite of an existing file still heals in three rounds; `skill`'s unknown error is entirely unhealable (nothing says what is available). `read`'s out-of-range offset error already carries the total (leave as the reference example); the bash sandbox denial's blocked path is unavailable above the backend, deferred.

## Decision

Three independent landings sharing the pattern's four elements (attach the healing information, perform the healing side effect, fail sharper where possible, fall back byte-for-byte):

- **edit match failures** (`packages/fs/fs-local/src/fsio.ts`): the ambiguity error lists each match's starting line number with that line's original text (first 10 with the total when more); not-found probes with old_string's trimmed first line and lists up to 3 candidate lines verbatim — indentation preserved so whitespace differences are visible — or falls back to the exact old message when no candidate exists. Error codes are unchanged; the callers-branch-on-the-code contract documented in the README is unaffected.
- **write unread-overwrite** (`packages/fs/tool-fs/src/write.ts`): edit's `enrichNotObserved` moved to the shared `src/unread-attachment.ts` (verb-parameterized: `retry the edit/write directly`, `cannot edit/write "…": not found`) and wired into write's catch. The attached window also shows the model exactly what it is about to replace — a data-loss guard.
- **skill unknown** (`packages/skill/tool-skill/src/index.ts`): the error lists up to 3 closest model-invocable skill names plus the total; case-insensitive containment wins (alphabetical), otherwise the alphabetical first three, and `no skills are available in this session` when the list is empty. The inventory comes from `ctx.skills.list` at the same scope and lookup — the session-visible set — and only invocable names are suggested.

## Alternatives considered

**A shared fuzzy-matching helper.** Rejected: "closest" means different things at each site (edit distance vs substring containment vs line probe); ten deterministic lines per site beat a shared abstraction, with no new dependency.

**Attaching the full file on not-found (like the unread rejection).** Rejected: by the time edit matches, the model has read the file (policy-guaranteed), so the full window is already in context; what is missing is "the lines that most resemble old_string now" — line-level candidates carry more information per token than a full window.

## Consequences

- Each site heals one round faster; skill unknown goes from unhealable to a one-step correction.
- Every message is bounded (≤10 match locations, ≤3 candidate lines, ≤3 skill names); no-candidate and empty-list cases fall back byte-for-byte or degrade explicitly — worst case no worse than before.
- Upstream-sync note: the two fsio.ts message templates and the tool-skill diagnostic are this fork's additions; if upstream edits those error lines, keep the enrichment segments through the merge.

## Testing

fs-local `filesystem.spec.ts` adds 4 cases (ambiguity locations, >10 capping, not-found candidates, byte-identical fallback); tool-fs `integration.spec.ts` now asserts the attached content on write's unread-overwrite plus a direct-retry-succeeds case (372 green); tool-skill `tool-skill.spec.ts` adds 3 cases (substring suggestion, alphabetical fallback, empty list — 35 green). Package-level oxlint/tsc clean; no snapshot coupling (fs-policy-reject locks only the edit unread message; A/C messages have no snapshot references).
