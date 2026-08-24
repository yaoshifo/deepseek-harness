/**
 * Streaming preview tests ported from cc-connect core/streaming_test.go
 * (the streamPreview/progressEntry suites; the two Engine bump tests live in
 * tests/engine, and TestBuildSummaryContext lives with the engine-send spec).
 *
 * Timing mirrors Go: real sleeps for throttle/timer windows, awaited
 * stream-preview calls where Go blocked synchronously.
 *
 * @module dsh-feishu-bridge/tests-streaming
 */

import { describe, expect, it, vi } from 'vitest'
import {
  ProgressEntry,
  StreamPreview,
  defaultStreamPreviewCfg,
  maxAnalysisDisplayChars,
  maxConsecutivePatchFailures,
  newStreamPreview,
  newToolProgressEntry,
  parseSkillToolUse,
  type StreamPreviewCfg,
} from '../src/streaming.js'
import { newAsyncSender } from '../src/async-sender.js'
import type { FileAttachment, Platform, ProgressContent, TextPreviewContent } from '../src/core/types.js'
import { previewText, statusOf } from './stubs/preview-content.js'
import { createStubPlatform, type StubPlatform } from './stubs/engine-stubs.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Go mockUpdaterPlatform: Platform + MessageUpdater + PreviewStarter, records messages. */
interface RecorderPlatform extends StubPlatform {
  messages: string[]
  /** Raw structured content per platform call, in order. */
  contents: ProgressContent[]
  sendPreviewStart(rc: unknown, content: ProgressContent): Promise<unknown>
  updateMessage(rc: unknown, content: ProgressContent): Promise<void>
}

function createMockUpdaterPlatform(): RecorderPlatform {
  const messages: string[] = []
  const contents: ProgressContent[] = []
  return Object.assign(createStubPlatform(), {
    messages,
    contents,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      messages.push(`start:${previewText(content)}`)
      contents.push(content)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      messages.push(`update:${previewText(content)}`)
      contents.push(content)
    },
  })
}

/** Slow running PATCH, fast completed PATCH (feishu IO latency simulation). */
function createRaceUpdater(): ReturnType<typeof createMockUpdaterPlatform> {
  const p = createMockUpdaterPlatform()
  const inner = p.updateMessage.bind(p)
  p.updateMessage = async (rc: unknown, content: ProgressContent) => {
    if (statusOf(content)?.state !== 'completed') await sleep(80)
    await inner(rc, content)
  }
  return p
}

/** UpdateMessage always fails; counts calls. */
function createFailingUpdatePlatform(): ReturnType<typeof createMockUpdaterPlatform> & { updateCalls: number } {
  const p = createMockUpdaterPlatform()
  let updateCalls = 0
  p.updateMessage = async () => {
    updateCalls++
    throw new Error('update blocked')
  }
  Object.defineProperty(p, 'updateCalls', { get: () => updateCalls })
  return p as ReturnType<typeof createFailingUpdatePlatform>
}

/** StoppedCardRenderer that records calls. */
function createMockStopRendererPlatform(): ReturnType<typeof createMockUpdaterPlatform> & {
  stoppedCalls: number
  stoppedArg: unknown
  renderStoppedCard: (rc: unknown, previewMsgID: unknown) => Promise<void>
} {
  const p = createMockUpdaterPlatform()
  let stoppedCalls = 0
  let stoppedArg: unknown
  Object.assign(p, {
    async renderStoppedCard(_rc: unknown, previewMsgID: unknown): Promise<void> {
      stoppedCalls++
      stoppedArg = previewMsgID
    },
  })
  Object.defineProperty(p, 'stoppedCalls', { get: () => stoppedCalls })
  Object.defineProperty(p, 'stoppedArg', { get: () => stoppedArg })
  return p as ReturnType<typeof createMockStopRendererPlatform>
}

/** Slow running PATCH + fast stopped-card render, with a stopped marker message. */
function createRaceStopRenderer(): ReturnType<typeof createMockStopRendererPlatform> {
  const p = createMockStopRendererPlatform()
  const inner = p.updateMessage.bind(p)
  p.updateMessage = async (rc: unknown, content: ProgressContent) => {
    await sleep(80) // running PATCHes stay slow; the stopped render is fast
    await inner(rc, content)
  }
  const renderInner = p.renderStoppedCard.bind(p)
  p.renderStoppedCard = async (rc: unknown, previewMsgID: unknown) => {
    p.messages.push('stopped:card')
    await renderInner(rc, previewMsgID)
  }
  return p
}

/** Adds PreviewCleaner recording deletes. */
function createMockCleanerPlatform(): ReturnType<typeof createMockUpdaterPlatform> & { deleted: unknown[] } {
  const p = createMockUpdaterPlatform()
  const deleted: unknown[] = []
  Object.assign(p, {
    async deletePreviewMessage(handle: unknown): Promise<void> {
      deleted.push(handle)
    },
  })
  Object.defineProperty(p, 'deleted', { get: () => deleted })
  return p as ReturnType<typeof createMockCleanerPlatform>
}

function createMockKeepPreviewPlatform(): ReturnType<typeof createMockCleanerPlatform> {
  const p = createMockCleanerPlatform()
  Object.assign(p, { keepPreviewOnFinish: () => true })
  return p
}

/** UpdateMessage failures follow a per-call schedule (undefined = success). */
type FailingUpdaterPlatform = RecorderPlatform & { callCount: number }

function createMockFailingUpdaterPlatform(updateErrors: Array<Error | undefined>): FailingUpdaterPlatform {
  const p = createMockUpdaterPlatform()
  let callCount = 0
  p.updateMessage = async () => {
    const idx = callCount++
    const err = updateErrors[idx]
    if (err !== undefined) throw err
  }
  Object.defineProperty(p, 'callCount', { get: () => callCount })
  return p as FailingUpdaterPlatform
}

/** Feishu-style TransientPatchError: 230020 is a recoverable rate limit. */
function createMockTransientFailingUpdaterPlatform(
  updateErrors: Array<Error | undefined>,
): FailingUpdaterPlatform {
  const p = createMockFailingUpdaterPlatform(updateErrors)
  Object.assign(p, {
    isTransientPatchError(err: unknown): boolean {
      return err instanceof Error && err.message.includes('code=230020')
    },
  })
  return p
}

