# Agent Note: v2→v3 migration admits the dsh-memory source kind; dsh-memory scenario advances to v3

Status: implemented

English | [中文](2026-09-13-v2-to-v3-admits-dsh-memory-source.zh.md)

## Problem

Upstream introduced Session v3 on 2026-09-06 (`f7a6221158`/`705f84f952`) and advanced 122 snapshot fixtures in bulk, but the fork-private `snapshots/acp/dsh-memory` scenario was not in the upstream tree and was skipped. Digging deeper showed this was not "add one file": the scenario's v2 fixture carries user messages with `source.kind: "dsh-memory"` (the memory plugin's recall reminder, with a plugin invariant enforcing that kind's package ownership), and the v2→v3 migration's message-source audit list (`SOURCE_KINDS`) does not know it — refused by design with "cannot safely transform unclassified message source". The chain: llm-replay throws while parsing the fixture at plugin load → never registers the `deepseek-official` adapter → acp `session/new` fails `NO_ADAPTER` → the secondary "persistence flush failed" replaces it as `Internal error`. The same root cause surfaces statically as corpus's v2≠v3 and pinning's system-prompt count 0≠1 (v3 promotes system prompts into messages).

## Decision

- `packages/session/session-format-v2-to-v3/src/payload.ts`: add `'dsh-memory'` to `SOURCE_KINDS` (a fork extension, marked in a code comment and both READMEs). Justification: the source's members are all scalars (`version`/`scope`/`digest`), carry no in-session references, and pass-through migration needs no interpretation of them — the same latitude the agent-message relay channel takes; v3's native validation (core/session) only requires a non-empty string kind for user messages, and the production bridge has been writing this kind all along.
- `snapshots/acp/dsh-memory`: produce `session.v3.jsonl` through the official refresh channel (`DSH_SNAPSHOT=refresh`, the v2 input restored via the fixed migration and replayed, 18.8KB), incidentally refreshing the stale `tool-schemas.expected.json` to the current schema (upstream plan-tool description drift, unrelated to this change).

## Alternatives considered

**Rewriting the plugin's source kind (e.g. normalizing to `plugin`).** Rejected: the plugin's invariant requires retaining the package-ownership kind, and it would break source attribution in existing v2/v3 logs; a one-member admission in the migrator is far smaller.

**Hand-writing the v3 fixture.** Rejected: authored fixtures are detail-heavy and error-prone; the refresh channel exercises the real migration+replay pipeline, so its output is its own verification.

**Waiting for upstream admission.** Rejected: upstream has no dsh-memory plugin and will not admit the kind; the fork extension lands with minimal surface (one list member, a comment, two doc sentences), keeping upstream-sync conflicts negligible.

## Consequences

- All three dsh-memory failures (corpus, pinning, the scenario replay's RequestError) turn green; `test:snapshot` locally has only the sdk bash-tool environmental failure left (host lacks a sandbox backend, handled separately).
- Unknown source kinds stay refused by migration (the `custom-source` case keeps rejecting); the list's semantics are not loosened — only this one fork-owned kind with audited scalar members is admitted.
- Upstream-sync note: the SOURCE_KINDS line in `payload.ts` and the two fork-extension README sentences are this fork's only additions; if upstream ever edits that list, keep the `dsh-memory` member through the merge.

## Testing

New `admission.spec.ts` case: a v2 user message with the dsh-memory source migrates, members pass through unchanged, and restore does not throw (red first, then green). Package suite 520 green (including the preserved `custom-source` rejection); session-format-catalog 26 green; acp snapshots + corpus 21/21 green.
