# Agent Note: The feishu-bridge render fork suppresses workspace instruction injection

Status: implemented

English | [中文](2026-08-26-render-fork-suppresses-instructions.zh.md)

## Problem

The plan/reply render fork (`renderQuery` → `oneShotQuery`) replaces its system prompt wholesale via the `complete: true` setup hook, but nothing suppressed the `agent-instructions` channel: the fresh render session still received the workspace instruction baseline (user-global `~/.dsh/AGENTS.md` plus the project CLAUDE.md discovered from the adapter cwd) as `<system-reminder>Instructions from: …</system-reminder>` user messages — roughly 49 KB per render on the live profile. The chatroom bare persona already calls `agentInstructions.suppress()` for the same isolation reason (Go `--bare` parity); the render fork, the other wholesale-prompt-replacement session, did not, an asymmetry rather than a deliberate choice.

The injected files are static workspace rules (coding conventions, git policy, communication style). They carry no task facts: the render fork is a fresh session with no parent history, and its content facts travel only in its prompt (html_path plus the plan-markdown / plan-rendered-html block). So the tokens bought no accuracy — they were pure input cost on every plan render and every speculative reply render.

## Decision

`buildCompletePromptSetup` (the setup hook shared by every `complete: true` registration) calls `agentInstructions.suppress()` alongside registering the section, mirroring the chatroom bare persona in the same file. The render session keeps its working tools — it needs `write` to place the body fragment; its only tool restriction is the global `skill` deny that drops the `<available_skills>` catalog (the render skill body is baked into the system prompt; see [oneshot bare side queries](2026-08-26-oneshot-origin-bare-side-queries.md)). Suppression registers an effect on the render agent's own scope and unwinds when the session is disposed; baseline injection and fs-touch-driven dynamic updates both stay silent.

## Alternatives considered

- **Keep the injection, treat it as cheap context.** Rejected: the injected rules contain zero task facts, and they are coding-agent instructions (commit discipline, reply-depth selection) that only add noise against the render skill's 300-character budget and diagram-only-relations rules.
- **Suppress at the `renderQuery` call site instead of inside `buildCompletePromptSetup`.** Rejected for now: the hook has exactly one caller, and "wholesale prompt replacement ⟺ silent instruction channel" is the invariant worth stating once. If a future complete-prompt caller does want instructions, move the suppression into the render-specific path — the JSDoc on the hook names this ceiling.
- **Feed the render fork richer parent-conversation context instead.** Rejected: accuracy comes from the plan-markdown / plan-rendered-html block, and the render skill's design is an overview-only digest of content already delivered in the chat; full-context forks would scale input cost with session length for marginal gain.

## Consequences

- Render requests shrink by the workspace-instruction baseline (~49 KB / ~12k tokens on the live profile: 8 KB global AGENTS.md + 41 KB project CLAUDE.md), with no content loss — the render output is a pure function of the render system prompt and the task prompt.
- Render sessions no longer see project coding conventions at all; if a future render skill wants project domain knowledge, it must be passed explicitly in the prompt rather than discovered from cwd.
- The render fork's cwd still defaults to the adapter's configured project workdir (`oneShotQuery` uses `cfg.cwd`), which now only affects tool execution and temp-path layout, not instruction or memory discovery (`origin: 'oneshot'` keeps the memory index off too).
