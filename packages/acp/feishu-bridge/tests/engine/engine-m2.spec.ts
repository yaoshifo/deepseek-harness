/**
 * Engine M2 wiring tests ported from cc-connect core: the two Engine bump
 * tests at the tail of streaming_test.go. TestBuildSummaryContext lives with
 * the surviving production copy (predict.spec.ts); the plain-text fallback
 * helper had no production caller and was deleted with its module.
 *
 * @module dsh-feishu-bridge/tests-engine-m2
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { newStreamPreview } from '../../src/streaming.js'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.js'
import type { ProgressContent } from '../../src/core/types.js'
import { previewText } from '../stubs/preview-content.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Go mockBumpPlatform: minting a distinct handle per preview start. */
function createBumpPlatform() {
  const base = {
    messages: [] as string[],
    deleted: [] as unknown[],
    nextID: 0,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      base.nextID++
      base.messages.push(`start:${previewText(content)}`)
      return `handle-${base.nextID}`
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      base.messages.push(`update:${previewText(content)}`)
    },
    async deletePreviewMessage(handle: unknown): Promise<void> {
      base.deleted.push(handle)
    },
    async reply(_rc: unknown, _content: string): Promise<void> {},
  }
  return base
}

function newEngine(): Engine {
  return new Engine('test', createStubAgent(), [], '', 'en')
}

async function newSyncPreviewForFallback(mp: ReturnType<typeof createBumpPlatform>): Promise<ReturnType<typeof newStreamPreview>> {
  const cfg = { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }
  const sp = newStreamPreview(cfg, mp as never, 'ctx', undefined, undefined)
  await sp.appendText('starting')
  const { ProgressEntry } = await import('../../src/streaming.js')
  await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
  return sp
}

describe('Engine bump routing', () => {
  /** Attach sp as the session's active preview (state.preview is the binding). */
  function bindPreview(e: Engine, key: string, sp: ReturnType<typeof newStreamPreview>): void {
    e.ensureInteractiveStateForQueueing(key, createStubPlatform('feishu'), 'ctx')
    e.interactiveStates.get(key)!.preview = sp
  }

  it('bumps only the owning session\'s preview', async () => {
    const mp = createBumpPlatform()
    const sp = await newSyncPreviewForFallback(mp)
    const e = newEngine()
    bindPreview(e, 'feishu:oc_test', sp)

    e.bumpActivePreviewForSession('feishu:oc_test')
    await sleep(50)
    expect(mp.nextID).toBeGreaterThanOrEqual(2)
    expect(mp.deleted.length).toBe(1)

    const before = mp.nextID
    e.bumpActivePreviewForSession('feishu:other')
    await sleep(50)
    expect(mp.nextID).toBe(before)
  })

  it('concurrent sessions each bump their own preview (per-session routing)', async () => {
    const mpA = createBumpPlatform()
    const mpB = createBumpPlatform()
    const spA = await newSyncPreviewForFallback(mpA)
    const spB = await newSyncPreviewForFallback(mpB)
    const e = newEngine()
    bindPreview(e, 'feishu:oc_a', spA)
    bindPreview(e, 'feishu:oc_b', spB)

    e.bumpActivePreviewForSession('feishu:oc_a')
    await sleep(50)
    expect(mpA.nextID).toBeGreaterThanOrEqual(2)
    expect(mpB.nextID).toBe(1) // B's stream did not lose its bump to A

    e.bumpActivePreviewForSession('feishu:oc_b')
    await sleep(50)
    expect(mpB.nextID).toBeGreaterThanOrEqual(2)
  })

  it('onChatChanged debounces rename + avatar into one bump', async () => {
    const e = newEngine()
    e.bumpDebounceInterval = 30
    const mp = createBumpPlatform()
    const sp = await newSyncPreviewForFallback(mp)
    bindPreview(e, 'feishu:oc_test', sp)

    e.onChatChanged('feishu:oc_test')
    e.onChatChanged('feishu:oc_test')
    await sleep(150)

    // One debounced bump: nextID 1→2 (not 3), exactly one delete.
    expect(mp.nextID).toBe(2)
    expect(mp.deleted.length).toBe(1)
  })

  it('onChatChanged debounce timers are per-session — neither chat eats the other', async () => {
    const e = newEngine()
    e.bumpDebounceInterval = 30
    const mpA = createBumpPlatform()
    const mpB = createBumpPlatform()
    const spA = await newSyncPreviewForFallback(mpA)
    const spB = await newSyncPreviewForFallback(mpB)
    bindPreview(e, 'feishu:oc_a', spA)
    bindPreview(e, 'feishu:oc_b', spB)

    e.onChatChanged('feishu:oc_a')
    e.onChatChanged('feishu:oc_b')
    await sleep(150)

    expect(mpA.nextID).toBe(2)
    expect(mpB.nextID).toBe(2)
  })
})
