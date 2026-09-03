/**
 * The background-subtask live panel: a standalone card posted when a parent
 * turn settles with native children still running (the no-gather escape
 * path), PATCHed in place on a timer so the chat shows each child's
 * liveness — tool-call count and last-activity age — instead of going silent
 * until the first report (2026-08-27 oc_a7ab0de6: two implementation
 * children ran eight-plus minutes with no signal whether they were alive).
 *
 * The header mirrors the tool-progress card's 执行中 composition: running
 * color template, spinner icon, and a wall-clock last-activity timestamp
 * that advances on every tick. A stalled child freezes that clock at a
 * glance and flips the template orange past the stall window. Rows show the
 * absolute timestamp — it stays readable on a dead card (PATCH failures)
 * because the reader compares it against their own clock.
 *
 * The card holds its own message handle and never touches the progress-card
 * machinery, so the post-detach PATCH channel that deferred the 2026-08-26
 * per-child panel does not apply. Gather turns never settle mid-wait, so
 * they never post a panel — their live card already streams child activity.
 *
 * @module dsh-feishu-bridge/subtask-panel
 */

import { newCard, dangerBtn, type Card } from '../card.ts'
import { Msg, type MsgKey } from '../i18n/keys.ts'

/** Minimal i18n surface the renderer needs (Engine.i18n satisfies it). */
export interface PanelI18n {
  t(key: MsgKey): string
  tf(key: MsgKey, ...args: unknown[]): string
}

/** One pending child row on the panel. */
export interface SubtaskPanelChild {
  readonly childId: string
  readonly label: string
  /** Tool calls seen from this child; 0 with lastEventAt 0 = no events yet. */
  readonly toolCalls: number
  /** Epoch ms of the child's last durable event; 0 = no events seen. */
  readonly lastEventAt: number
}

/** Panel shape rendered onto the card (pure data; the engine assembles it). */
export interface SubtaskPanelState {
  /** Children still unreported, in spawn order. */
  readonly pending: readonly SubtaskPanelChild[]
  /** Children of this parent that already reported. */
  readonly reportedCount: number
  /** Epoch ms the panel was posted (elapsed-time anchor). */
  readonly startedAt: number
  /** 'running' renders live rows; 'done' and 'drained' are terminal. */
  readonly phase: 'running' | 'done' | 'drained'
}

/** Wall-clock HH:MM:SS of an epoch-ms timestamp (progress-card lastTS format). */
function wallClock(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8)
}

/** Whether a child row is past the stall window (0 = no events, never stalled). */
function isStalled(child: SubtaskPanelChild, now: number, stallMs: number): boolean {
  return child.lastEventAt !== 0 && now - child.lastEventAt >= stallMs
}

/** Last-activity wording for one child row: the absolute clock alone. */
function activityLine(
  i18n: PanelI18n,
  child: SubtaskPanelChild,
  now: number,
  stallMs: number,
): string {
  if (child.lastEventAt === 0) return i18n.t(Msg.SubtaskPanelWaiting)
  const age = now - child.lastEventAt
  const base = i18n.tf(Msg.SubtaskPanelLastActive, wallClock(child.lastEventAt))
  if (age >= stallMs) {
    const mins = Math.floor(age / 60_000)
    return `${i18n.tf(Msg.SubtaskPanelStalled, mins >= 1 ? mins : 1)} · ${base}`
  }
  return base
}

/**
 * Render the panel card — a pure function of the state, so tests pin the
 * layout without the lifecycle.
 * @param i18n - Message lookup.
 * @param state - Panel rows and phase.
 * @param now - Epoch ms the render happens at.
 * @param stallMs - Silence window after which a child is flagged stalled.
 * @param iconKey - Header spinner image key ('' renders no icon; terminal phases ignore it).
 * @returns The card for the panel's current state.
 */
export function renderSubtaskPanelCard(
  i18n: PanelI18n,
  state: SubtaskPanelState,
  now: number,
  stallMs: number,
  iconKey: string = '',
): Card {
  const elapsedMins = Math.max(0, Math.floor((now - state.startedAt) / 60_000))
  const card = newCard()
  if (state.phase === 'done') {
    return card
      .title(i18n.t(Msg.SubtaskPanelDoneTitle), 'green')
      .markdownf('%s\n\n%s', i18n.tf(Msg.SubtaskPanelSummary, state.reportedCount, 0), i18n.tf(Msg.SubtaskPanelElapsed, elapsedMins))
      .build()
  }
  if (state.phase === 'drained') {
    return card
      .title(i18n.t(Msg.SubtaskPanelDrainedTitle), 'grey')
      .markdown(i18n.t(Msg.SubtaskPanelDrainedNote))
      .build()
  }
  // Header composes like the tool-progress 执行中 title: base state, live
  // timestamp, then counts. The timestamp is the newest child activity, so
  // it keeps advancing while any child works and freezes when all stall.
  const stalledCount = state.pending.filter(c => isStalled(c, now, stallMs)).length
  let title = i18n.tf(Msg.SubtaskPanelTitle, state.pending.length)
  const latest = state.pending.reduce((m, c) => Math.max(m, c.lastEventAt), 0)
  if (latest > 0) title += ` · ${wallClock(latest)}`
  if (stalledCount > 0) title += ` · ${i18n.tf(Msg.SubtaskPanelStalledSuffix, stalledCount)}`
  card
    .title(title, stalledCount > 0 ? 'orange' : 'yellow')
    .icon(iconKey)
    .markdownf('%s · %s', i18n.tf(Msg.SubtaskPanelSummary, state.reportedCount, state.pending.length), i18n.tf(Msg.SubtaskPanelElapsed, elapsedMins))
    .divider()
  for (const child of state.pending) {
    const calls = i18n.tf(Msg.SubtaskPanelCalls, child.toolCalls)
    card.markdownf('- **%s**\n  %s · %s', child.label, calls, activityLine(i18n, child, now, stallMs))
  }
  card
    .divider()
    .note(i18n.t(Msg.SubtaskPanelFooter))
    .buttons(dangerBtn(i18n.t(Msg.SubtaskPanelStopAll), 'act:/subtask-panel stop'))
  return card.build()
}
