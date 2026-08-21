# Agent Note: Guard snapshot refresh output before committing it

Status: implemented

English | [中文](2026-08-21-snapshot-refresh-transient-capability.zh.md)

## Problem

A full `DSH_SNAPSHOT=refresh` run of the acp-agent snapshot suite rewrote `examples/acp-agent/tests/snapshots/code-mode-read-image/stdout.expected.jsonl` with `promptCapabilities.image: false`, while every replay run before and after — including two later full refresh attempts — produces `image: true`. The one-off `false` was a transient, not a behavior change, yet the refreshed fixture passed validation and would have been committed as a fabricated capability regression.

`supportsAcpImagePrompts` ([`packages/acp/acp/src/content.ts`](../../../../packages/acp/acp/src/content.ts)) reports `false` on every transient miss: the `attachments` or `llm` service not yet in the store when the ACP `initialize` handshake runs, or `resolveModelInfo` throwing into its `catch`. Under full-suite load the probe lost that race once. The refresh write-back ([`packages/test-support/acp-snapshot/src/suite.ts`](../../../../packages/test-support/acp-snapshot/src/suite.ts)) writes the current output and then compares against what it just wrote, so a transient value passes refresh validation and lands in the fixture; the corruption only surfaces on the next replay run.

## Decision

Treat refresh output as untrusted until diffed: after any `pnpm run test:snapshot:refresh`, review the fixture diff before committing, and treat changes to initialize-time values — `promptCapabilities`, protocol version, agent info — as suspect until a plain replay run confirms them. Mechanical churn (raw UUIDs the comparator normalizes) is safe to drop or keep. The upstream repositories have issues disabled, so this note is the durable record of the hazard; revisit if the capability probe ever fails loud or the refresh flow gains a semantic-diff guard.

## Alternatives considered

**Fix the race in the capability probe.** Making `supportsAcpImagePrompts` retry or fail loud on transient service unavailability would remove the root cause, but the failure was observed once in four full-suite runs and never reproduced in isolation, so a blind fix cannot be proven by a failing test and risks changing handshake semantics upstream owns.

**Add a refresh-mode semantic-diff guard.** Refusing to rewrite fixtures whose `promptCapabilities` changed would have caught the incident, but it encodes a field allowlist into shared test-support code for a hazard with one observed occurrence; the manual diff review covers the same ground without the fork carrying speculative upstream divergence.

## Consequences

The cost is a manual review step after every refresh run, and a transient that lands between the diff review and the commit still slips through. What it buys is protection against silently committing fabricated behavior changes during exactly the runs — post-merge syncs — where fixture churn is expected and a wrong value is hardest to notice. The incident also validated the attribution pattern used here: replay the failing suites on a pre-merge worktree before calling a post-merge failure a regression.
