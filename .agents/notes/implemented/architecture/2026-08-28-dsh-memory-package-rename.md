# Agent Note: dsh-memory package rename

Status: implemented

English | [中文](2026-08-28-dsh-memory-package-rename.zh.md)

## Problem

The memory package shipped as `@deepseek-ai/dsh-tool-claude-memory` at `packages/memory/tool-claude-memory`, with the Cordis plugin name, the system-prompt section name, the composition ids, and the durable message-source kind all `claude-memory`. Two parts of the name misdescribe the thing: the `tool-` prefix suggests a tools-only package, but the package contributes a system-prompt section, a durable session-start injection, and the tools; and the `claude` qualifier names an implementation detail (compatibility with Claude Code's on-disk layout) as the package's identity, when the capability — persistent agent memory — is dsh's own. The durable source kind `'claude-memory'` extended that borrowed identity into the session-log format itself, so every deployment's logs named dsh's memory capability after a foreign product.

## Decision

The package is renamed to `@deepseek-ai/dsh-memory` at `packages/memory/memory` (the group-layout rule that the directory name is the package name minus the `dsh-` prefix; precedent `packages/web/web`, `packages/goal/goal`). The Cordis plugin name, the system-prompt section name, and every composition id become `dsh-memory`. The durable message-source kind and the `MessageSourceMap` key become `'dsh-memory'` with the type renamed `DshMemorySource`; the shape stays `{ kind, version: 2, scope, project?, digest }`.

Identifiers that name Claude Code's own behavior stay: `claudeProjectSlug` encodes Claude Code's on-disk slug rule, and prose that states the sharing relationship ("shared with Claude Code", the compatibility description) remains — those describe the external spec the package mirrors, not the package.

Per the pre-release stance, no compatibility shims: references were updated everywhere (composition profiles, examples, snapshot fixtures, generated catalogs, tsconfig aggregates, the tool-catalog generator).

## Alternatives considered

**Keep the durable kind `'claude-memory'`, rename everything else.** Preserves dedup continuity for logs written before the rename and keeps the kind matching Claude Code's own session-start reminder format. Lost because the kind is the one place the borrowed identity reached durable data — the wire format is precisely where naming should be owned — and because the pre-release stance explicitly prefers the correct foundation over shims. The cost is bounded: see Consequences.

**Name the directory `packages/memory/dsh-memory`.** Breaks the group layout convention that the directory name is the package name minus the `dsh-` prefix, which every other package in `packages/` follows.

**Keep `claude` in the package name (`dsh-claude-memory`).** Retains searchability from the Claude Code compatibility angle but still names the package after the thing it mirrors instead of the capability it provides.

## Consequences

Sessions whose logs were written before the rename carry injections with kind `'claude-memory'`; on resume, `hasMemoryInjection` no longer matches those events, so each scope's index is injected once more into that resumed session (the model sees the stale reminder plus a fresh one). `MessageSourceMap` is merge-extensible, so old kinds fall through the documented default and logs remain readable; `SESSION_FORMAT_VERSION` is unchanged because the `user/message` event shape did not change.

Deployment profiles that link the package must update the dependency name and link path, and because the dependency manifest changes, they need a profile install — a `/reload` alone does not refresh linked-package identities. The invariant companion (`dsh-memory-invariant`) validates new-format injections only; pre-rename injection events in old logs are skipped by its kind filter rather than failed.

## Related

- [Claude Code memory compatibility](../feature/2026-08-14-claude-code-memory-compat.md) — the original package decision whose names this note updates.
- [Memory index maintenance](../feature/2026-08-17-memory-index-maintenance.md)
- [claude-memory global scope](../feature/2026-08-25-claude-memory-global-scope.md)
