# Agent Note: Lifecycle-phase avatar colors for spawned groups

Status: implemented

English | [中文](2026-08-26-feishu-bridge-lifecycle-phase-avatar.zh.md)

## Problem

A spawned task group's avatar background was decoration: `groupAvatarColor` hashed the group name to a random hue, and the only state signal was the color/gray pair toggled by `/done`-`/undone`. In the Feishu chat list the tiny avatar is the only at-a-glance surface — the group name truncates and cards require opening the chat — so the one channel that could answer "which groups need me" carried no information beyond done/not-done.

## Decision

The avatar background of a spawned group is now a fixed five-color lifecycle signal (the icon stays semantic, LLM-chosen as before); this diverges from Go upstream's random-hue design:

| Color | Phase | Meaning |
|---|---|---|
| Yellow | `discussing` | No approved plan yet — discussion, direct work, and never-planning sessions (unattended cron runs) alike |
| Blue | `plan-review` | An ExitPlanMode card is parked awaiting approval |
| Green | `approved` | A plan was approved; the healthy baseline |
| Red | `attention` | The user must step in: a pending question/permission card, an errored turn, or a stall timeout |
| Gray | `done` | `/done`, same as the previous dimming design |

The phase model is two-layered. A persisted `basePhase` (`discussing`/`approved`) is where the chat returns when an overlay (`plan-review`/`attention`/`done`) clears. The engine drives transitions at: `askUser` entry (plan-review → blue, questions/permission → red), `askUser` settlement (plan approval → green and baseline moves; rejection/withdrawal → yellow and baseline resets; every other ask returns to the baseline), turn end (errored → red, success → baseline), the stall-timeout kill, `/done` (gray), and `/undone` plus next-message reactivation (baseline). Auto-approved asks (unattended answers, chatroom role-pick, standing grants) never park, so they never paint — red strictly means a human is needed. The two baseline phases are also the write rule for the baseline: painting `discussing` or `approved` moves it, overlays leave it alone.

`/done` freezes the axis while its mark (`doneAt`) is outstanding: `applyChatPhase` drops every engine-driven repaint — stop-settled asks, turn-end baselines, stall — because the stop that `/done` issues releases exactly those settlements, and an unpainted settlement repaints the baseline over the gray terminal (observed in production: an interrupted `/done` left a group yellow with its done mark overwritten). `cleanupOneChat` therefore commits the done mark and paints gray before issuing the stop. `/undone` lifts the freeze (`markActive` deletes `doneAt`); next-message reactivation repaints the baseline directly through the platform, bypassing `applyChatPhase`, but overlay colors stay frozen until `/undone`.

The `ChatAvatarStateSwitcher` boolean axis (Go `setChatAvatarActive`) is replaced by `ChatPhasePainter` (`setChatPhase` + `chatBasePhase`); the boolean's `/done`-dimming role is the `done` phase. Platform resolution order per transition: cached per-phase key → lazy render from the stored `iconName` → legacy `colorAvatarKey`/`grayAvatarKey` pair → bot avatar pair; nothing resolves → skip with a warn. `setGroupIconAvatar` eagerly uploads only the initial pair (yellow + gray, same two uploads as before) and records `iconName`, `phase`, `basePhase`, `lastAvatarKey`, and `avatarKeys` on the spawned-chat meta; blue/green/red render and upload on first entry, so groups that never reach them pay nothing. The group-name fallback path (LLM naming failed or returned an empty name; the group is named after the first message) stamps a name-hashed icon through the same setter (engine `fallbackRename`), so a naming timeout no longer pins the group to the bot avatar pair for its whole life. A transition applies the avatar via the chat-update verb first and persists the phase only after that commits; a crash between the two self-heals on the next transition. Same-key transitions (deduped via `lastAvatarKey`) skip the API call entirely — each Feishu "更新了群头像" system message now marks a real state change, and a full happy-path lifecycle costs at most 3–4 of them. Paints are serialized per chat through a promise chain, so a repaint racing an in-flight paint reads the meta the earlier paint committed instead of a stale snapshot (the unsynchronized write-back let the slower paint clobber the faster one's phase, keys, or done mark).