/** FileSender + PreviewCleaner + updatable stub; controls PATCH/SendFile failures. */
interface FallbackCapablePlatform extends StubPlatform {
  updateCalls: number
  updateErr?: Error
  fileSendErr?: Error
  files: FileAttachment[]
  deleted: unknown[]
  sendPreviewStart(rc: unknown, content: ProgressContent): Promise<unknown>
  updateMessage(rc: unknown, content: ProgressContent): Promise<void>
  sendFile(rc: unknown, file: FileAttachment): Promise<void>
  deletePreviewMessage(handle: unknown): Promise<void>
}

function createFallbackCapablePlatform(opts: { updateErr?: Error; fileSendErr?: Error } = {}): FallbackCapablePlatform {
  let updateCalls = 0
  const files: FileAttachment[] = []
  const deleted: unknown[] = []
  const p = Object.assign(createStubPlatform(), {
    async sendPreviewStart(_rc: unknown, _content: ProgressContent) {
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, _content: ProgressContent) {
      updateCalls++
      if (opts.updateErr !== undefined) throw opts.updateErr
    },
    async sendFile(_rc: unknown, file: FileAttachment) {
      if (opts.fileSendErr !== undefined) throw opts.fileSendErr
      files.push(file)
    },
    async deletePreviewMessage(handle: unknown) {
      deleted.push(handle)
    },
  })
  return Object.defineProperties(p, {
    updateCalls: { get: () => updateCalls },
    files: { get: () => files },
    deleted: { get: () => deleted },
  }) as FallbackCapablePlatform
}

/** Like the fallback platform but without FileSender (forces chunked text). */
function createFallbackNoFilePlatform(updateErr?: Error): FallbackCapablePlatform {
  const p = createFallbackCapablePlatform(updateErr === undefined ? {} : { updateErr })
  const p2 = p as unknown as Record<string, unknown>
  delete p2.sendFile
  return p
}

/** PreviewOverflowReporter stub for the table-overflow path. */
function createMockOverflowPlatform(overflow: boolean): FallbackCapablePlatform & { previewOverflow(content: string): boolean } {
  const p = createFallbackCapablePlatform()
  return Object.assign(p, { previewOverflow: (_content: string) => overflow })
}

/** PreviewCleaner + PreviewStarter minting a distinct handle per call. */
function createMockBumpPlatform(): ReturnType<typeof createMockCleanerPlatform> & { nextID: number } {
  const p = createMockCleanerPlatform()
  let nextID = 0
  Object.assign(p, {
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      nextID++
      p.messages.push(`start:${previewText(content)}`)
      return `handle-${nextID}`
    },
  })
  Object.defineProperty(p, 'nextID', { get: () => nextID })
  return p as ReturnType<typeof createMockBumpPlatform>
}

/** SendPreviewStart that fails on the failOn-th call. */
function createMockBumpFailSendPlatform(failOn: number): ReturnType<typeof createMockCleanerPlatform> & { nextID: number } {
  const p = createMockCleanerPlatform()
  let nextID = 0
  Object.assign(p, {
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      nextID++
      if (nextID === failOn) throw new Error('simulated send failure')
      p.messages.push(`start:${previewText(content)}`)
      return `handle-${nextID}`
    },
  })
  Object.defineProperty(p, 'nextID', { get: () => nextID })
  return p as ReturnType<typeof createMockBumpFailSendPlatform>
}

const err = (msg: string): Error => new Error(msg)

function cfg(over: Partial<StreamPreviewCfg> = {}): StreamPreviewCfg {
  return { enabled: true, intervalMs: 50, minDeltaChars: 1, maxChars: 500, ...over }
}

/** Go newSyncStreamPreviewForFallback: started preview in progress mode. */
async function newSyncStreamPreviewForFallback(p: Platform): Promise<StreamPreview> {
  const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), p, 'ctx', undefined, undefined)
  await sp.appendText('starting')
  await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
  return sp
}

