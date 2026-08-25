# Agent Note: claude-memory global scope — a cross-project second memory directory, on by default

Status: implemented

English | [中文](2026-08-25-claude-memory-global-scope.zh.md)

## Problem

Claude Code's memory mechanism is strictly per-project (`~/.claude/projects/<slug>/memory/`), and the dsh compatibility plugin mirrored that exactly. But some facts a session learns are not project facts — the daemon sandbox blocks the macOS keychain so `git push` reports `gh token invalid` on any repository; the user's working-style feedback holds everywhere. The only cross-project channel, the global instructions file (`~/.claude/CLAUDE.md`), is human-curated and always fully injected, which suits principles but not accumulating fragments: the user wanted pitfall-grade memories shared across projects without turning the instructions file into a changelog.

## Decision

**A second memory directory, not a new mechanism.** The global scope reuses the whole memory apparatus — file format, frontmatter, MEMORY.md index discipline, the five tools, atomic writes — against `<claudeHome>/memory/` instead of a per-project slug directory. Claude Code never reads that path, which is acceptable in this fork because the deployment is migrating off Claude Code; project scope stays byte-compatible with it either way.

**On by default; the config is the opt-out.** The global scope ships enabled: every deployment gets the `## Global memory` appendix, the global index injection, and the `scope` tool parameter without configuration. `global: { enabled: false }` disables it completely (no appendix, no second injection, no parameter, and a stray `scope: 'global'` fails loud). The global budgets inherit the project ones, so a composition's single explicitly stated budget governs both scopes; overriding only the global numbers tightens (or loosens) the noise cap for globally injected content. This default was flipped from the original opt-in design the day it shipped — the deployment owner wanted cross-project memory without per-composition configuration, and every composition already declares the inherited budget explicitly, so the budget-discipline invariant survives. Schemastery quirks shaped the schema: an absent nested object arrives as `{}`, and nested `required()` fields are enforced even when the outer key is absent, so `apply` resolves the default-on semantics from the (possibly empty) object and rejects a non-positive explicit byte budget at load.

**The model picks the scope at write time; guidance sits on the three surfaces nearest the decision point.** The `## Global memory` prompt appendix carries a one-question test (*would this memory still be useful in a session for an unrelated project?*) with `When unsure, choose project` as the fail-safe default — the costs are asymmetric: too narrow only misses recall elsewhere, too broad injects noise into every future session. The `scope` parameter description restates the test where the model reads it, and the global index frame header names the cross-project semantics on every recall.

**No scheduled promotion; lazy re-filing instead.** A periodic project→global promotion pass was rejected: it re-judges semantics with less context than write time, its event rate (a handful of memories per machine-month) does not justify a standing LLM scan over every project directory, and unattended writes into globally injected content bypass the human gatekeeping that keeps the global layer trustworthy. The same needs are covered by the write-time rule (new memories), a lazy rule in the prompt — re-file a project memory the moment cross-project demand is observed — and a one-time backfill audit of the existing stock after deployment, with the user confirming each promotion.

**Source marker versioned to 2, per-scope dedup.** `ClaudeMemorySource` gains `scope` and makes `project` conditional; `hasMemoryInjection` and the invariant companion dedupe per scope, so a session can carry one project and one global injection. Version-1 injections in old logs read as project scope for dedup, but the invariant rejects them as stale — the pre-release stance accepts refusing old on-disk formats rather than carrying a compat shim.

## Consequences

Global injection precedes the project injection (stable identity first), each under its own `<system-reminder>` frame and budget. `memory_write`/`memory_index` apply their own scope's budget to its MEMORY.md; the two budgets do not interact. Global-scope tool calls require only an owning session — no POSIX cwd, no slug — so a cwd-less session still reads and writes global memory; project scope keeps its slug guard. A `scope: 'global'` argument reaching a global-less deployment fails loud in `resolveCall` rather than silently routing to the project directory (the open parameter root would otherwise swallow the unknown key). Concurrency on the global directory stays last-write-wins, now with every dsh session on the machine as the writer population. The `examples/acp-agent` claude-memory snapshot covers both injections and a scope=global write/index round-trip; the package tests pin the prompt anchors, the per-scope dedup, and the Loader-booted composition with disposal.

## Alternatives considered

- **User-level skills directory as the global channel** — zero code and visible to both harnesses, and skill descriptions are indeed an index-plus-lazy-body recall shape. Rejected as the primary answer because skills are trigger-shaped workflow instructions, lose memory semantics (types, provenance, dedup), and the decision to stop using Claude Code removed the only argument for its compatibility.
- **Promoting into the global instructions file** — always-on full injection of fragments, exactly the noise profile the user was avoiding; the file stays for human-authored principles.
- **Hard validation restricting global writes to `user`/`feedback` types** — the canonical motivating memory (the keychain pitfall) is an environment fact, not cleanly either type; "is it cross-project" is a semantic judgment code cannot make, consistent with the plugin's existing prompt-discipline-over-schema-enforcement stance.
- **A promotion pass run by cron** — rejected for the reasons above; the upgrade path, if misfiling proves common, is an on-demand audit skill, not a scheduler.
