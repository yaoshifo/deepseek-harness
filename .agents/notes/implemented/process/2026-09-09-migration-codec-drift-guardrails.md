# Agent Note: Migration codec snapshot drift guardrails

Status: implemented

English | [中文](2026-09-09-migration-codec-drift-guardrails.zh.md)

## Problem

Released migration codecs (`session-format-v0-to-v1`, `session-format-v1-to-v2`) validate historical session logs against hand-written schema snapshots. A snapshot is written after its generation retires, yet it must cover every field extension the old writer added while still current. No source of truth in the repository records that window: the writer's event types have since evolved, and CI fixtures are hand-written by the same authors as the snapshot, so fixture and schema share one blind spot.

On 2026-09-09 this drift surfaced as a user-visible failure: a `/fk` fork silently lost its parent context because the parent's v0 log was refused mid-migration. Measured against the production sessions root, five field extensions the v0-era writer committed were never absorbed by the snapshot — `todo/write` item `activeForm`, header `origin: 'oneshot'`, `permission/preset` member `origin`, `approval/decided` outcome `allowed-always`, and `subagent/descriptor` version 2 — leaving 1726 of 2856 historical-generation logs unreadable (fork seeds lost, resume failing). The feishu-bridge fork fallback additionally swallowed the refusal into a misleading "no seedable turns" warn (fixed separately in the adapter).

## Decision

Historical v0 sessions are abandoned as a recorded accepted loss (user ruling 2026-09-09): the five snapshot gaps stay unfixed, including the v0-to-v1 header whitelist that 078313831b left narrower than its v1-to-v2 sibling. Three guardrails ship instead:

1. **Production scan** — `.agents/skills/feishu-session-log-triage/scripts/scan-migration-drift.mjs` runs the current build's migration decode over every historical-generation log under a sessions root and fails loud with a per-reason refusal report. It is the only check whose truth source is the committed data itself. It resolves the catalog from this repository's build output, so it always exercises the codecs this checkout would deploy.
2. **Pinned refusals** — the five drift shapes are pinned as refusing test cases in `session-format-v0-to-v1` (`tests/validation.spec.ts`, `tests/codec.spec.ts`), annotated with the ruling. A partial snapshot fix cannot land silently; repairing the snapshot means flipping those cases to acceptance together.
3. **Snapshot authoring rule** — any future generation's codec schema (v3+) must be validated against, or generated from, a full production scan of the previous generation's logs before it ships. Writing a snapshot from memory or from current source is what produced the drift.

Run the scan after every daemon reload that may change the session-format packages, and before authoring any new-generation snapshot.

## Related

The adjacent-migration mechanism itself — version-named successor generations, never rewriting committed ones — is owned by [released session format migrations](../architecture/2026-08-31-released-session-format-migrations.md). This note adds the authoring-side constraint that mechanism left open: a snapshot written after retirement must be grounded in the retired writer's committed data, not in current source.

## Alternatives considered

**Repair the five snapshot gaps.** Would restore 1726 sessions, but the value concentrates in 1330 one-shot question sessions; the user ruled the remaining working sessions not worth the repair. Revisit only if a session on the refusal list becomes needed — the pinned cases name every shape to fix.

**Generate snapshots from historical git checkouts.** The writer's format at any moment is derivable from git history, but the extraction is fragile (merge-order, backports) and the generator itself becomes a second hand-written schema. A production scan measures the same property directly.

**A CI fixture gate for committed-data drift.** CI cannot reach production data, and static fixtures reproduce the same-author blind spot; they pin known regressions only, which the pinned refusal cases already do.

**Hooking the scan into `reload.sh`.** Automatic coverage, but it lengthens the deploy path and couples an owner-local diagnostic to the deploy script. The scan stays a manual step at the two trigger points above.

## Consequences

A future v3 snapshot has an independent, data-grounded verifier, and the current accepted loss is pinned and named rather than implicit. The cost: v0 historical sessions stay permanently unreadable; the scan requires a built checkout (`pnpm run build`) before it runs; and both guardrails depend on the process being followed — the reload checklist and any v3 work must carry the scan step.