describe('StreamPreview', () => {
  it('basic flow sends a preview start', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 100, minDeltaChars: 5, maxChars: 500 }), mp, 'ctx', undefined, undefined)
    expect(sp.canPreview()).toBe(true)
    await sp.appendText('Hello ')
    await sleep(150)
    expect(mp.messages[0]).toBe('start:Hello ')
  })

  it('logs update failures instead of dropping them silently', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const mp = createFailingUpdatePlatform()
      const sp = newStreamPreview(cfg({ intervalMs: 50, minDeltaChars: 1 }), mp, 'ctx', undefined, undefined)
      await sp.appendText('Hello world')
      await sleep(80) // let SendPreviewStart set previewMsgID
      await sp.freeze() // triggers UpdateMessage on the failing updater
      if (mp.updateCalls === 0) return // UpdateMessage not invoked; nothing to log
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('streaming update skipped'))
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('markStopped delegates to RenderStoppedCard', async () => {
    const mp = createMockStopRendererPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 100, minDeltaChars: 5 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello ')
    await sleep(150)
    await sp.markStopped()
    expect(mp.stoppedCalls).toBe(1)
    expect(mp.stoppedArg).toBe('preview-handle')
  })

  it('stop terminal renders once across markStoppedSync and markStopped, re-armed by resumeFromFreeze', async () => {
    const mp = createMockStopRendererPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 100, minDeltaChars: 5 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello ')
    await sleep(150)
    await sp.markStoppedSync()
    await sp.markStopped()
    expect(mp.stoppedCalls, 'the loser of the two stop renders must not PATCH again').toBe(1)
    await sp.resumeFromFreeze()
    await sp.markStopped()
    expect(mp.stoppedCalls, 'resumeFromFreeze re-arms the stopped render').toBe(2)
  })

  it('a throttled flush scheduled before a stopped render cannot PATCH after it', async () => {
    const mp = createMockStopRendererPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 100, minDeltaChars: 5 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello ')
    await sp.markStopped()
    const sentAtStop = mp.messages.length
    // Delta clears minDeltaChars but sits inside the throttle window, so the
    // flush is timer-deferred — it must never land after the ⏹ card.
    await sp.appendText('World and more text')
    await sleep(200)
    expect(mp.messages.slice(sentAtStop), `messages=${JSON.stringify(mp.messages)}`).toEqual([])
  })

  it('markStoppedSync drains in-flight running PATCH before the stopped card', async () => {
    const mp = createRaceStopRenderer()
    const as = newAsyncSender('test-stop-race')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), mp, 'ctx', undefined, as)
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
      await as.barrier()
      sp.lastProgressFlush = 0 // reset throttle so the next PATCH is immediate
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:02**', body: 'pwd', lang: 'bash', toolID: 't2' }))
      await sp.markStoppedSync()

      const msgs = mp.messages
      expect(msgs.length).toBeGreaterThan(0)
      const last = msgs[msgs.length - 1] ?? ''
      expect(last).toContain('stopped')
      const foundRunning = msgs.some(m => m.includes('update:') && !m.includes('stopped'))
      expect(foundRunning).toBe(true)
    } finally {
      as.close()
    }
  })

  it('markStoppedSync sets degraded (no further running PATCHes)', async () => {
    const mp = createRaceStopRenderer()
    const as = newAsyncSender('test-stop-degraded')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), mp, 'ctx', undefined, as)
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
      await as.barrier()
      const before = mp.messages.length
      await sp.markStoppedSync()
      sp.lastProgressFlush = 0
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:03**', body: 'git', lang: 'bash', toolID: 't3' }))
      await as.barrier()
      expect(mp.messages.length).toBe(before + 1)
    } finally {
      as.close()
    }
  })

  it('markStoppedSync falls back to the failed card without a renderer', async () => {
    const mp = createMockUpdaterPlatform()
    const as = newAsyncSender('test-stop-fallback')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), mp, 'ctx', undefined, as)
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
      await as.barrier()
      await sp.markStoppedSync()
      await as.barrier()
      expect(lastTextContent(mp)?.status?.state).toBe('failed')
    } finally {
      as.close()
    }
  })

  it('throttles rapid updates', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 200, minDeltaChars: 5 }), mp, 'ctx', undefined, undefined)
    for (let i = 0; i < 10; i++) {
      await sp.appendText('ab')
      await sleep(10)
    }
    await sleep(300)
    expect(mp.messages.length).toBeGreaterThan(0)
    expect(mp.messages.length).toBeLessThan(10)
  })

  it('truncates to maxChars', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 50, minDeltaChars: 1, maxChars: 10 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('This is a very long text that exceeds max chars limit')
    await sleep(100)
    expect(mp.messages.length).toBeGreaterThan(0)
    for (const m of mp.messages) {
      const content = m.replace(/^start:|^update:/, '')
      expect(Array.from(content).length).toBeLessThanOrEqual(15)
    }
  })

  it('sends nothing when disabled', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview({ enabled: false, intervalMs: 50, minDeltaChars: 1, maxChars: 500 }, mp, 'ctx', undefined, undefined)
    expect(sp.canPreview()).toBe(false)
    await sp.appendText('Hello')
    await sleep(50)
    expect(mp.messages.length).toBe(0)
  })

  it('finish updates in place with the completion marker', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg(), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello World')
    await sleep(100)
    const ok = await sp.finish('Hello World Final')
    expect(ok).toBe(true)
    const last = lastTextContent(mp)
    expect(last?.status?.state).toBe('completed')
    expect(last?.status?.ts).not.toBe('')
    expect(last?.text).toBe('Hello World Final')
  })

  it('freeze + finish deletes the stale preview', async () => {
    const mp = createMockCleanerPlatform()
    const sp = newStreamPreview(cfg(), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello World')
    await sleep(100)
    await sp.freeze()
    const ok = await sp.finish('Hello World Final')
    expect(ok).toBe(false)
    expect(mp.deleted.length).toBe(1)
  })

  it('cannot preview on a non-updater platform', () => {
    const sp = newStreamPreview(defaultStreamPreviewCfg(), createStubPlatform(), 'ctx', undefined, undefined)
    expect(sp.canPreview()).toBe(false)
  })

  it('discard deletes the preview', async () => {
    const mp = createMockCleanerPlatform()
    const sp = newStreamPreview(cfg(), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello World')
    await sleep(100)
    await sp.discard()
    expect(mp.deleted.length).toBe(1)
    expect(mp.messages).toEqual(['start:Hello World'])
  })

  it('finish keeps the preview when the platform prefers in-place finalize', async () => {
    const mp = createMockKeepPreviewPlatform()
    const sp = newStreamPreview(cfg(), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello World')
    await sleep(100)
    const ok = await sp.finish('Hello World Final')
    expect(ok).toBe(true)
    expect(mp.deleted.length).toBe(0)
    expect(mp.messages.length).toBeGreaterThanOrEqual(2)
    const content = lastTextContent(mp)
    expect(content?.status?.state).toBe('completed')
    expect(content?.text).toBe('Hello World Final')
  })

  it('needsDoneReaction flips after UpdateMessage and clears on discard', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg(), mp, 'ctx', undefined, undefined)
    expect(sp.needsDoneReaction()).toBe(false)
    await sp.appendText('Hello World')
    await sleep(100)
    expect(sp.needsDoneReaction()).toBe(false) // only SendPreviewStart so far
    await sp.appendText(' more text to trigger update')
    await sleep(100)
    expect(mp.messages.some(m => m.startsWith('update:'))).toBe(true)
    expect(sp.needsDoneReaction()).toBe(true)
    await sp.discard()
    expect(sp.needsDoneReaction()).toBe(false)
  })

  it('needsDoneReaction false when disabled', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview({ enabled: false, intervalMs: 50, minDeltaChars: 1, maxChars: 500 }, mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello')
    await sleep(100)
    expect(sp.needsDoneReaction()).toBe(false)
  })

  it('applies the transform to preview and final text', async () => {
    const mp = createMockUpdaterPlatform()
    const transform = (s: string): string => s.replaceAll('/root/code/demo/src/app.ts:42', '📄 `src/app.ts:42`')
    const sp = newStreamPreview(cfg(), mp, 'ctx', transform, undefined)
    await sp.appendText('See /root/code/demo/src/app.ts:42')
    await sleep(100)
    const ok = await sp.finish('Final /root/code/demo/src/app.ts:42')
    expect(ok).toBe(true)
    expect(mp.messages.length).toBeGreaterThanOrEqual(2)
    expect(mp.messages[0]).toBe('start:See 📄 `src/app.ts:42`')
    const last = lastTextContent(mp)
    expect(last?.status?.state).toBe('completed')
    expect(last?.text).toBe('Final 📄 `src/app.ts:42`')
  })

  it('renders the todo section and updates it', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 2000 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(new ProgressEntry({
      header: `**${new Date().toTimeString().slice(0, 8)}**`,
      body: 'echo hello',
      lang: 'bash',
      isTool: true,
      toolName: 'Bash',
    }))
    await sleep(400)
    await sp.updateTodoSection([
      { content: 'Fix authentication bug', status: 'completed' },
      { content: 'Writing unit tests', status: 'in_progress' },
      { content: 'Update documentation', status: 'pending' },
      { content: 'Deploy to staging', status: 'pending' },
    ])
    await sleep(80)
    expect(mp.messages.length).toBeGreaterThanOrEqual(2)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    expect(last).toContain('✅ Fix authentication bug')
    expect(last).toContain('🔄 Writing unit tests')
    expect(last).toContain('⏳ Update documentation')
    expect(last).toContain('⏳ Deploy to staging')
    expect(last).toContain('---')

    await sp.updateTodoSection([
      { content: 'Fix authentication bug', status: 'completed' },
      { content: 'Writing unit tests', status: 'completed' },
      { content: 'Update documentation', status: 'in_progress' },
      { content: 'Deploy to staging', status: 'pending' },
    ])
    await sleep(400)
    const last2 = mp.messages[mp.messages.length - 1] ?? ''
    expect(last2).toContain('✅ Writing unit tests')
    expect(last2).toContain('🔄 Update documentation')
  })

  it('thinking is signaled via the structured status, not the body', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 2000 }), mp, 'ctx', undefined, undefined)
    await sp.appendThinking('some reasoning that should NOT be shown in the body')
    expect(sp.progressStatusLocked().state).toBe('thinking')
    const display = sp.buildProgressDisplayLocked()
    expect(display).not.toContain('some reasoning that should NOT be shown in the body')
    await sp.clearThinking()
    expect(sp.progressStatusLocked().state).toBe('running')
  })

  it('throttle timer resets to nil after firing', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 200 }), mp, 'ctx', undefined, undefined)
    await sp.appendThinking('first chunk')
    const firstFlush = sp.lastProgressFlush
    await sp.appendThinking('second chunk')
    expect(sp.timer).toBeDefined()
    const deadline = Date.now() + 2000
    let fired = false
    while (Date.now() < deadline) {
      fired = sp.lastProgressFlush > firstFlush
      if (fired) break
      await sleep(15)
    }
    expect(fired).toBe(true)
    expect(sp.timer).toBeUndefined()
  })

  it('analysisText defers the expensive rebuild to the timer', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 200 }), mp, 'ctx', undefined, undefined)
    await sp.appendAnalysisText('first chunk')
    const firstFlush = sp.lastProgressFlush
    expect(firstFlush).not.toBe(0)
    expect(sp.analysisText).toBe('first chunk')

    await sp.appendAnalysisText('second chunk')
    expect(sp.timer).toBeDefined()
    expect(sp.lastProgressFlush).toBe(firstFlush)

    const deadline = Date.now() + 2000
    let fired = false
    while (Date.now() < deadline) {
      fired = sp.lastProgressFlush > firstFlush
      if (fired) break
      await sleep(15)
    }
    expect(fired).toBe(true)
    expect(sp.timer).toBeUndefined()
  })

  it('thinking header timestamp stays current while deltas flow', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 200 }), mp, 'ctx', undefined, undefined)
    const end = Date.now() + 1200
    while (Date.now() < end) {
      await sp.appendThinking('thinking harder about the problem')
      await sleep(40)
    }
    await sleep(600)
    expect(mp.messages.length).toBeGreaterThanOrEqual(2)
    const lastTS = lastCCTS(mp)
    expect(lastTS).not.toBe('')
    const lag = Date.now() - parseHMS(lastTS).getTime()
    expect(lag).toBeLessThanOrEqual(2000)
  })

  it('thinking header freezes without events (documented behavior)', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 200 }), mp, 'ctx', undefined, undefined)
    await sp.appendThinking('initial thought')
    await sleep(300)
    const tsAtSilence = lastCCTS(mp)
    expect(tsAtSilence).not.toBe('')
    await sleep(1500)
    expect(lastCCTS(mp)).toBe(tsAtSilence)
    const lag = Date.now() - parseHMS(tsAtSilence).getTime()
    expect(lag).toBeGreaterThanOrEqual(1000)
  })

  it('todo section hidden when empty', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 2000 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('Just working... ')
    await sleep(80)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    expect(last).not.toContain('## 待办事项')
  })

  it('markCompleted cancels the pending throttle timer', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ intervalMs: 300 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('Hello World')
    const before = mp.messages.length
    await sp.markCompleted()
    await sleep(500)
    expect(mp.messages.length).toBeLessThanOrEqual(before + 1)
  })

  it('updateToolResult moves the 🚨 marker to the updated entry', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    for (let i = 0; i < 3; i++) {
      await sp.appendProgress(new ProgressEntry({
        header: `**12:00:0${String(i)}**`,
        body: `tool${i} body`,
        lang: 'bash',
        isTool: true,
        toolID: `tool-${i}`,
        toolName: `Tool${i}`,
      }))
    }
    await sleep(500)
    await sp.updateToolResult('tool-2', 'result for tool 2', true)
    await sleep(500)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    expect(last).toContain('Tool2')
    let tool0Line = ''
    let tool2Line = ''
    for (const line of last.split('\n')) {
      if (line.includes('Tool0')) tool0Line = line
      if (line.includes('Tool2')) tool2Line = line
    }
    expect(tool2Line).not.toBe('')
    expect(tool2Line).toContain('🚨')
    if (tool0Line !== '') expect(tool0Line).not.toContain('🚨')
  })

  it('analysisText is not truncated by MaxChars during streaming', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 100 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(new ProgressEntry({
      header: '**tool**',
      body: 'ls -la',
      lang: 'bash',
      isTool: true,
      toolID: 't-1',
      toolName: 'Bash',
    }))
    await sleep(400)
    const longText = 'x'.repeat(500)
    await sp.appendAnalysisText(longText)
    await sleep(500)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    expect(last).toContain(longText)
    expect(last).not.toContain('已截断')
    expect(sp.analysisText).toBe(longText)
  })

  it('does not degrade on a single PATCH failure', async () => {
    const mp = createMockFailingUpdaterPlatform([undefined, err('flap'), undefined])
    const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('a')
    await sp.appendText('b')
    await sp.appendText('c')
    expect(sp.isDegraded()).toBe(false)
    await sp.appendText('d')
    expect(sp.isDegraded()).toBe(false)
  })

  it('degrades after consecutive PATCH failures', async () => {
    const errs: Array<Error | undefined> = [undefined]
    for (let i = 0; i < maxConsecutivePatchFailures; i++) errs.push(err(`fail-${i}`))
    const mp = createMockFailingUpdaterPlatform(errs)
    const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('a')
    await sp.appendText('b')
    for (let i = 0; i < maxConsecutivePatchFailures - 1; i++) {
      await sp.appendText(`x${i}`)
      expect(sp.isDegraded()).toBe(false)
    }
    await sp.appendText('final')
    expect(sp.isDegraded()).toBe(true)
  })

  it('resets the failure streak on PATCH success', async () => {
    const mp = createMockFailingUpdaterPlatform([undefined, err('e1'), err('e2'), undefined, err('e3'), err('e4')])
    const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, undefined)
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await sp.appendText(s)
    }
    expect(sp.isDegraded()).toBe(false)
  })

  it('async rewind allows retry after a failed PATCH', async () => {
    const mp = createMockFailingUpdaterPlatform([err('flap'), undefined])
    const as = newAsyncSender('test-rewind')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, as)
      await sp.appendText('a')
      await as.barrier()
      await sp.appendText('b') // PATCH fails → lastSentText rewinds to "a"
      await as.barrier()
      expect(sp.isDegraded()).toBe(false)
      await sp.appendText('') // same fullText, but text != lastSentText → PATCH retries
      await as.barrier()
      expect(mp.callCount).toBe(2)
      expect(sp.isDegraded()).toBe(false)
    } finally {
      as.close()
    }
  })

  it('async path degrades after consecutive failures', async () => {
    const errs: Array<Error | undefined> = []
    for (let i = 0; i < maxConsecutivePatchFailures; i++) errs.push(err(`fail-${i}`))
    const mp = createMockFailingUpdaterPlatform(errs)
    const as = newAsyncSender('test-async-degrade')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, as)
      await sp.appendText('a')
      await as.barrier()
      const inputs = ['b', 'c', 'd']
      for (const [i, s] of inputs.entries()) {
        await sp.appendText(s)
        await as.barrier()
        if (i < maxConsecutivePatchFailures - 1) {
          expect(sp.isDegraded()).toBe(false)
        }
      }
      expect(sp.isDegraded()).toBe(true)
    } finally {
      as.close()
    }
  })

  it('transient (230020) PATCH failures never degrade', async () => {
    const errs: Array<Error | undefined> = []
    for (let i = 0; i < maxConsecutivePatchFailures + 2; i++) {
      errs.push(err('feishu: patch message code=230020 msg=This operation triggers the frequency limit'))
    }
    const mp = createMockTransientFailingUpdaterPlatform(errs)
    const as = newAsyncSender('test-async-transient')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, as)
      await sp.appendText('a')
      await as.barrier()
      for (const s of ['b', 'c', 'd', 'e']) {
        await sp.appendText(s)
        await as.barrier()
      }
      expect(sp.isDegraded()).toBe(false)
    } finally {
      as.close()
    }
  })

  it('transient platform still degrades on hard errors', async () => {
    const errs: Array<Error | undefined> = []
    for (let i = 0; i < maxConsecutivePatchFailures; i++) errs.push(err(`hard-fail-${i}`))
    const mp = createMockTransientFailingUpdaterPlatform(errs)
    const as = newAsyncSender('test-async-hard')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, as)
      await sp.appendText('a')
      await as.barrier()
      const inputs = ['b', 'c', 'd']
      for (const [i, s] of inputs.entries()) {
        await sp.appendText(s)
        await as.barrier()
        if (i < maxConsecutivePatchFailures - 1) {
          expect(sp.isDegraded()).toBe(false)
        }
      }
      expect(sp.isDegraded()).toBe(true)
    } finally {
      as.close()
    }
  })

  it('resumeFromFreeze resets the failure streak', async () => {
    const mp = createMockFailingUpdaterPlatform([undefined, err('e1'), err('e2'), err('e3')])
    const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0 }), mp, 'ctx', undefined, undefined)
    await sp.appendText('a')
    await sp.appendText('b')
    await sp.appendText('c')
    await sp.appendText('d')
    expect(sp.isDegraded()).toBe(false)
    await sp.freeze()
    expect(sp.isDegraded()).toBe(true)
    await sp.resumeFromFreeze()
    expect(sp.isDegraded()).toBe(false)
    await sp.appendText('e') // one more failure must not degrade (streak was reset)
    expect(sp.isDegraded()).toBe(false)
  })

  it('fullText survives the progress-mode transition (lead-in section)', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    const answer = '好问题。当前的拒单判断条件确实太宽泛——可能因为资金不足、涨跌停等原因被拒。'
    await sp.appendText(answer)
    await sleep(150)
    await sp.appendProgress(new ProgressEntry({
      header: `**${new Date().toTimeString().slice(0, 8)}**`,
      body: 'edit plan file',
      lang: 'bash',
      isTool: true,
      toolName: 'Edit',
    }))
    await sleep(400)
    const followUp = '现在也请更新测试部分'
    await sp.appendAnalysisText(followUp)
    await sleep(400)
    expect(mp.messages.length).toBeGreaterThan(0)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    const iFull = last.indexOf(answer)
    const iTool = last.indexOf('edit plan file')
    const iAnalysis = last.indexOf(followUp)
    expect(iFull).toBeGreaterThanOrEqual(0)
    expect(iTool).toBeGreaterThanOrEqual(0)
    expect(iAnalysis).toBeGreaterThanOrEqual(0)
    expect(iFull).toBeLessThan(iTool)
    expect(iTool).toBeLessThan(iAnalysis)
  })

  it('progress card without lead-in text has no section-0 divider', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(new ProgressEntry({
      header: `**${new Date().toTimeString().slice(0, 8)}**`,
      body: 'ls -la',
      lang: 'bash',
      isTool: true,
      toolName: 'Bash',
    }))
    await sleep(80)
    expect(mp.messages.length).toBeGreaterThan(0)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    const before = last.slice(0, last.includes('ls -la') ? last.indexOf('ls -la') : undefined)
    expect(before).not.toContain('\n---\n')
  })

  it('background hint leaves the body and rides the content field', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(new ProgressEntry({
      header: `**${new Date().toTimeString().slice(0, 8)}**`,
      body: 'deploy --prod',
      lang: 'bash',
      isTool: true,
      toolName: 'Bash',
    }))
    await sp.setBackgroundHint('💡 1 个后台任务')
    await sleep(400)
    expect(sp.buildProgressDisplayLocked()).not.toContain('💡 1 个后台任务')
    const running = mp.contents[mp.contents.length - 1] as TextPreviewContent
    expect(running.bgTaskHint).toBe('💡 1 个后台任务')
    await sp.setBackgroundHint('')
    await sleep(400)
    const cleared = mp.contents[mp.contents.length - 1] as TextPreviewContent
    expect(cleared.bgTaskHint).toBeUndefined()
  })

  it('completed card keeps the background hint in the body', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(new ProgressEntry({
      header: `**${new Date().toTimeString().slice(0, 8)}**`,
      body: 'deploy --prod',
      lang: 'bash',
      isTool: true,
      toolName: 'Bash',
    }))
    await sp.setBackgroundHint('💡 2 个后台任务')
    await sp.markCompleted()
    const final = mp.contents[mp.contents.length - 1] as TextPreviewContent
    expect(final.text).toContain('💡 2 个后台任务')
  })
})

