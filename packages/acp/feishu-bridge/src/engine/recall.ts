/**
 * Message-recall cancellation (#30, Go core/engine_events.go
 * CancelQueuedByMessageID): a platform recall event removes the matching
 * message from a session's pending queue (or reports it inflight) so a
 * retracted user message never reaches the agent. Text+attachment messages
 * ride the queue, so a cancelled queue entry takes its attachments with it;
 * pure-attachment messages instead wait as staged entries (#8) outside the
 * queue — cancelStagedAttachmentsByMessageID is their recall branch: drop the
 * entries, delete the cached files, and report what remains staged.
 *
 * @module dsh-feishu-bridge/recall
 */

import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Engine } from './engine.ts'
import { Msg } from '../i18n/index.ts'

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
 * Remove the staged attachments a recall targets (the pure-attachment
 * counterpart of {@link cancelQueuedByMessageID}): drop the matching
 * pendingAttachments entries so the next text prompt no longer splices their
 * paths, delete the cached files, and reply with what remains staged. A path
 * another staged entry still references survives deletion — the delete stays
 * guarded at this destructive boundary even though uniquePathIn keeps staged
 * paths distinct.
 *
 * @param e - Engine whose interactive states hold the staged attachments.
 * @param messageID - The recalled platform message id.
 * @returns Whether any staged attachment was cancelled.
 */
export function cancelStagedAttachmentsByMessageID(e: Engine, messageID: string): boolean {
  for (const state of e.interactiveStates.values()) {
    const removed = state.pendingAttachments.filter(a => a.messageID === messageID)
    if (removed.length === 0) continue
    const remaining = state.pendingAttachments.filter(a => a.messageID !== messageID)
    state.pendingAttachments = remaining
    const inUse = new Set(remaining.map(a => a.path))
    for (const a of removed) {
      if (inUse.has(a.path)) continue
      void rm(a.path, { force: true }).catch((error: unknown) => {
        console.warn(`cancelStagedAttachmentsByMessageID: remove staged file failed (${a.path}): ${String(error)}`)
      })
    }
    if (remaining.length === 0 && state.pendingDir !== '') {
      const pendingDir = state.pendingDir
      state.pendingDir = ''
      void rm(pendingDir, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(`cancelStagedAttachmentsByMessageID: remove pending dir failed (${pendingDir}): ${String(error)}`)
      })
    }
    const platform = state.platform
    if (platform !== undefined) {
      const names = removed.filter(a => a.kind === 'file').map(a => basename(a.path))
      const fileList = names.length > 0 ? `: ${names.join(', ')}` : ''
      let imgN = 0
      let fileN = 0
      for (const a of remaining) {
        if (a.kind === 'image') imgN++
        else fileN++
      }
      void e.reply(platform, state.replyCtx, e.i18n.tf(Msg.AttachmentsCancelledByRecall, fileList, imgN, fileN))
    }
    return true
  }
  return false
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
