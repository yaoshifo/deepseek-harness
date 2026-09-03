# Agent Note: chatroom role cross-run memory discipline

Status: implemented

English | [中文](2026-09-03-chatroom-role-memory-discipline.zh.md)

## Problem

The chatroom tool description promises role agents "accumulated memory": each persona workdir resolves to one per-role project memory directory (dsh-memory, `~/.claude/projects/<slug>/memory/`), so the same persona accumulates memories across chatrooms. The channel was reachable but unused — chatroom personas are `complete: true` whole-prompt replacements, which drops the dsh-memory strategy section from the system prompt, and no chatroom prompt text mentioned memory; roles could discover the `memory_*` tools only through their schema descriptions. Production mining (2026-09-03, Mac deployment): 7 role project directories, zero `memory/` subdirectories — no role had ever written a memory.

## Decision

One prompt-level addition in `chatroom-persona.ts`, no engine/schema/session-event/persistence changes: exported `chatroomRoleMemoryPrompt()`, appended by `buildChatroomSystemPrompt` when `isRole || isDirect` (research roles inherit it through the base role contract; the moderator and assistants carry none). The discipline states: every chatroom resolves the same persona to the same memory directory whose index is injected at session start; write a memory the moment a durable judgement forms — analysis paths validated as effective, user-confirmed preferences and constraints, stance evolution on recurring topics; `memory_write` then `memory_index`; only reusable judgements, never per-run chatter, skip when nothing durable. Write-now rather than write-at-end because the end barrier drains in-flight replies and tears down sessions without a final role turn — roles cannot detect closure.

## Alternatives considered

**Restore the dsh-memory strategy section into complete personas**: importing `MEMORY_PROMPT` into the persona assembly would duplicate the long memory-management strategy into N+1 personas per chatroom; the discipline names only what a chatroom role needs (when to write, what to keep) in one short block.

**Wrap-up-time writes**: instructing roles to save at chatroom end assumes a closure signal that never arrives — no final role turn exists and the end barrier only drains in-flight replies.

**Moderator memory discipline**: out of scope — the moderator's workdir is the chatroom home shared across all its chatrooms, a cross-chatroom orchestration domain rather than per-persona identity memory.

## Consequences

- Every role and direct-role session grows by one short fixed prompt block; the package README's model-experience, token, and Known Limitations sections state it alongside.
- Compliance is prompt-level convention, measurable only by re-mining session logs against the recorded zero-write baseline; the acceptance signal for later rounds is `memory/` directories appearing under role project directories after live chatrooms.
- Pinned by the new specs: role, research, and direct personas carry the discipline; the moderator persona does not; the discipline text pins the write-now and no-chatter semantics.
- Keyless recorded-session snapshots stay blocked for the chatroom surface (the corpus has zero chatroom cases — carried from the 2026-08-31 scan3 round).

## Related

- [Claude memory global scope](2026-08-25-claude-memory-global-scope.md) owns the memory plugin's scope design this discipline rides.
- [Chatroom user profile and research clarify](2026-09-03-chatroom-user-profile-and-research-clarify.md) shares the persona-assembly injection surface.
