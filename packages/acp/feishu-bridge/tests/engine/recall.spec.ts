/**
 * Ported from cc-connect core/engine_recall_test.go (#30 消息撤回取消):
 * CancelQueuedByMessageID splices a recalled message out of the pending
 * queue (or reports it inflight) and replies on the matched platform.
 * The staged-attachment branches of the Go suite are not ported — the TS
 * engine carries attachments inside the queued message itself, so a
 * cancelled queued message takes its attachments with it.
 *
 * @module dsh-feishu-bridge/tests-recall
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState, type QueuedMessage } from '../../src/engine/engine.js'
import { cancelQueuedByMessageID, markRecalledPreview } from '../../src/engine/recall.js'
import type { Platform } from '../../src/core/types.js'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.js'
import { newStreamPreview } from '../../src/streaming.js'

function newEngine(): { e: Engine; p: StubPlatform } {
  const p = createStubPlatform('test')
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  return { e, p }
}

function queued(p: Platform, messageID: string, content: string): QueuedMessage {
  return {
    platform: p,
    replyCtx: `reply-ctx-${messageID}`,
    messageID,
    content,
    images: [],
    files: [],
    fromVoice: false,
    isSpawnedGroup: false,
    userID: '',
    userName: '',
    msgPlatform: 'test',
    msgSessionKey: 'test:chat-1:user-1',
    metadata: undefined,
  }
}

describe('cancelQueuedByMessageID', () => {
  it('splices a matching queued message and replies with the cancellation notice', () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingMessages.push(queued(p, 'om_other', 'other'), queued(p, 'om_abc', 'target'))
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelQueuedByMessageID(e, 'om_abc')).toBe('cancelled')

    expect(state.pendingMessages.length).toBe(1)
    expect(state.pendingMessages[0]?.messageID).toBe('om_other')

    const sent = p.getSent()
    expect(sent.length).toBe(1)
    expect(sent[0]).toBe(e.i18n.t('cancel_queued_by_recall'))
  })

  it('leaves the queue untouched and replies nothing for an unknown message id', () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingMessages.push(queued(p, 'om_abc', 'queued'))
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelQueuedByMessageID(e, 'om_does_not_exist')).toBe('not_found')

    expect(state.pendingMessages.length).toBe(1)
    expect(p.getSent().length).toBe(0)
  })

  it('reports an inflight message as already processing', () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.inflightMessage = queued(p, 'om_inflight', 'already dequeued')
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelQueuedByMessageID(e, 'om_inflight')).toBe('inflight')

    const sent = p.getSent()
    expect(sent.length).toBe(1)
    expect(sent[0]).toBe(e.i18n.t('recall_already_processing'))
  })

  it('finds the match across multiple interactive states', () => {
    const { e, p } = newEngine()
    const other = new InteractiveState()
    other.platform = p
    other.replyCtx = 'reply-ctx'
    other.pendingMessages.push(queued(p, 'om_x', 'x'))
    const target = new InteractiveState()
    target.platform = p
    target.replyCtx = 'reply-ctx'
    target.pendingMessages.push(queued(p, 'om_target', 't'))
    e.interactiveStates.set('test:chat-a:user-1', other)
    e.interactiveStates.set('test:chat-b:user-2', target)

    expect(cancelQueuedByMessageID(e, 'om_target')).toBe('cancelled')
    expect(other.pendingMessages.length).toBe(1)
    expect(target.pendingMessages.length).toBe(0)
  })
})

describe('markRecalledPreview', () => {
  /** A started preview whose handle carries a Feishu-style message id. */
  function startedPreview(p: Platform): ReturnType<typeof newStreamPreview> {
    const cfg = { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 500 }
    const starter = Object.assign(p, {
      async sendPreviewStart(): Promise<unknown> {
        return { messageID: 'om_card' }
      },
      async updateMessage(): Promise<void> {},
      async deletePreviewMessage(): Promise<void> {},
    })
    const sp = newStreamPreview(cfg, starter, 'ctx', undefined, undefined, 'test:chat-1:user-1')
    return sp
  }

  it('marks the matching preview recalled (degraded, heal stopped)', async () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    const sp = startedPreview(p)
    await sp.appendText('working')
    state.preview = sp
    e.interactiveStates.set('test:chat-1:user-1', state)
    const recalled = vi.spyOn(sp, 'markRecalled')

    markRecalledPreview(e, 'om_card')
    await recalled.mock.results[0]?.value

    expect(recalled).toHaveBeenCalledTimes(1)
    expect(sp.degraded).toBe(true)
  })

  it('is a no-op for ids no active preview holds', () => {
    const { e, p } = newEngine()
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(() => { markRecalledPreview(e, 'om_none') }).not.toThrow()
  })
})
