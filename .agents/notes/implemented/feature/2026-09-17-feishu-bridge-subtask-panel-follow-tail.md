# Agent Note: Subtask live panel reissues at the chat tail when displaced

Status: implemented

English | [中文](2026-09-17-feishu-bridge-subtask-panel-follow-tail.zh.md)

## Problem

The background-subtask live panel posts once when a turn settles with unreported native children and then PATCHes in place — which never moves a message. Everything the chat emits afterwards lands below it: the turn's own ✅ completion card, the reply-HTML image, the followups suggestion card, each child-report wake turn's fresh progress card, avatar-update system messages. Each of those steals the newest-message chat summary, so the Feishu conversation-list preview stops showing 「后台子任务 · N 个运行中」 while children are still running — the panel exists precisely to carry that status, and it was readable only by opening the chat.

The user's first instinct was to suppress the senders (no notification cards, no reply images while the panel lives). That works only if *everything* machine-initiated goes quiet, and the quiet has to include the per-report wake turns — which is where the cost lands: the parent agent could no longer react to each child's report as it arrives.

## Decision

The panel follows the tail instead of silencing the chat: **when the platform's activity ledger shows a newer tracked message below the panel card, the panel reissues** — posts a fresh card at the chat tail carrying the current content, deletes the displaced one, adopts the new handle. Nothing is suppressed; the parent keeps reacting to reports immediately; the panel wins the chat summary back.

Two triggers share one reissue path:

- **Refresh tick** (`refreshSubtaskPanel`, every `subtaskLivePanelIntervalMs`, default 15s): probe-gated — the reissue fires only when the displacement prober (`PreviewDisplacementProber`, the same ledger the stream preview's displacement heal rides) reports the card displaced. This bounds the reclaim latency for every displacer the engine does not own (human messages, other sends).
- **Turn end** (`reclaimSubtaskPanelTail`, called from `handleResultEvent` after the phase repaint): probe-less on purpose. A turn's placeholder card is sent through `sendPreviewStart`, which is deliberately exempt from the activity ledger so a card reissue never displaces itself — so on projects without a per-turn ✅ (`notifyOnComplete: false`) the probe stays blind to the settled turn card sitting below the panel. The force reclaim closes that gap; the cooldown absorbs its redundancy on ✅-emitting projects.

Discipline around the jump:

- **Cooldown**: one reissue attempt per `previewReissueCooldownMs` (2s), marked at initiation so a racing refresh cannot double-send.
- **Content outranks position**: a failed reissue falls back to an in-place PATCH of the still-live card with the same rendered content (the stream preview's displacement-heal discipline) — the panel never goes stale while the tail retry is pending.
- **Terminal phases never jump**: the done/drained transitions always PATCH in place; the window is over and the synthesis reply owns the tail.
- **Degradation**: platforms without a displacement probe or card deletion keep PATCH-only (the pre-follow-tail behavior); a failed delete only orphans the old card (warn log).
- **No ping-pong with the stream preview**: preview card sends are ledger-exempt, so a running turn's card owns the tail during the turn and the panel does not fight it — the panel reclaims at that turn's end. The panel's own reissue does touch the ledger, but the preview's heal only fires on its content flushes, so at most one bounded exchange occurs per real message.

Config: `features.subtaskLivePanelFollowTail` (default on), wired through `setSubtaskPanelConfig`.

## Alternatives considered

- **Bank reports in a panel-armed gather barrier, wake the parent once when all children report** (the first approved plan). Rejected after user review: it buys a guaranteed panel-last preview by deferring the parent's incremental reaction to each report — early processing and follow-up questions wait for the slowest child or the gather timeout. The follow-tail design achieves the preview goal with zero reaction cost.
- **Suppress turn-end sends (✅ card, reply image, followups card) during the window.** Rejected: loses the usage stats and the rendered reply delivery, and wake-turn progress cards still displace the panel — suppression alone never reaches the goal.
- **Silent wake turns** (no placeholder card, NO_REPLY guidance for intermediate reactions). Rejected: intermediate tool activity becomes invisible, "panel stays last" depends on model NO_REPLY discipline rather than a mechanism, and the progress-card machinery needs a dark mode of its own.
- **Unconditional reissue every tick.** Rejected: a jump per tick is churn the ledger probe makes unnecessary; displacement-driven reissue jumps only when something actually passed the card.

## Consequences

- Every displacement during a window costs one extra message (fresh panel card at the tail, old one deleted) — the conversation-list unread count ticks a little faster; Feishu shows the panel "jumping" to the bottom. This is the accepted price of owning the chat summary.
- The panel also follows below human messages during the window — harmless while the user is present (the tail is where they are reading) and self-correcting: once activity dies down, the panel holds the tail.
- During a running wake turn, the turn's card owns the tail (it is the newest information); the panel reclaims at that turn's end, within the tick cooldown.
- The reissue requires card handles the platform's displacement prober and card deletion accept (Feishu's `FeishuPreviewHandle` from `sendCardWithHandle` qualifies); other platforms silently degrade to PATCH-only.
- Live deployments need no config change (default on); the feature turns off per project with `features.subtaskLivePanelFollowTail: false`.
- Testing: `tests/engine/subtask-panel.spec.ts` `panel follow-tail reclaim` describe pins the displaced reissue and in-place PATCH after, terminal-never-jumps, the config off-switch, the cooldown, the force reclaim and its no-ops, and both failure fallbacks.
