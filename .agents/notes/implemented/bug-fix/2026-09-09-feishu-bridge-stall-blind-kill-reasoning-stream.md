# Agent Note: the stall watchdog must see streamed chunks, and a resumed session must keep its approved mode

Status: implemented

English | [中文](2026-09-09-feishu-bridge-stall-blind-kill-reasoning-stream.zh.md)

## Problem

2026-09-09 oc_a8f451 incident (spawned chat "Pelican Bicycle SVG", 开发虾 daemon): the chat looped through three plan cards, two ⚠️ 无响应超时（200）retries, and two 执行失败 cards, ending with a user /done. The session log showed both execution turns dying at exactly 200.5s with `turn/end aborted/disposed`, while the mify proxy log proved both LLM streams alive — they ran 375.9s and 587.1s to natural completion, with 9.9k/20.4k chars of coherent reasoning accumulated at each kill moment. Two defects compounded:

1. **Blind kill.** GLM at max effort generates one long message: the pure-reasoning phase streams as transient `agent/assistant-stream` chunk frames and lands no durable session event until the message completes, so the engine pump goes event-less for the whole window and `stallConfirmed` cannot distinguish a live stream from a hang — its `lastStreamActivity` clock counted only projected durable events. The watchdog killed turns that streamed the whole window: the same family as the 2026-08-25 oc_29bb incident, whose fix covered only the degraded-handoff case (adapter still projecting, pump no longer receiving).
2. **Re-approval loop.** The stall retry restarts the session through `startAgentLocked` with the original start options, and the project default mode (live profile 开发虾 `agent.mode: plan`) re-arms on every `startSession` — including resumes — overwriting the plan state the resume itself restores from the session log (the plan projection folds the log; the last `plan/mode` event wins). The approved plan rewound into plan mode, the retry injected its synthetic 「继续」, and the model could only re-present the plan for approval again.

## Decision

- The adapter subscribes to the transient `agent/assistant-stream` frames (`packages/acp/feishu-bridge/src/agent-dsh/adapter.ts`): each `chunk` frame refreshes the owning live session's stream-activity clock (`DshAgentSession.noteStreamActivity`), so `stallConfirmed`'s existing blind-pump override covers chunk streams the engine's delta projection leaves silent — today tool-argument deltas. Reasoning/text deltas project into engine events (`DshAgentSession.projectStreamChunk`, the session-format-v2 preview restoration) and feed the pump directly; the clock is their second net. A stream that itself goes quiet for the whole idle window still stalls — the 2026-08-26 oc_b46da frozen-clock protection is untouched.
- Mode resolution in `startSession` now skips the chat's pinned `spawnMode` and the project `defaultMode` for resumes: a resumed session restores its own logged plan state, and inherited modes must not re-arm on it. An explicitly armed one-shot override still applies on resume (the /mode switch over a recycled session relies on it); fresh sessions keep the full rank.

## Alternatives considered

- **Projecting reasoning deltas into the engine channel as thinking_delta events.** Would feed the pump directly, but lights up streaming-thinking card UX — a behavior change beyond the stall fix, which needed only the activity clock. The projection shipped on its own driver (2026-09-09, `projectStreamChunk`): session format v2 dropped the durable `assistant/chunk` events the engine's delta projection rode, and restoring the thinking preview required projecting the transient frames. The two layer: projection feeds the pump for reasoning/text windows, the clock shields every other chunk type.
- **Raising stallTimeoutSecs alone.** Deployed as an interim measure (live profile 200→600), but it only moves the cliff: any single-message generation longer than the window dies again. The stream-activity signal is the mechanism fix.
- **Fixing the loop via a mode-policy listener (like the chatroom moderator downgrade).** Patches one caller; the adapter-level resume skip fixes the mechanism for every restart path (stall retry, live-guard recycle, engine restart).

## Consequences

- Tests: a real-composition regression (scripted LLM streaming reasoning chunks at 300ms cadence against a 400ms idle window, completing only after 2.4s) pins the no-kill outcome with the projected deltas keeping the pump fed (`packages/acp/feishu-bridge/tests/engine/engine-stall-retry.spec.ts`); a sibling tool-argument cadence case (chunk types the projection leaves silent) pins the `stall check overridden` warning; the existing hang, retry-exhaustion, and frozen-clock cases stay green. Adapter unit tests pin the frame-subscription contract and the resume mode rank (`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts`).
- Pump-blind streams — today the long tool-argument generations the projection leaves silent — emit one `stall check overridden` stderr warning per idle window, informative noise, accepted; reasoning/text generations feed the pump directly and stay silent.
- Forks keep inheriting spawn/default modes (they are new sessions); unattended subtasks keep the bypassPermissions override ahead of everything.
- Deployment: bridge rebuild + `/reload`; the live profile's `display.stallTimeoutSecs` 200→600 lands with the same reload.
