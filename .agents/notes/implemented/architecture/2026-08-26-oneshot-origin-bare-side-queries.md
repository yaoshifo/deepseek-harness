# Agent Note: The oneshot session origin keeps side queries bare

Status: implemented

English | [中文](2026-08-26-oneshot-origin-bare-side-queries.zh.md)

## Problem

feishu-bridge side queries — group naming (Go LightweightQuery), predict-next, turn summary, monitor triage, and the plan/reply render fork — run as fresh one-shot dsh sessions whose whole task context travels in the prompt. The session assembly nevertheless injected every cwd-derived ambient block into them: the workspace instruction baseline (agent-instructions), the project memory index (claude-memory, keyed by the adapter cwd — the project's main workdir, never a `/spawn -d` override), the `<available_skills>` catalog, the full base system prompt, and even an LLM title request for the throwaway session. A live group-naming query measured ~16.4k input tokens for a 14-token answer. Worse than the cost: a `/spawn -d books` group was renamed 拉取RiskAI最新代码 because the naming fork assembled in the riskai project cwd and the injected riskai memory index resolved the first message's 「这个项目」 to RiskAI — the task session itself had correctly run in books and pulled books' code.

## Decision

- dsh-session and dsh-agent widen the coarse `SessionHeader.origin` union with `oneshot` (the header validator accepts it; a new value on an optional field, no format bump). The origin marks a short-lived self-contained side-query session.
- Context-injection policy routes on origin: claude-memory skips index injection for every origin-carrying session (previously subagent-only, so index injection now targets plain sessions exclusively), and session-title skips automatic LLM title generation for oneshot sessions (the local fallback title stays — it makes no model request).
- The feishu-bridge adapter creates lightweightQuery and renderQuery sessions with `origin: 'oneshot'`. lightweightQuery runs bare: a one-line complete system prompt replaces the assembled baseline (buildCompletePromptSetup keeps the wholesale-replacement ⟺ silent-instruction-channel invariant the render note owns), and `tools.restrict({ allow: [] })` masks every tool — the skill catalog disappears with the tools, and the per-project MCP mask folds into that single deny-all restriction instead of registering a second one. renderQuery denies only the global `skill` tool (the render skill body is baked into its system prompt; `write` and the other working tools stay) and keeps the MCP mask as a separate restriction.

## Alternatives considered

- **Per-plugin suppress seams for memory and titles** (new services mirroring `agentInstructions.suppress()`). Rejected: two new seams plus a function-plugin→service restructure, where the existing origin field already routes exactly this policy at creation time.
- **Passing the spawn workdir into the naming fork.** Rejected: once the query is bare its context is prompt-only — no memory remains to misresolve 「这个项目」, so the workdir plumbing would buy nothing.
- **Reusing origin `subagent` for one-shots.** Rejected: it misrepresents the session (no parent delegation) and couples title/memory policy to delegation semantics.

## Consequences

- Naming, predict-next, turn-summary, monitor-triage, and render requests shrink to their prompt plus a minimal system prompt; a naming request drops from ~16.4k input tokens to ~1k, and group names stop inheriting the project-main-cwd context (a `/spawn -d books` group now gets a content-based name).
- Every session carrying an origin gets no memory index, so a future origin value inherits the skip by construction; plain interactive sessions are unaffected, and all existing `origin === 'subagent'` readers (subagent lineage, client runtime, UI) match exactly — old logs replay unchanged.
- Ceiling: a future lightweight-query caller that needs tools or cwd context must not opt into bare — it needs its own toolFilter or a forkQuery-style seeded session instead.

## Testing

`tests/agent-dsh/adapter-oneshot.spec.ts` pins the bare lightweight composition (origin, one-line complete section verbatim, instruction suppression, `allow: []`) and the render skill deny with its absent-registration fallback; `tests/agent-dsh/adapter-mcp-mask.spec.ts` pins the folded deny-all mask and the render fork's two coexisting restrictions; dsh-session, claude-memory, and session-title package tests pin the origin validation and both injection gates.

## Related

[The render fork suppresses workspace instruction injection](2026-08-26-render-fork-suppresses-instructions.md) owns the complete-prompt-replacement invariant this note builds on.