describe('markCompleted / markFailed fallbacks', () => {
  it('delivers the answer as a file when the PATCH fails (11310)', async () => {
    const mp = createFallbackCapablePlatform({ updateErr: err('feishu: ErrCode 11310 card table number over limit') })
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('Final answer with | a | b |\n|---|---|\n table content')
    await sp.markCompleted()
    expect(mp.deleted.length).toBe(1)
    expect(mp.files.length).toBe(1)
    const file = mp.files[0]
    expect(new TextDecoder().decode(file?.data ?? new Uint8Array())).toContain('Final answer with')
    expect(file?.fileName.endsWith('.md')).toBe(true)
    expect(mp.getSent().length).toBe(0)
  })

  it('falls back to text when the file send fails', async () => {
    const mp = createFallbackCapablePlatform({ updateErr: err('11310'), fileSendErr: err('file upload failed') })
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('Plain text fallback answer')
    await sp.markCompleted()
    expect(mp.deleted.length).toBe(1)
    expect(mp.getSent().join('')).toContain('Plain text fallback answer')
  })

  it('falls back to text when the platform has no FileSender', async () => {
    const mp = createFallbackNoFilePlatform(err('11310'))
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('answer without filesender')
    await sp.markCompleted()
    expect(mp.deleted.length).toBe(1)
    expect(mp.getSent().join('')).toContain('answer without filesender')
  })

  it('markFailed also falls back on PATCH failure', async () => {
    const mp = createFallbackCapablePlatform({ updateErr: err('11310') })
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('partial answer before failure')
    await sp.markFailed()
    expect(mp.deleted.length).toBe(1)
    expect(mp.files.length).toBe(1)
    expect(new TextDecoder().decode(mp.files[0]?.data ?? new Uint8Array())).toContain('partial answer')
  })

  it('no fallback when the PATCH succeeds', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('normal short answer')
    await sp.markCompleted()
    expect(mp.files.length).toBe(0)
    expect(mp.getSent().length).toBe(0)
    expect(mp.deleted.length).toBe(0)
  })

  it('empty answer degrades gracefully', async () => {
    const mp = createFallbackCapablePlatform({ updateErr: err('11310') })
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.markCompleted()
    expect(mp.deleted.length).toBe(1)
    expect(mp.files.length).toBe(0)
    expect(mp.getSent().length).toBe(0)
  })

  it('truncated answer delivered out-of-band on PATCH success', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    const longAnswer = '发'.repeat(maxAnalysisDisplayChars + 500)
    await sp.setAnalysisText(longAnswer)
    await sp.markCompleted()
    expect(mp.files.length).toBe(1)
    expect(new TextDecoder().decode(mp.files[0]?.data ?? new Uint8Array())).toBe(longAnswer)
    expect(mp.deleted.length).toBe(0)
  })

  it('completeAndDetach delivers the truncated answer', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    const longAnswer = '发'.repeat(maxAnalysisDisplayChars + 500)
    await sp.setAnalysisText(longAnswer)
    await sp.completeAndDetach()
    expect(mp.files.length).toBe(1)
    expect(new TextDecoder().decode(mp.files[0]?.data ?? new Uint8Array())).toBe(longAnswer)
  })

  it('completeAndDetach delivers nothing when not truncated', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('short answer')
    await sp.completeAndDetach()
    expect(mp.files.length).toBe(0)
  })

  it('completeAndDetach delivers exactly once across repeated calls', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.setAnalysisText('发'.repeat(maxAnalysisDisplayChars + 500))
    await sp.completeAndDetach()
    await sp.completeAndDetach()
    expect(mp.files.length).toBe(1)
  })
})

