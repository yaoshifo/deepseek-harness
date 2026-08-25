# Agent Note: chatroom research assistants keep cwd discovery; the workspace moved instead

Status: implemented

English | [中文](2026-08-25-feishu-bridge-research-assistant-workspace-relocation.zh.md)

## Problem

Two residues of the coding-scenario stripping work surfaced in review. First, d8107f21b0 suppressed workspace-instruction injection for research-assistant children because their shared workspace (`<moderatorDir>/research`) put the moderator persona — including its "never pip install" contract — on every assistant's cwd-ancestor discovery chain, contradicting the assistant's own pip-install-based job. Suppression was the blunt fix for what was actually a placement bug: research assistants are coding agents, and cwd instruction discovery (including the user-global `~/.dsh/AGENTS.md` discipline) is appropriate for them, exactly as for plain and attended subtask children. Second, the per-round `chatroom_reminder` appended to every moderator wake pointed back at `~/.claude/CLAUDE.md critical self-review` — the global coding instructions file the suppression seam exists to keep out — and the research-role prompt claimed "no coding tools" while the sessions carry the full toolset (only `skill` is denied).

## Decision

- **Relocate, then un-suppress.** `chatroomResearchWorkspace` defaults to `<projectDataDir>/chatroom-research` (derived from the sessions store path; the configured `researchWorkspace` still wins, and a storeless engine has no default). The old `<moderatorDir>/research` default is gone with no migration: existing deployments re-provision the shared venv once at the new location. With the workspace off every chatroom persona's ancestor chain, the research-assistant `suppress()` branch in the adapter is deleted; assistants keep cwd discovery like every other subtask child. The workspace-provisioning failure fallback (assistants run in the role's persona dir) stays: its injected role persona is lower-authority noise, not a hard contradiction.
- **Reminder self-contained.** `chatroom_reminder` replaces the `~/.claude/CLAUDE.md` reference with an inline hint (「先构造最强反例，再点名追问」 / "steel-man the strongest counterargument before pressing"); the critical-press methodology itself moved into both moderator primings (plain: the 按需批判性追问 bullet; research: the round-2 cross-iteration step) so it is paid once per chatroom instead of once per wake.
- **Prompt honesty.** The research-role contract now says "execution goes to your pre-provisioned assistant; you think, decompose, judge" instead of the false "you have no coding tools". Tool surfaces are unchanged (bare personas keep the `skill` deny; roles and moderators keep their tools — a deliberate choice against enforcement-level narrowing).

Bare-persona suppression (moderator/role/direct sessions) is untouched: those sessions are personas, not coding agents.

## Alternatives considered

**Keep suppression, keep the old location.** Rejected: it denied coding agents the coding discipline file (its actual value) to dodge a placement bug, and blocked the legitimate case of instructions that help assistants (output discipline, dependency hygiene).

**Enforce the research role's toollessness with `tools.restrict`.** Rejected by user decision: roles keep their tools; the prompt points execution at the assistant instead of lying about the toolset.

**Keep the reminder's file reference but point it at the chatroom ledger.** Rejected: the reminder rides every wake; methodology belongs in the once-per-chatroom priming, and an inline one-clause hint is enough at wake time.

## Consequences

Research assistants now see the user-global coding instructions and whatever lives in the workspace tree — same injection surface as ordinary subtask children. A daemon restart mid-research re-provisions the venv at the new location on the next chatroom start (one-time reinstall of the base data deps). Old `<moderatorDir>/research` directories are abandoned in place, not migrated.

## Testing

`chatroom-persona.spec.ts`: the research-assistant case flips to asserting cwd discovery is kept for every subtask child. `engine-chatroom-end.spec.ts`: the workspace-default test pins `<projectDataDir>/chatroom-research`, the configured override, and the storeless-'' case. `engine-chatroom-recovery.spec.ts`: the gather-recovery wake asserts no `~/.claude` reference rides the reminder. The five affected suites (persona, end, recovery, venv, assembly-chatroom, 54 tests) and bridge typecheck pass.
