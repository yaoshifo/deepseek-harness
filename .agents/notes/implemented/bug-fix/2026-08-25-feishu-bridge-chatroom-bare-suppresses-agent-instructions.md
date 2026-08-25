# Agent Note: chatroom bare personas suppress workspace-instruction injection

Status: implemented

English | [中文](2026-08-25-feishu-bridge-chatroom-bare-suppresses-agent-instructions.zh.md)

## Problem

Go chatroom sessions ran the claude backend with `--bare`, which disabled CLAUDE.md auto-discovery; the persona itself was read by `agent/claudecode/persona_load.go`. The TS port replaced `--bare` with a `complete: true` system-prompt section — but that only replaces prompt **sections**. The `agent-instructions` plugin injects AGENTS.md/CLAUDE.md as `<system-reminder>` blocks on user messages, a channel the complete replacement cannot reach. A real-device `/chatroom --research` run (2026-08-25, session `cc-20260825-071502-8a2df5d28119` and its role/assistant children) showed every chatroom session carrying workspace instructions: a role received the entire ancestor repo CLAUDE.md (~30k chars) plus its own persona CLAUDE.md duplicated on top of the flattened persona in the system prompt, and the research assistants received the moderator contract (`chatroom/CLAUDE.md`: "never pip install, never run analysis scripts") — directly contradicting their research-assistant preamble. The user-global `~/.dsh/AGENTS.md` coding instructions were omitted only by the 64k budget, so the stripping was budget luck, not enforcement.

## Decision

`dsh-agent-instructions` becomes a function plugin mounting the `AgentInstructions` service (the `ui-input-trigger` pattern: namespace `apply` stays, listeners live on the service). The service exposes `suppress()` — a scoped `ScopedLayers` effect modeled on `systemPrompt.suppressRuntimeContext()`: registered through the caller's context (an agent's setup scope binds to the agent via the traceable receiver), it makes `compose()` return `undefined` for any agent covered by the global layer or a marker on its scope chain, which also drops pending workspace contexts from the inbox. The bridge's `buildSessionSetup` chatroom branch (role / direct-role / moderator) calls `agentCtx.get('agentInstructions')?.suppress()` next to registering the persona section — Go `--bare` parity for the instruction channel. Subtask children (research assistants included) keep cwd discovery, matching Go.

## Alternatives considered

**Suppress by reading the systemPrompt assembly's complete-section state.** Rejected: there is no public per-scope query for "has a complete section," and coupling the instruction channel to prompt assembly would fire for any future complete persona, decided by a different owner.

**Filter the persona directory out of instruction-file candidates.** Rejected: the leak is the whole ancestor chain plus the user-global file, not one directory; candidate lists are plugin-global config, and a persona-conditional exception inside file discovery would be an unowned special case.

**Convert the package to a class plugin.** Rejected: both example bundles mount it through the namespace import (`ctx.plugin(workspaceContext, config)`), which the Cordis registry resolves via `{ apply }`; mounting a service from the function body keeps every consumer unchanged.

## Consequences

Chatroom role / direct-role / moderator sessions no longer receive any workspace-instruction reminder: no ancestor repo instructions, no duplicated persona CLAUDE.md, no user-global coding instructions regardless of budget. First-turn history recorded before the persona engaged (the topic-pick and role-pick stages still run as plain sessions, faithfully to Go flag timing) keeps whatever the plain session injected — suppression starts when the chatroom persona does. Sessions whose persona a future deployment composes under a complete section get the same silencing only if they opt in through `suppress()`; the seam is explicit, not inferred. Research assistants still inherit ancestor CLAUDE.md files from the research workspace (Go-faithful); if that cross-contract noise matters, relocating the research workspace out of the moderator home is a product decision recorded here, not taken.

## Testing

`packages/context/agent-instructions/tests/suppression.spec.ts`: scoped suppressor stops the baseline, disposal restores it, a suppressed filesystem touch injects nothing and a post-disposal touch composes the baseline plus nested scope, and an unscoped registration suppresses every agent. `packages/acp/feishu-bridge/tests/engine/chatroom-persona.spec.ts`: moderator and role setups call `suppress()` exactly once; plain and subtask setups never do. Full `dsh-agent-instructions` suite (162 tests), feishu-bridge adapter and persona specs, both example bundles, and the repo typecheck pass. Real-device validation pending the next `/chatroom --research` after reload: role and moderator session logs should contain no `Instructions from:` reminder.
