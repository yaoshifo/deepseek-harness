# Agent Note: dsh-memory subagent tool gate

Status: implemented

English | [中文](2026-08-31-dsh-memory-subagent-tool-gate.zh.md)

## Problem

The package README states all three model-visible surfaces are gated to top-level POSIX-cwd sessions ("subagents get none"), but the gate existed only in the system-prompt section renderer (`origin === 'subagent'`) and the injection listener (any origin value). The five tools were registered on `ctx.tools` with no origin check, and a subagent child inherits its parent's tools unless a composition configures a `toolFilter` ([child-agent.ts](../../../../packages/subagent/subagent/src/child-agent.ts)), so a subagent with a POSIX cwd could execute `memory_*` calls. It would run them without the memory strategy section — no index discipline, no "what not to save" rule — and with a worktree cwd its writes would land in an ephemeral worktree-slug directory no session ever reads. The unit tests asserted the section's absence for subagents but never exercised the tools.

## Decision

`resolveCall` — the single entry every tool `execute` passes through — rejects a subagent-origin agent before scope resolution, throwing `memory tools are unavailable for subagent sessions`. This mirrors the section's gate exactly, covers both scopes in one place, and leaves the agentless-caller error untouched. Enforcement sits in the operation that makes the decision, consistent with the package's other execute-time gates (cwd-less, non-POSIX cwd, disabled global scope). Oneshot side queries keep tool access: they receive the strategy section, so their tool availability matches the guidance they can see — only the injection excludes them. Two mechanical hardenings ship alongside: the invariant companion's escape check now rejects any literal close-frame tag before the trailing frame close (a mid-body unescaped tag with a normal ending previously passed), and `listMemory` skips a file deleted between the directory read and its per-file stat instead of surfacing the raw ENOENT.

## Alternatives considered

**Schema-level hiding through agent-scoped tool registration.** The ToolRuntime supports per-agent schema visibility, but the package's other session gates are execute-time loud errors; one enforcement mechanism in one place beats two, and a schema-hidden tool still needs the deny path for direct `ctx.tools.execute` callers.

**Gating oneshot origins too.** The injection excludes every origin value, but a oneshot side query still gets the strategy section (its cwd is the project's), so denying it the tools would deny it capabilities its own guidance describes. Left unchanged.

**Registering the memory directory as a sandbox-writable root so generic tools serve subagents.** Rejected earlier by [memory index maintenance](2026-08-17-memory-index-maintenance.md) — under a non-local filesystem provider generic tools would write the wrong machine — and unchanged by this gate.

## Consequences

Unit tests pin the denial on both scopes through the real tool executor, and the README stable-failure lists carry the new error (bilingual). No snapshot change: top-level sessions see no difference and the denial is an error path, a deliberate scope decision recorded here. A subagent that legitimately needed memory access would have its parent relay the call; none has been observed.
