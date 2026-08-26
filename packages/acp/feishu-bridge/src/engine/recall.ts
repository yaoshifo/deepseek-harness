/**
 * Message-recall cancellation (#30, Go core/engine_events.go
 * CancelQueuedByMessageID): a platform recall event removes the matching
 * message from a session's pending queue (or reports it inflight) so a
 * retracted user message never reaches the agent. Attachment staging has no
 * separate queue here — attachments ride inside the queued message, so a
 * cancelled queue entry takes its attachments with it.
 *
 * @module dsh-feishu-bridge/recall
 */

import type { Engine } from './engine.js'
import { Msg } from '../i18n/index.js'

/** Outcome of a recall cancellation (Go recallResult). */
export type RecallResult = 'cancelled' | 'inflight' | 'not_found'

/**
 * Remove a queued message matching the recalled messageID (Go
 * CancelQueuedByMessageID). The inflight message wins over queued entries —
 * it is the most recent race window; it is reported, not cancelled, because
 * the agent is already processing it.
 *
 * @param e - Engine whose interactive states hold the pending queues.
 * @param messageID - The recalled platform message id.
 * @returns the recall outcome; 'not_found' leaves all state untouched.
 */
export function cancelQueuedByMessageID(e: Engine, messageID: string): RecallResult {
  for (const state of e.interactiveStates.values()) {
    if (state.inflightMessage !== undefined && state.inflightMessage.messageID === messageID) {
      void e.reply(state.inflightMessage.platform, state.inflightMessage.replyCtx, e.i18n.t(Msg.RecallAlreadyProcessing))
      return 'inflight'
    }
    const idx = state.pendingMessages.findIndex(qm => qm.messageID === messageID)
    if (idx >= 0) {
      const matched = state.pendingMessages[idx]
      state.pendingMessages.splice(idx, 1)
      if (matched !== undefined) {
        void e.reply(matched.platform, matched.replyCtx, e.i18n.t(Msg.CancelQueuedByRecall))
      }
      return 'cancelled'
    }
  }
  return 'not_found'
}

/**
 * Stop the preview card the recalled message id belongs to (tail-guard
 * companion): the user deleted the card, so updates stop and the guard must
 * not reissue it above the recall for the rest of the turn. No-op when no
 * active preview matches.
 *
 * @param e - Engine whose interactive states hold the active previews.
 * @param messageID - The recalled platform message id.
 */
export function markRecalledPreview(e: Engine, messageID: string): void {
  for (const state of e.interactiveStates.values()) {
    const sp = state.preview
    if (sp !== undefined && sp.cardMessageID() === messageID) void sp.markRecalled()
  }
}
