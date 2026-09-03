# Agent Note: The feishu-bridge suppression registry mounts through an insert row

Status: implemented

English | [中文](2026-09-03-feishu-bridge-suppression-row-never-mounted.zh.md)

## Problem

The bridge bundle patch registered `agent-instruction-suppression` with an id-targeted entry (`- id:` plus `name:`, no `insert:`). `applyEntryPatches` resolves non-insert entries against rows already in the composed tree and skips an entry whose id matches nothing — it never adds a row — and dsh-base does not define that row (installed 0.1.2-alpha.2 and workspace 0.1.2-alpha.3 both checked). The [suppression registry](../architecture/2026-09-07-agent-instructions-suppression-host-plane-service.md) therefore never mounted, and both adapter call sites no-op through optional chaining: bare-persona sessions and every complete-prompt one-shot query (render forks, group naming, predict-next, turn summary, monitor triage) kept full workspace-instruction injection, with cwd-ancestor AGENTS.md/CLAUDE.md entering sessions whose system prompt had been completely replaced.

The defect stayed invisible through two days of live operation. The boot path applies bundle patches inside the root Include before any logger exporter exists, so the loader's `patch: entry "agent-instruction-suppression" not found` warning reaches no output; the `/reload` preflight captures `--dump-config` stderr in `feishu-bridge-config-check.err` but prints it only when the dump fails. `tests/bundle-patch.spec.ts` collected composition warnings yet asserted emptiness only for the plan-mode, ask-user, and dsh-memory rows.

## Decision

The row is an `insert` entry — the same form the patch uses for `tool-ask-user` and `dsh-memory`, the other rows base does not ship — and `@deepseek-ai/dsh-agent-instructions` is a declared bridge dependency so non-link installs resolve the row's package. The bundle-patch spec asserts the row exists under its id and name and that no warning names it. Resolution needs no profile change: bare plugin names in patch rows resolve from the running CLI's installation anchor, the live daemon runs the workspace `apps/cli` build, and the `/suppression` subpath resolves to the workspace package there; the registry-pinned copies under the profile's `node_modules/.pnpm` are unused transitive weight.

## Alternatives considered

**Add the row to dsh-base and keep the id-targeted entry.** The registry is a bridge-only host-plane capability; base mounting it would publish the service for every base-backed profile, including the web preset compositions the serviceless-plugin shape exists to protect.

**Make the engine fail loud when an id-targeted entry matches nothing.** Shared overlays legitimately address trees that lack some rows — per-entry warnings are the documented `parsePatchList` contract — so throwing would break every patch layer's semantics. The skip behavior is correct; the defect was the entry form.

## Consequences

After `/reload`, bare-persona and complete-prompt sessions stop receiving workspace-instruction injection: persona contracts stay free of cwd-ancestor files, and render forks no longer carry the project's full instruction files as dead prompt payload. Two observability gaps remain open: boot-time patch warnings still reach no output, and `/reload` still surfaces the preflight stderr only on failure — diagnosing a silently skipped patch row means re-reading `feishu-bridge-config-check.err` after a dump. The spec's row-existence assertion is the regression pin for this row's form.