Non-phase chats keep their hashed colors and never speak the phase language: chatroom families (stamped by `setChatroomFamilyAvatar` with no `iconName`, so every non-done phase resolves to their existing color key — family branding survives, end-of-chatroom graying survives via the gray key) and branded monitor hubs (no spawned meta at all, `setChatPhase` no-ops). This also keeps the family visually distinguishable from phase-painted task groups. `/done` in a non-spawned group no longer touches its avatar (the old axis dimmed the bot avatar pair there) — acceptable: `/done` only makes sense in a spawned group.

## Alternatives considered

- **Red for "plan awaiting approval" (the user's first proposal).** Rejected: red is the alert color in messaging UIs, and a plan review is a normal, expected gate, not a fault. Red is reserved for the collapsed "needs you" state — pending question/permission cards, errored turns, stalls — where the user's action is the unblocking step; distinguishing question-waiting from permission-waiting by color was also rejected because both demand the same action (open the chat, answer the card).
- **Keep the random hue and add a separate state indicator.** Rejected: in the chat list the avatar is effectively the only renderable state surface; name suffixes truncate and cards require opening the chat.
- **More than five phases (working vs idle, waiting-on-subtasks, context pressure).** Rejected: small avatar swatches keep roughly five distinguishable colors (yellow/orange and blue/purple collide at list size), the green/red pair already strains red-green colorblind users (mitigated by a darker red), and high-frequency states like working/idle would flip every turn, converting the "更新了群头像" system message into noise. The color budget is spent; further granularity belongs to the icon or group-name suffixes.
- **Eagerly upload all five variants at avatar-set time.** Rejected: most groups never reach blue/green/red, and the lazy render from the stored icon name costs one render + upload only on first entry.
- **A `phaseLocked` flag to keep chatroom families out of the axis.** Rejected: legacy entries already resolve to their color/gray pair, and key-dedup makes same-key transitions free — the legacy fallback path is the family lock, with no new field.
- **Track `basePhase` in the engine (session metadata).** Rejected: the platform already persists it in the spawned-chat meta next to the keys it resolves from; deriving it from the painted phase (baseline phases move the baseline) needs no engine bookkeeping and survives restarts.
- **Unfreeze the avatar axis fully on message reactivation.** Rejected: reactivation would have to clear `doneAt`, which also feeds the 7-day retention sweep, and Go's active axis deliberately keeps a resumed chat `/done`-inactive until `/undone` — a half-frozen avatar (baseline color, no overlays) matches that semantics.

## Consequences

- The chat list answers "which spawned groups need me" at a glance: scan for red; blue marks the plan gate; gray is archival.
- Legacy groups (pre-phase entries, no `iconName`) keep the old two-state behavior — hashed color while active, gray on `/done` — with a one-time re-apply system message on their first transition after the upgrade; no migration is written.
- Every phase change emits one Feishu system message ("更新了群头像"); this is accepted as a signal in itself, and dedup bounds it.
- A daemon restart during a pending card loses that one color change until the next transition; the persisted phase and applied avatar stay consistent because the phase publishes only after the avatar apply commits.
- A message-reactivated `/done`d group shows its baseline color but no overlay colors until `/undone`.
- The phase palette is fixed (`phaseAvatarBG` in `src/feishu/avatar.ts`); `groupAvatarColor` survives only for non-phase chats (families, branded hubs).
- Upstream drift: Go's `ChatAvatarStateSwitcher` no longer maps 1:1; a future `dsh-sync-upstream` that touches it needs this note as the divergence record.

Pinned by `tests/feishu/avatar-state.spec.ts` (resolution order, dedup, lazy render + cache, per-chat paint serialization, legacy/bot fallbacks, apply-before-persist, baseline rules), `tests/feishu/avatar-icon.spec.ts` (initial pair + phase bookkeeping at avatar-set time), `tests/engine/avatar-phase.spec.ts` (askUser entry/settle matrix, turn-end error/success, best-effort semantics, the `/done` freeze), `tests/feishu/spawn-evict.spec.ts` (phase-field persistence round-trip), `tests/engine/spawn-family-commands.spec.ts` (`/undone` restores the baseline), and `tests/engine/engine-groupname.spec.ts` (the naming fallback still stamps a name-hashed icon avatar).