describe('buildProgressDisplay truncation', () => {
  it('char-truncates oversized analysis with a note', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    const longAnswer = 'x'.repeat(maxAnalysisDisplayChars + 500)
    sp.analysisText = longAnswer
    const display = sp.buildProgressDisplayLocked()
    expect(sp.analysisTruncated).toBe(true)
    expect(display).toContain('内容过长')
    expect(Array.from(display).length).toBeLessThanOrEqual(maxAnalysisDisplayChars + 500)
    expect(sp.analysisText).toBe(longAnswer)
  })

  describe('table overflow via PreviewOverflowReporter', () => {
    const parts: string[] = []
    for (let i = 0; i < 6; i++) parts.push(`| ${String.fromCharCode(65 + i)} |\n|---|`)
    const answer = parts.join('\n\n')

    it('overflow reported: truncated, full text preserved', () => {
      const p = createMockOverflowPlatform(true)
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), p, 'ctx', undefined, undefined)
      sp.analysisText = answer
      const display = sp.buildProgressDisplayLocked()
      expect(sp.analysisTruncated).toBe(true)
      expect(display).toContain('内容过长')
      for (let i = 0; i < 6; i++) {
        expect(display).toContain(`| ${String.fromCharCode(65 + i)} |`)
      }
    })

    it('no overflow reported: not truncated', () => {
      const p = createMockOverflowPlatform(false)
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), p, 'ctx', undefined, undefined)
      sp.analysisText = answer
      sp.buildProgressDisplayLocked()
      expect(sp.analysisTruncated).toBe(false)
    })
  })
})

