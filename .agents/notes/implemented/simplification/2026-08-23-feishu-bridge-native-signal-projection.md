# Agent Note: feishu-bridge de-baggage batch 1 — native signals and single-source mechanisms

Status: implemented

English | [中文](2026-08-23-feishu-bridge-native-signal-projection.zh.md)

## Problem

The cc-connect migration preserved Go-era shapes wherever a native dsh equivalent existed, on the grounds that faithful shapes let 700+ Go tests be translated mechanically. After cutover that trade expired, and four mechanisms kept paying interest:

- The adapter's `session/event` projection silently dropped `tool/result` error identity, `todo/write` snapshots, and the compaction lifecycle. The progress card's 🔴 failed-call count and 🗸 compaction count therefore had no producer, and the pinned todo section could only be rebuilt by `JSON.parse`-ing `todo_write` tool arguments.
- `listSessions` returned live sessions only, behind a `TODO(M7)` claiming dsh had no persisted-session listing API — false since `session-persistence` grew `list()`. `/sessions` and `/switch` were blind to every session from before a daemon restart.
- A rollback fork (`/fork` on a quoted message) persisted a truncated copy of the source log (`persistence.create` + `append`) and resumed it, because Go's agent was an external `--resume` process that could only be pointed at a file.
- The render-session prompt inlined a vendored copy of the render skill — a second copy of `skills/` content to maintain — with model-visible prose still addressed to a "cc-connect 内部" session.

## Decision

Each mechanism now uses the native source directly; nothing keeps a Go-shaped side channel.

- **Projection carries the native signals.** `EventKind` gains `compaction` and `todo_update`; `Event` gains `toolSuccess?: boolean` (absent = success, so emitters without failure identity are unaffected). The adapter projects `tool/result.error` as `toolSuccess: false`, `todo/write` as a whole-list `todo_update`, and `compaction/start` as `compaction`. The engine marks the quiet-mode entry red through the real success value, counts compactions on `state.compactionCount` with the i18n summary as a compact progress entry (chat message when no preview card is active, mirroring Go's `EventCompaction`), and replaces the todo section from snapshots. A subagent child's `todo_update` never touches the parent's card — the child's list stays on its own transcript.
- **`/sessions` lists the session store.** `listSessions` merges live sessions with `sessionPersistence.list()`, filtered to top-level sessions (`parentSession` unset) whose `cwd` is the project directory or a descendant (worktrees list; other projects' sessions and per-chat `/dir` sessions outside the tree do not, matching the Go per-cwd store). `enrichSessionSummaries` fills a zero `messageCount` from the SessionManager's capped history (max 100 entries) — summaries were already enriched from there, so persisted rows render with title and count.
- **Fork-at is one seeded create.** `prepareForkAtSession` truncates via `locateForkCut` as before but stages the prefix in an adapter-side map instead of persisting a copy; the `__forkat__<newID>` sentinel consumes it as `agents.create({ sessionId, seed, meta: { cwd, parentSession, seedLength } })`. `seedLength` stays explicit per the [seed-boundary note](../testing/2026-06-22-fork-child-replay-seed-boundary.md). A daemon restart between prepare and start drops the staged seed; the sentinel then degrades to a fresh session with a `console.warn`, the same degradation a sourceless plain fork takes.
- **The render skill has one source.** `skills/feishu-bridge-render/SKILL.md` (frontmatter `disable-model-invocation: true`, `user-invocable: false` — registered, never advertised) is the only copy; the render prompts take the body as a parameter, resolved at fork time from `ctx.skills.get('feishu-bridge-render')`. An empty or missing body fails loud at every layer: the pure prompt builders throw with a deployment pointer, the render entry points reject, and the orchestration IIFE pre-checks, logs, marks the render card failed, and skips retries — the markdown card remains the user-visible fallback, but there is no silent empty-prompt render. The prefetch-into-prompt approach stays (it saves a model round trip); only the body's source changed.
- **Model-visible text drops the cc-connect brand.** The sender-injection prefix renders `[feishu-bridge sender_id=…]`; the render-session prompt and skill body address a "feishu-bridge 渲染会话". The tool-icon table covers the dsh tool namespace (`read`/`write`/`lsp`/`subagent_fork`/`feishu_bridge_*`…) alongside the Claude Code names, while the delegation label `subagent` keeps its Go-anchored ⚙️/blue rendering — the ported tests pin it, and it is a projection label, not a tool name.

## Alternatives considered

- **Extend `MessageSourceMap` with a Feishu user source for sender identity** instead of a text prefix. Deferred: it changes the `dsh-llm` package and the session-log semantics for information the model genuinely needs inline; the renamed prefix keeps "model-visible ⟺ logged" trivially true. Revisit only with the broader interaction-seam consolidation.
- **Consume todo snapshots only, dropping the tool-argument parse.** Rejected: Claude-style `TodoWrite` emitters and the native tool both feed the section today; both paths set the same list and last write wins.
- **Keep the persisted pre-copy for fork-at.** Rejected: it writes durable state whose only reader is the immediately following create; the seed option is the native mechanism for exactly this.
- **List sessions from the SessionManager's `sessions.json`.** Rejected: two authorities for which sessions exist; persistence is authoritative, the SessionManager stays the summary/count authority.

## Consequences

- The 🔴/🗜 stats and post-restart `/sessions` behave as the FEATURE-PARITY table already claimed they did; fork-at and the render pipeline no longer maintain artifacts a native path replaces. Covered by `tests/agent-dsh/adapter-projection|adapter-list|adapter-fork-at.spec.ts`, the native-signals block in `tests/engine/engine-events.spec.ts`, and the render fail-loud cases in `tests/engine/plan-render*.spec.ts`.
- Deploying the render-skill change wires `customSkillDirs` to the package `skills/` directory — which also loads `feishu-bridge-subtask` and `feishu-bridge-chatroom-moderator` into the model catalog for the first time (the D4 intent; the production profile never pointed there). Until that wiring lands, the first plan/reply render on an upgraded daemon fails loud by design.
- Fork-at lineage changes one field: the child's `createdAt` is the fork moment, not the source's creation time; `parentSession` and `seedLength` carry the lineage the Go copy preserved by duplicating the header.
