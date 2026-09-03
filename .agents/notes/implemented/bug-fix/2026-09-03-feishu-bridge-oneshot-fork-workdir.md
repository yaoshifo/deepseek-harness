# Agent Note: feishu-bridge one-shot forks run in the chat's directory

Status: implemented

English | [中文](2026-09-03-feishu-bridge-oneshot-fork-workdir.zh.md)

## Problem

A 2026-09-03 feishu-bridge session renamed the group oc_9e68 — a deepseek-harness chatroom-research chat — to 「mem0 记忆服务开发」 seconds after the user sent 「继续」 following a /provider switch. The daemon log line `chat renamed … → mem0 记忆服务开发` (09:50:13) pinned the trigger to the group-name fork, and that fork's session (cc-20260903-095010-7a9f255d74fe) sat in the `--Users-hm-workspace-mem0--` bucket while the chat's own main session ran in deepseek-harness. Three defects shared one root: one-shot side queries resolved their session cwd to the adapter's base cwd instead of the calling chat's effective directory. The profile had moved the bot's base workdir to `/Users/hm/workspace/mem0` the day before, so:

1. The group-name fork received mem0-repo workspace instructions while its prompt excerpt held only the ambiguous 「继续」 — the model invented a mem0-development name and a `database` icon from ambient context, and the engine renamed the group and synced the session label from it.
2. plan-render / reply-html render forks landed in the wrong bucket, which later sent log triage hunting across the wrong project.
3. `/list`'s persisted view filtered by the base cwd and its live view never filtered, so the chat's session picker mixed in another project's sessions — the same window in which the DM's glob-fix session got attached to the group.

## Decision

- `ForkQuerierWithProvider.lightweightQuery` and `RenderQuerier.renderQuery` take an optional trailing `workDir`; the adapter forwards it into `oneShotQuery`, which already pinned `meta.cwd` from it and falls back to the base cwd when it is omitted or empty.
- The engine passes `sessionWorkDir(sessionKey)` — per-chat `/dir` override first, base fallback — at every side-query site: the group-name query (`generateGroupName`, reached through `renameGroupWithLLM` and the `/rename` regeneration), the plan-render / reply-html shared `renderContentToHTML` core, and predict-next / turn-summary, whose caller hoists the worktree-or-override resolution so both prediction modes share one value.
- `Agent.listSessions` takes an optional `workDir` scoping both views to that directory tree; `DshAgentSession.cwd()` exposes a live session's recorded header cwd, and live entries without one stay visible (unknown is not foreign). cmdList, the session-picker card, and /switch all pass the chat's `sessionWorkDir`.
- The first-message auto-rename skips ambiguous seeds: `isNameableGroupNameSeed` rejects seeds under 4 runes or in a fixed nudge set (继续/接着/continue/go on/好的/收到/ok/next/嗯/嗯嗯), so a bare 「继续」 can no longer trigger a rename whose input is ambient context. `/rename` regeneration and spawned-group hub naming are unaffected — both are explicit or richly seeded.

## Alternatives considered

- **Feed the group-name fork the chat's cross-session history instead of skipping.** The engine keeps history per session, so a post-switch fresh session has none; a durable per-chat history ring is a much larger surface, and a bare 「继续」 genuinely names nothing — skipping is the honest behavior.
- **Handle vague seeds by blocklist only, no length floor.** The length floor covers the whole class of 1–3-rune nudges without enumerating them; the set only catches longer idioms.
- **Fix /list by listing every session across all buckets.** That is exactly what produced the complaint: the picker must read as "sessions of this directory" (Go per-cwd store semantics), and cross-directory adoption stays available by `/dir`-ing first.
- **Scope the fix to group naming; leave renders on the base cwd.** Render forks landing in the wrong bucket broke log triage the same way the rename did, and the seam costs one parameter per call site.

## Consequences

- Tests: adapter-oneshot.spec pins both query workDirs; adapter-list.spec pins persisted and live scoping plus unchanged behavior without the parameter; engine-groupname.spec pins the rename query's workDir and the ambiguous-seed skip; predict.spec pins both forwardings; plan-render-fork.spec pins the render fork's workDir. The touched spec set runs 524 green.
- Deployment: host build plus a manual `/reload`; the live verification signal is the next `/provider`-then-「继续」 in an overridden chat — no rename, and `/list` scoped to the chat's directory.
- Known siblings left as-is: monitor triage's `lightweightQuery` (a classifier whose cwd only steers which injections it sees) and the harness session-title fork (packages/session domain) still resolve to the base cwd; both can adopt the same seam later.
- The chat's recovery path survives: a deepseek-harness chat still sees that directory's DM sessions in `/list`, so reattaching the research session stays one picker click away.