describe('terminal finalization of pending tools', () => {
  function findProgressToolEntry(sp: StreamPreview, toolID: string): ProgressEntry | undefined {
    return sp.progressEntries.find(e => e.isTool && e.toolID === toolID)
  }

  it('markCompleted finalizes pending tools as success', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.markCompleted()
    const e = findProgressToolEntry(sp, 't1')
    expect(e?.hasResult).toBe(true)
    expect(e?.success).toBe(true)
    const last = mp.messages[mp.messages.length - 1] ?? ''
    expect(last).not.toContain('🟡')
    expect(last).toContain('🟢')
  })

  it('completeAndDetach finalizes pending tools', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.completeAndDetach()
    const e = findProgressToolEntry(sp, 't1')
    expect(e?.hasResult).toBe(true)
    expect(e?.success).toBe(true)
  })

  it('markFailed finalizes pending tools as failure', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.markFailed()
    const e = findProgressToolEntry(sp, 't1')
    expect(e?.hasResult).toBe(true)
    expect(e?.success).toBe(false)
  })

  it('finalize does not override a real failed result', async () => {
    const mp = createFallbackCapablePlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    await sp.updateToolResult('t1', 'boom', false)
    await sp.markCompleted()
    const e = findProgressToolEntry(sp, 't1')
    expect(e?.hasResult).toBe(true)
    expect(e?.success).toBe(false)
  })
})

