/**
 * Ported from cc-connect core/engine_recall_test.go (#30 消息撤回取消):
 * CancelQueuedByMessageID splices a recalled message out of the pending
 * queue (or reports it inflight) and replies on the matched platform.
 * cancelStagedAttachmentsByMessageID covers the pure-attachment branch the
 * TS port originally skipped: a recalled upload drops its staged entries and
 * cached files, reports what remains staged, and leaves other messages'
 * attachments alone.
 *
 * @module dsh-feishu-bridge/tests-recall
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState, type QueuedMessage } from '../../src/engine/engine.ts'
import { cancelQueuedByMessageID, cancelStagedAttachmentsByMessageID, markRecalledPreview } from '../../src/engine/recall.ts'
import type { Agent, Message, Platform } from '../../src/core/types.ts'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.ts'
import { newStreamPreview } from '../../src/streaming.ts'

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

describe('cancelStagedAttachmentsByMessageID', () => {
  /** A state holding one staged file per message id inside a real tmp dir. */
  function stagedState(p: StubPlatform, ...ids: string[]): { state: InteractiveState; dir: string; paths: Map<string, string> } {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'))
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingDir = dir
    const paths = new Map<string, string>()
    for (const id of ids) {
      const path = join(dir, `${id}.pdf`)
      writeFileSync(path, id)
      paths.set(id, path)
      state.pendingAttachments.push({ messageID: id, kind: 'file', path })
    }
    return { state, dir, paths }
  }

  it('removes only the matching entries, deletes their files, and replies', async () => {
    const { e, p } = newEngine()
    const { state, dir, paths } = stagedState(p, 'om_keep', 'om_gone')
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelStagedAttachmentsByMessageID(e, 'om_gone')).toBe(true)

    expect(state.pendingAttachments.map(a => a.messageID)).toEqual(['om_keep'])
    await vi.waitFor(() => { expect(existsSync(paths.get('om_gone') ?? '')).toBe(false) })
    expect(existsSync(paths.get('om_keep') ?? '')).toBe(true)
    // Other staged files keep the pending dir alive.
    expect(state.pendingDir).toBe(dir)
    const sent = p.getSent()
    expect(sent.length).toBe(1)
    expect(sent[0]).toBe(e.i18n.tf('attachments_cancelled_by_recall', ': om_gone.pdf', 0, 1))
  })

  it('removes the pending dir once no staged entry remains', async () => {
    const { e, p } = newEngine()
    const { state, dir, paths } = stagedState(p, 'om_last')
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelStagedAttachmentsByMessageID(e, 'om_last')).toBe(true)

    expect(state.pendingAttachments).toHaveLength(0)
    expect(state.pendingDir).toBe('')
    await vi.waitFor(() => { expect(existsSync(dir)).toBe(false) })
    expect(existsSync(paths.get('om_last') ?? '')).toBe(false)
  })

  it('keeps a file another staged entry still references (aliased paths, hand-built)', async () => {
    const { e, p } = newEngine()
    const dir = mkdtempSync(join(tmpdir(), 'recall-shared-'))
    const shared = join(dir, 'report.pdf')
    writeFileSync(shared, 'X')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingDir = dir
    state.pendingAttachments = [
      { messageID: 'om_1', kind: 'file', path: shared },
      { messageID: 'om_2', kind: 'file', path: shared },
    ]
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelStagedAttachmentsByMessageID(e, 'om_1')).toBe(true)

    expect(state.pendingAttachments.map(a => a.messageID)).toEqual(['om_2'])
    expect(state.pendingDir).toBe(dir)
    // The shared path survives deletion; only the notice fires.
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(existsSync(shared)).toBe(true)
    expect(p.getSent().length).toBe(1)
  })

  it('is a no-op for an id nothing staged matches', () => {
    const { e, p } = newEngine()
    const { state, paths } = stagedState(p, 'om_abc')
    e.interactiveStates.set('test:chat-1:user-1', state)

    expect(cancelStagedAttachmentsByMessageID(e, 'om_none')).toBe(false)

    expect(state.pendingAttachments).toHaveLength(1)
    expect(existsSync(paths.get('om_abc') ?? '')).toBe(true)
    expect(p.getSent().length).toBe(0)
  })
})

describe('engine.start recall wiring', () => {
  /** A stub platform capturing the engine's recall handler registration. */
  interface RecallPlatform extends StubPlatform {
    fireRecall(messageID: string): void
    setRecallHandler(handler: (messageID: string) => void): void
  }

  function newRecallPlatform(): RecallPlatform {
    const base = createStubPlatform('test')
    let recall: ((messageID: string) => void) | undefined
    const p: RecallPlatform = {
      ...base,
      setRecallHandler: (handler) => { recall = handler },
      fireRecall: (messageID) => { recall?.(messageID) },
    }
    return p
  }

  function workDirAgent(workDir: string): Agent & { getWorkDir(): string } {
    return {
      ...createStubAgent(),
      getWorkDir: () => workDir,
    }
  }

  function msg(overrides: Partial<Message> = {}): Message {
    return {
      sessionKey: 'testchat',
      platform: 'test',
      messageID: 'om_file',
      userID: '',
      userName: '',
      chatName: '',
      chatType: '',
      content: '',
      originalContent: '',
      images: [],
      files: [],
      extraContent: '',
      replyCtx: 'ctx',
      fromVoice: false,
      isSpawnedGroup: false,
      isPermissionAction: false,
      isAskqCardAction: false,
      isCardAction: false,
      parentMessageID: '',
      quotedText: '',
      ...overrides,
    }
  }

  it('cancels staged attachments and queued messages through the one handler', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'recall-wire-'))
    const p = newRecallPlatform()
    const e = new Engine('test', workDirAgent(workDir), [p], '', 'en')
    await e.start()

    // Staged branch: stage a file upload, then recall its message.
    e.stageAttachments(p, msg({
      files: [{ mimeType: 'application/pdf', data: new TextEncoder().encode('PDFDATA'), fileName: 'report.pdf' }],
    }), 'testchat')
    const st = e.interactiveStates.get('testchat')
    expect(st?.pendingAttachments).toHaveLength(1)
    const stagedPath = st?.pendingAttachments[0]?.path ?? ''
    expect(stagedPath).not.toBe('')
    p.clearSent()

    p.fireRecall('om_file')

    expect(st?.pendingAttachments).toHaveLength(0)
    expect(st?.pendingDir).toBe('')
    await vi.waitFor(() => { expect(existsSync(stagedPath)).toBe(false) })
    expect(p.getSent()).toEqual([e.i18n.tf('attachments_cancelled_by_recall', ': report.pdf', 0, 0)])

    // Queued branch through the same handler: a queued text message cancels.
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'reply-ctx'
    state.pendingMessages.push(queued(p, 'om_text', 'hello'))
    e.interactiveStates.set('test:chat-2:user-1', state)
    p.clearSent()

    p.fireRecall('om_text')

    expect(state.pendingMessages).toHaveLength(0)
    expect(p.getSent()).toEqual([e.i18n.t('cancel_queued_by_recall')])
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
