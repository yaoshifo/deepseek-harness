# Agent Note: chatroom user-profile injection and the research clarify stage

Status: implemented

English | [中文](2026-09-03-chatroom-user-profile-and-research-clarify.zh.md)

## Problem

Chatroom sessions had no channel for user background. Roles, the moderator, and direct-role sessions run as bare personas — a `complete: true` section replaces the assembled system prompt and the adapter suppresses cwd instruction injection — so project CLAUDE.md/AGENTS.md content and any memory-index section never reach them, and role personas are static per-role identity files. Research mode additionally had no clarification stage: the plain chatroom priming runs a 3-round user clarify loop, but the research priming went straight to the data-needs list, so per-run user context entered only through the topic text and mid-run interjections ([mid-run participation](2026-09-02-feishu-bridge-chatroom-midrun-participation.md) fixed discoverability, not background).

## Decision

Two shipped mechanisms; both are content-level — no engine, tool-schema, session-event, or persistence changes.

- **`userProfile` config field** (chatroom plugin `defaults` + per-project `projects`, `~` expanded, `''` opts out of a shared default): a plain-text file read at persona assembly and appended to every chatroom bare-persona prompt as a `## 用户背景（服务对象）` section after the role persona — roles, the moderator, and direct-role 1:1 sessions alike, research and non-research identically (one injection point, `decorateSessionStartOptions` → `buildChatroomSystemPrompt`). Research assistants and the data steward get no injection; roles carry the relevant background into their assistant task text. Unset → the prompt is byte-identical to before. Blank file → the section is skipped. A file deleted mid-run → a warned skip at the next persona assembly (a running chatroom keeps its already-assembled prompt).
- **Startup referent gate**: `/chatroom` (every path — topic pick, role pick, direct, multi-role) and the tool's `start` action check the configured file first through `chatroomUserProfileError`; unreadable fails loud (i18n `chatroom_user_profile_unreadable`, the path inlined) instead of silently dropping the background from every persona.
- **Research clarify stage** (priming text only): a bounded preface before the data-needs stage — a plain gather asks each role what user background/constraints/goals need clarifying (2-4 multiple-choice suggestions, or 无需追问); the moderator merges them into one `ask_user_question` card; answers are noted into the ledger synthesis as 「用户背景与约束」 so every role reads them next round. At most 2 rounds, then remaining questions are recorded as assumptions. The injected profile is the baseline — only gaps relevant to the topic are asked. A clear topic plus a sufficient profile may skip the stage entirely. The plain chatroom's 3-round clarify loop is untouched.

## Alternatives considered

**Per-session preset composition (`dsh-agent-presets`) for per-chatroom capability/background**: mounting agent-presets in the bridge profile re-keys every bridge session's composition onto the preset system (a default preset becomes required), and bare personas replace the assembled prompt anyway, so prompt-level injection would still need its own path. The need is content, not composition — a file folded into the existing persona assembly is the minimal mechanism.

**`@import` the profile into each role's CLAUDE.md**: zero code, but every role file needs the import line, the moderator and direct-role personas need their own, and one edit must touch N files. A config field naming one file is the deployment-owned equivalent with a single home.

**Reuse the plain chatroom's clarify loop shape in research (3 rounds, no baseline, no skip)**: research already spends minutes-level rounds before a 30-60-minute steward prefetch; a 2-round cap with skip-when-sufficient keeps the pipeline moving while the persistent profile covers the common case.

## Consequences

- The profile text is duplicated into every role and moderator persona (N+1 copies per chatroom); deployments keep the file concise. The clarify stage delays the steward prefetch by up to two minutes-level gathers plus the user's answer time — accepted because background shapes what data is needed.
- In auto mode the clarify card has no timeout fallback and waits for the user (the same exposure the plain chatroom's clarify loop and the wrap-up card carry); in manual mode the research-manual 10-minute whole-ask auto-default answers it with the default options. Both are recorded in the package README's Known Limitations.
- Behavior is pinned by the new specs: config resolution (`~` expansion, project-over-defaults, `''` opt-out), persona injection (present after the role persona; skipped on unset/blank/missing), policy wiring (role and moderator personas carry the text; the research assistant's subtask options do not), both startup gates (the command replies the i18n message and spawns nothing; the tool's `start` throws it), and the priming texts (the clarify stage precedes the data-needs stage; the plain loop keeps its 3-round cap). Keyless recorded-session snapshots stay blocked for the chatroom surface — the corpus has zero chatroom cases (carried from the 2026-08-31 scan3 round).

## Related

- [Research data reliability](2026-08-27-feishu-bridge-research-data-reliability.md) and [research data dedup](2026-09-02-chatroom-research-data-dedup.md) own the sourcing and fetch-ledger disciplines of the same priming.
- [Mid-run participation](2026-09-02-feishu-bridge-chatroom-midrun-participation.md) owns the interjection channels the clarify stage complements.
