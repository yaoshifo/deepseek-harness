# Agent Note: Suppress the turn-end reply render for relay sessions

Status: implemented

English | [中文](2026-09-15-turn-end-reply-render-suppression.zh.md)

## Problem

The speculative reply→HTML render (#48) had two trigger sites with asymmetric gating. The pre-interaction site (parking before an ask, `captureReplyForExport` → `renderAndDeliverReply`) consulted `Session.shouldSuppressAutoRender`, but the turn-end site in `handleResultEvent` did not — the guard was missing since the M7-a port (ffbaebae95) of the Go `EventResult` export block. Every session whose reply relays elsewhere therefore still forked a render session (LLM fork + Chromium rasterization + image upload) and delivered a local HTML overview nobody needed:

- chatroom role groups (「聊天室·<role>」): replies relay to the moderator hub at turn end;
- research assistants (「聊天室·助手·<role>」), stewards, and every plain subtask child: replies report to their parent.

On the production profile this is live cost: the chatroom-enabled project (知识驴) runs `planRender.enabled: true`, and the 2026-09-13 run review counted 43 of 81 sessions as render forks. The 2026-09-14 tier-revert note ([2026-09-14-reply-render-tier-revert.md](2026-09-14-reply-render-tier-revert.md)) closed the length-tier approach and left this cost as an open item; the waste was concentrated exactly in relay sessions.

## Decision

The turn-end trigger in `handleResultEvent` now applies the same predicate as the pre-ask trigger: `!session.shouldSuppressAutoRender(this.bridge)` joins the `planRenderEnabled && length >= defaultReplyPreRenderLen` condition. The predicate already carries the intended exemptions:

- chatroom roles suppress via the `feishuBridge/auto-render-policy` waterfall (chatroom package: `chatroomHubKey !== ''`);
- subtask children suppress via the built-in `subtaskDepth > 0` base;
- user takeover re-enables rendering (`userInterjected`), and monitor children stay exempt.

Moderator hubs, direct-role chats, and plain user sessions keep rendering — their reader is the user, per the product ruling that every qualifying (≥500 rune) user-facing reply keeps its fork-rendered card.

## Alternatives considered

- **Centralize the check inside `renderAndDeliverReply`.** Rejected: both call sites decide when to fork; the park site already checks at its trigger, so mirroring it keeps one idiom per site and leaves the function's contract (best-effort fork) untouched.
- **Extend suppression to direct-role chats (`chatroomDirectRole`).** Rejected for this change: a direct-role chat is a 1:1 conversation whose reader is the user, same as a plain session. Cheap to add later if wanted.
- **Also gate the ExitPlanMode plan-render site.** Not taken: plan renders fire in user-facing plan-approval flows; moderators are mode-downgraded and roles do not run `exit_plan_mode`.

## Consequences

- Relay sessions (chatroom roles, research assistants, subtask children in every plan_render-enabled project) no longer fork a turn-end render — the open cost item from the 2026-09-13 review is addressed for exactly the sessions whose output is consumed elsewhere. User-facing replies are unchanged, preserving the tier-revert ruling.
- `exportContent` caching at turn end is unchanged: the green card's export button still works for suppressed sessions (it exports text, not a render).
- Tests: `plan-render-fork.spec.ts` `turn-end reply-render suppression` drives the real event loop (`processInteractiveEvents`) over a chatroom-shaped policy listener, a subtask-depth session, and a user-takeover session; the plain-session positive control is `PreRenderAutoDelivers`.
