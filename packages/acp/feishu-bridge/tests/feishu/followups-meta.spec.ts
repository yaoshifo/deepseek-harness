/**
 * FollowupsMetaStore: unclicked registrations are evicted on write once past
 * the retention window, keeping the sidecar bounded across long-lived and
 * spawned chats; settle() drains the serialized mutation queue for callers
 * that must observe persisted state.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FollowupsMetaStore, type AskCardMeta } from '../../src/feishu/followups-meta.ts'

const meta: AskCardMeta = {
  question: { question: 'q', header: '', options: [{ label: 'A', description: '' }], multiSelect: true },
  qIdx: 0,
  total: 1,
  followups: true,
}

describe('FollowupsMetaStore retention', () => {
  it('sweeps entries older than the retention window on write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwmeta-'))
    const file = join(dir, 'fw_meta.json')
    const store = new FollowupsMetaStore(file)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
      await store.set('k-old', meta)
      vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
      await store.set('k-fresh', meta)
    } finally {
      vi.useRealTimers()
    }

    const reloaded = new FollowupsMetaStore(file)
    await reloaded.load()
    expect(reloaded.metas().map(([key]) => key)).toEqual(['k-fresh'])
  })

  it('keeps a fresh entry across repeated writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwmeta-'))
    const file = join(dir, 'fw_meta.json')
    const store = new FollowupsMetaStore(file)
    await store.set('k', meta)
    await store.set('k', { ...meta, question: { ...meta.question, question: 'q2' } })

    const reloaded = new FollowupsMetaStore(file)
    await reloaded.load()
    expect(reloaded.metas()).toHaveLength(1)
    expect(reloaded.metas()[0]![1].question.question).toBe('q2')
  })
})

describe('FollowupsMetaStore queue drain', () => {
  it('settle drains fire-and-forget mutations so a fresh generation reads the final state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwmeta-'))
    const file = join(dir, 'fw_meta.json')
    const store = new FollowupsMetaStore(file)
    // Fire-and-forget, as the platform issues them: a set then a consuming
    // delete back-to-back.
    void store.set('k', meta)
    void store.delete('k')
    await store.settle()

    const reloaded = new FollowupsMetaStore(file)
    await reloaded.load()
    expect(reloaded.metas()).toHaveLength(0)
  })
})