describe('completeAndDetach async ordering', () => {
  it('in-flight running PATCH does not overwrite the completed card', async () => {
    const mp = createRaceUpdater()
    const as = newAsyncSender('test-detach-race')
    try {
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), mp, 'ctx', undefined, as)
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
      await as.barrier()
      sp.lastProgressFlush = 0
      await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:02**', body: 'pwd', lang: 'bash', toolID: 't2' }))
      await sp.completeAndDetach()
      await as.barrier()
      const msgs = mp.messages
      expect(msgs.length).toBeGreaterThan(0)
      expect(lastTextContent(mp)?.status?.state).toBe('completed')
    } finally {
      as.close()
    }
  })
})

describe('skill progress entries', () => {
  it('parseSkillToolUse variants', () => {
    const cases: Array<[name: string, toolName: string, input: string, wantSkill: string, wantArgs: string]> = [
      ['claudecode json', 'Skill', '{"skill":"tdd","args":"foo bar"}', 'tdd', 'foo bar'],
      ['claudecode no args', 'Skill', '{"skill":"draw"}', 'draw', ''],
      ['opencode skill=', 'skill', 'skill=tdd', 'tdd', ''],
      ['dsh json name', 'skill', '{"name":"tdd"}', 'tdd', ''],
      ['skill field wins over name', 'Skill', '{"skill":"a","name":"b"}', 'a', ''],
      ['dsh json empty object', 'skill', '{}', '', ''],
      ['non-skill tool', 'Bash', 'ls -la', '', ''],
      ['bad json', 'Skill', 'not json', '', ''],
      ['empty input', 'Skill', '', '', ''],
    ]
    for (const [name, toolName, input, wantSkill, wantArgs] of cases) {
      const [skill, args] = parseSkillToolUse(toolName, input)
      expect([skill, args], name).toEqual([wantSkill, wantArgs])
    }
  })

  it('newToolProgressEntry relabels Skill entries', () => {
    const entry = newToolProgressEntry('Skill', '{"skill":"tdd","args":"do thing"}', 'tid')
    expect(entry.skillName).toBe('tdd')
    expect(entry.body).toBe('do thing')
    expect(entry.fullName).toBe('')
    expect(entry.isTool).toBe(true)
  })

  it('appendProgress accumulates deduped skill names', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(newToolProgressEntry('Skill', '{"skill":"tdd","args":"a"}', 't1'))
    await sp.appendProgress(newToolProgressEntry('Bash', 'ls', 't2'))
    await sp.appendProgress(newToolProgressEntry('Skill', '{"skill":"tdd","args":"b"}', 't3'))
    await sp.appendProgress(newToolProgressEntry('Skill', '{"skill":"draw","args":"c"}', 't4'))
    expect(sp.skillNames).toEqual(['tdd', 'draw'])
  })

  it('card shows the skill summary line and skill tag', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    await sp.appendProgress(newToolProgressEntry('Skill', '{"skill":"tdd","args":"a"}', 't1'))
    await sleep(200)
    const last = mp.messages.length > 0 ? mp.messages[mp.messages.length - 1] ?? '' : ''
    expect(last).toContain('📚 技能：tdd')
    expect(last).toContain("<text_tag color='blue'>📚 tdd</text_tag>")
  })

  it('render uses the skill tag, not the generic Skill label', () => {
    const e = new ProgressEntry({
      header: '**12:00:00**',
      body: 'args body',
      isTool: true,
      toolName: 'Skill',
      skillName: 'tdd',
      seq: 1,
    })
    const out = e.render(false)
    expect(out).toContain('📚 tdd')
    expect(out).not.toContain('📚 Skill')
  })

  it('render falls back to the 📚 generic tag for unparseable dsh skill calls', () => {
    const e = newToolProgressEntry('skill', '{"x":1}', 'tid')
    expect(e.skillName).toBe('')
    const out = e.render(false)
    expect(out).toContain("<text_tag color='blue'>📚 skill</text_tag>")
  })
})

