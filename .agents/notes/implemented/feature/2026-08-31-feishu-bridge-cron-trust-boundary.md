# Agent Note: feishu-bridge cron trust boundary — chat ownership and admin-gated exec

Status: implemented

English | [中文](2026-08-31-feishu-bridge-cron-trust-boundary.zh.md)

## Problem

The cron store is project-global, but its three entry points — `/cron` text commands, cron-card buttons, and the `feishu_bridge_cron` agent tool — all operated on bare 8-hex job ids with no ownership check. Any chat could delete, disable, or edit any other chat's jobs (including rewriting `exec`/`prompt`/`session_key` through the tool's edit branch), and `/cron list` rendered every job in the project — prompt and exec text included — to any group member. Worse, the agent tool bypassed the one gate the text surface had: `/cron addexec` requires `isAdmin`, but the tool's `add` accepted `exec` directly, so any group member could ask the agent for an unattended shell cron job — a persistence channel that outlives per-turn approvals precisely because cron fires later with nobody watching.

## Decision

Jobs belong to the chat that created them (`job.sessionKey`); the `admin_from` whitelist overrides ownership everywhere. The shared helper `cronJobActionAllowed` (engine/cron-commands.ts) is the single implementation, reused by the tool, text, and card paths:

- **add** — an `exec` job requires the acting user to be an admin, the same trust line as `/cron addexec`: unattended shell execution. A prompt-only job stays ungated because it runs inside the agent session with its normal per-turn approvals.
- **edit** — sensitive fields (`exec`, `prompt`, `project`, `session_key`, `work_dir`, `mode`) are admin-only even for the owning chat; `mode` is included because it can switch an unattended run to `bypassPermissions`, the same bypass-per-approvals line. Non-sensitive fields (`cron_expr`, `description`, `enabled`, `mute`, `silent`, `timeout_mins`, `session_mode`) are owner-or-admin.
- **del / enable / disable / mute / info** — owner-or-admin across all three entry points, closing the global-id read leak alongside the write leaks.
- **list** — a non-admin sees only the calling chat's jobs, with the prompt/exec fallback text capped at 60 runes; admins keep the full project view.

The acting user is the session's spawn user (`session.getSpawnUserID()`); a chat with no active session resolves to `''`, which the admin checks treat as non-admin — fail closed. The card-button path receives only the session key (engine.ts's `handleCardAction` does not plumb `msg.userID` through), so its gate degrades to pure ownership: a forged cross-chat card action is rejected even for an admin, which is stricter and accepted as-is.

## Alternatives considered

**Blocking exec jobs from the agent tool entirely.** Rejected: admins legitimately want the agent to schedule commands; the text-only path would just get proxied by hand.

**Gating exec adds on the session's permission mode.** Rejected: cron runs unattended after creation, so per-turn permission state at add time says nothing about the runs — the admin line is the only check that survives to execution time.

## Consequences

The trust line is now uniform: everything that executes shell or changes what a job executes requires an admin; everything that manages an existing job requires owning it or admin. Any future cron entry point must go through `cronJobActionAllowed` rather than touching `scheduler.store()` directly. Known limitation: the card path's lack of an admin exemption means an admin cannot operate another chat's job via a forged card callback — restoring that would need `msg.userID` plumbed into `executeCardAction` (one line in engine.ts); the stricter behavior was kept deliberately.

## Testing

`tests/tools/cron-tool.spec.ts`: exec add rejected for a non-admin acting user, prompt add ungated, admin exec add passes; del/edit/info denied for another chat's job; sensitive-field edits need an admin even in the owning chat; list shows a non-admin only its own chat's jobs with truncated fallback text. `tests/engine/cron-commands.spec.ts`: text del/enable/disable/mute from another chat denied for non-admins; owning chat and admins operate freely. `tests/engine/cron.spec.ts`: forged card actions for another chat's job denied. `tests/tools/lark-tool.spec.ts` pins the sibling output cap landed in the same batch.
