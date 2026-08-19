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

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState, type QueuedMessage } from '../../src/engine/engine.js'
import { cancelQueuedByMessageID } from '../../src/engine/recall.js'
import type { Platform } from '../../src/core/types.js'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.js'

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
    chatroomAskSeq: 0,
    chatroomAwaitAssistant: false,
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
