# Agent Note: Bound fs-local edit rejections at the read caps

Status: implemented

English | [中文](2026-09-14-fs-local-edit-rejection-bounds.zh.md)

## Problem

The 2026-09-13 rejection enrichment embedded each match's full line — up to ten matches for `FS_AMBIGUOUS_EDIT`, three candidate lines for `FS_EDIT_NOT_FOUND` — with no length bound. `readForEdit` imposes no size cap (it rejects only NUL binaries), so one broad `old_string` matching inside a minified single-line file assembled a multi-megabyte tool error that flowed untruncated into the model request and the session log, while the same batch's write rejection enforced the read caps.

## Decision

Each embedded line truncates at 2000 chars with the read tool's exact `... (line truncated to 2000 chars)` marker, and `matchStartLine` slices only cap+1 characters so a giant single line is never materialized. The whole `FS_AMBIGUOUS_EDIT` message caps at 50 KiB (`Buffer.byteLength`, UTF-8): the shown list truncates greedily with a `; list truncated` marker while the match count stays exact. The 50 KiB value mirrors `READ_MAX_BYTES` — the existing bound on what a read result injects into the model-request channel — as a local constant with a sync comment, because the dependency direction forbids fs-local from importing the tool-fs constant. The not-found path truncates per line only: three capped lines cannot structurally reach the cap, so the list-truncation branch would be dead code (JSDoc records this). `matchStartLines` counts lines monotonically along the ordered match offsets instead of rescanning from the start per match.

## Consequences

A broad `old_string` inside a minified single-line file now yields a bounded rejection (at most one capped line per match, the list itself capped at 50 KiB) instead of a multi-megabyte model-visible error. The match count and per-line prefixes stay exact, so the model's corrective loop is unchanged; only the embedded evidence truncates. Callers that branch on the error code are unaffected (the codes did not change).

## Alternatives considered

Capping `readForEdit` itself was rejected: an edit needs the whole file content, so the bound belongs on the rejection message, the only artifact that reaches the model. Implementing the list truncation on the not-found path as well was rejected as dead code: three per-line-capped candidates cannot structurally reach the 50 KiB cap.