describe('subagent progress entries', () => {
  it('render labels the header line subagent and keeps the real tool in the body', () => {
    const e = newToolProgressEntry('subagent', 'ls -la', 'child-1:c1')
    e.fullName = 'read'
    e.seq = 3
    const out = e.render(false)
    expect(out).toContain("<text_tag color='blue'>⚙️ subagent</text_tag> · 3")
    expect(out).toContain('read -> ls -la')
  })

  it('setSubagentCount shows and hides the cumulative-count stats line', async () => {
    const mp = createMockUpdaterPlatform()
    const sp = newStreamPreview(cfg({ maxChars: 5000 }), mp, 'ctx', undefined, undefined)
    // Before any progress entry the count parks without a card flush.
    await sp.setSubagentCount(3)
    await sp.appendProgress(newToolProgressEntry('Bash', 'ls', 't1'))
    expect(sp.buildProgressDisplayLocked()).toContain('🤖 Sub Agent：3')
    await sp.setSubagentCount(2)
    expect(sp.buildProgressDisplayLocked()).toContain('🤖 Sub Agent：2')
    await sp.setSubagentCount(0)
    expect(sp.buildProgressDisplayLocked()).not.toContain('Sub Agent')
    // Unchanged counts skip the flush (no new message beyond the count change).
    const before = mp.messages.length
    await sp.setSubagentCount(0)
    expect(mp.messages.length).toBe(before)
  })
})

describe('bump to end', () => {
  it('reissues the card and deletes the old one', async () => {
    const mp = createMockBumpPlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    const oldHandle = sp.previewMsgID
    expect(oldHandle).toBeDefined()
    await sp.bumpToEnd()
    expect(mp.nextID).toBeGreaterThanOrEqual(2)
    expect(mp.deleted).toEqual([oldHandle])
    expect(sp.previewMsgID).not.toBe(oldHandle)
  })

  it('is a no-op when inactive (nil/completed/failed/degraded)', async () => {
    const mk = (): { mp: ReturnType<typeof createMockBumpPlatform>; sp: StreamPreview } => {
      const mp = createMockBumpPlatform()
      const sp = newStreamPreview(cfg({ intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }), mp, 'ctx', undefined, undefined)
      return { mp, sp }
    }
    type BumpResult = { mp: ReturnType<typeof createMockBumpPlatform>; sp: StreamPreview }
    type BumpCase = [name: string, setup: () => BumpResult | Promise<BumpResult>, baseStarts: number]
    const cases: Array<BumpCase> = [
      ['nil', mk, 0],
      ['completed', async () => {
        const mp = createMockBumpPlatform()
        const sp = await newSyncStreamPreviewForFallback(mp)
        sp.completed = true
        return { mp, sp }
      }, 1],
      ['failed', async () => {
        const mp = createMockBumpPlatform()
        const sp = await newSyncStreamPreviewForFallback(mp)
        sp.failed = true
        return { mp, sp }
      }, 1],
      ['degraded', async () => {
        const mp = createMockBumpPlatform()
        const sp = await newSyncStreamPreviewForFallback(mp)
        sp.degraded = true
        return { mp, sp }
      }, 1],
    ]
    for (const [name, setup, baseStarts] of cases) {
      const { mp, sp } = await setup()
      await sp.bumpToEnd()
      expect(mp.nextID, name).toBe(baseStarts)
      expect(mp.deleted.length, name).toBe(0)
    }
  })

  it('back-to-back bumps both run (last bump wins)', async () => {
    const mp = createMockBumpPlatform()
    const sp = await newSyncStreamPreviewForFallback(mp)
    const firstHandle = sp.previewMsgID
    await sp.bumpToEnd()
    await sp.bumpToEnd()
    expect(mp.nextID).toBe(3)
    expect(sp.previewMsgID).toBe('handle-3')
    expect(mp.deleted).toEqual([firstHandle, 'handle-2'])
  })

  it('send failure keeps the old card', async () => {
    const mp = createMockBumpFailSendPlatform(2)
    const sp = await newSyncStreamPreviewForFallback(mp)
    const oldHandle = sp.previewMsgID
    await sp.bumpToEnd()
    expect(sp.previewMsgID).toBe(oldHandle)
    expect(mp.deleted.length).toBe(0)
  })
})

/** Last recorded content's text-path view, when it is text content. */
function lastTextContent(mp: RecorderPlatform): TextPreviewContent | undefined {
  const c = mp.contents[mp.contents.length - 1]
  return c?.kind === 'text' ? c : undefined
}

/** Pull the last status timestamp out of the recorded contents. */
function lastCCTS(mp: RecorderPlatform): string {
  for (let i = mp.contents.length - 1; i >= 0; i--) {
    const c = mp.contents[i]
    const ts = c === undefined ? '' : statusOf(c)?.ts ?? ''
    if (ts !== '') return ts
  }
  return ''
}

/** Parse "HH:MM:SS" as today's local time. */
function parseHMS(ts: string): Date {
  const [h, m, s] = ts.split(':').map(part => Number.parseInt(part, 10))
  const d = new Date()
  d.setHours(h ?? 0, m ?? 0, s ?? 0, 0)
  return d
}
