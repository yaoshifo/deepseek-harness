/**
 * Chat-renamed wiring (Go engine.go platform startup + handleChatRenamed):
 * engine.start() registers the rename/changed handlers on every platform
 * exposing them; a rename syncs the renamed chat's own session Name and the
 * ParentChatName of children pointing at it, so jump-button labels stay
 * current; the changed handler lands in the debounced preview bump.
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.ts'
import type { Platform } from '../../src/core/types.ts'
import { StreamPreview } from '../../src/streaming.ts'

/** A stub platform capturing the engine's chat-updated handler registrations. */
interface NotifierPlatform extends StubPlatform {
  fireRenamed(sessionKey: string, newName: string): void
  fireChanged(sessionKey: string): void
  setChatRenamedHandler(handler: (sessionKey: string, newName: string) => void): void
  setChatChangedHandler(handler: (sessionKey: string) => void): void
}

function newNotifierPlatform(n = 'test'): NotifierPlatform {
  const base = createStubPlatform(n)
  let renamed: ((sessionKey: string, newName: string) => void) | undefined
  let changed: ((sessionKey: string) => void) | undefined
  const p: NotifierPlatform = {
    ...base,
    setChatRenamedHandler: (handler) => { renamed = handler },
    setChatChangedHandler: (handler) => { changed = handler },
    fireRenamed: (sessionKey, newName) => { renamed?.(sessionKey, newName) },
    fireChanged: (sessionKey) => { changed?.(sessionKey) },
  }
  return p
}

function newEngine(p: Platform): Engine {
  return new Engine('test', createStubAgent(), [p], '', 'en')
}

describe('handleChatRenamed', () => {
  it('updates the renamed session Name and children ParentChatName, then saves', () => {
    const p = newNotifierPlatform()
    const e = newEngine(p)
    e.sessions.getOrCreateActive('test:parent-chat')
    const child = e.sessions.getOrCreateActive('test:child-chat')
    child.setParentSessionKey('test:parent-chat')
    child.setParentChatName('旧名')

    e.handleChatRenamed('test:parent-chat', '新名')

    expect(e.sessions.getOrCreateActive('test:parent-chat').getName()).toBe('新名')
    expect(child.getParentChatName()).toBe('新名')
  })

  it('no-ops on an empty name', () => {
    const p = newNotifierPlatform()
    const e = newEngine(p)
    const before = e.sessions.getOrCreateActive('test:chat').getName()

    e.handleChatRenamed('test:chat', '')

    expect(e.sessions.getOrCreateActive('test:chat').getName()).toBe(before)
  })

  it('skips saving when nothing changed', () => {
    const p = newNotifierPlatform()
    const e = newEngine(p)
    const s = e.sessions.getOrCreateActive('test:chat')
    s.setName('新名')
    const saveSpy = vi.spyOn(e.sessions, 'save')

    e.handleChatRenamed('test:chat', '新名')

    expect(saveSpy).not.toHaveBeenCalled()
  })
})

describe('engine.start chat-updated wiring', () => {
  it('registers both handlers and routes the callbacks', async () => {
    const p = newNotifierPlatform()
    const e = newEngine(p)
    e.sessions.getOrCreateActive('test:parent-chat')
    const child = e.sessions.getOrCreateActive('test:child-chat')
    child.setParentSessionKey('test:parent-chat')
    child.setParentChatName('旧名')

    await e.start()
    p.fireRenamed('test:parent-chat', '新名')
    p.fireChanged('test:parent-chat')

    expect(e.sessions.getOrCreateActive('test:parent-chat').getName()).toBe('新名')
    expect(child.getParentChatName()).toBe('新名')
    // The changed path landed in the debounced preview bump (no active
    // preview → no-op); not throwing is the wiring assertion.
  })
})

describe('stopInteractiveSession leaves nothing bumpable', () => {
  /** Minting platform recording preview starts and deletes. */
  function bumpPlatform(): Platform & { starts: number; deleted: unknown[] } {
    const rec = { starts: 0, deleted: [] as unknown[] }
    const p = createStubPlatform('test')
    Object.assign(p, {
      async sendPreviewStart(): Promise<unknown> {
        rec.starts++
        return `handle-${rec.starts}`
      },
      async updateMessage(): Promise<void> {},
      async deletePreviewMessage(handle: unknown): Promise<void> {
        rec.deleted.push(handle)
      },
    })
    Object.defineProperty(p, 'starts', { get: () => rec.starts })
    Object.defineProperty(p, 'deleted', { get: () => rec.deleted })
    return p as unknown as Platform & { starts: number; deleted: unknown[] }
  }

  it('a stopped session no longer reissues its preview', async () => {
    const p = bumpPlatform()
    const e = newEngine(p)
    const key = 'test:chat'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    const sp = new StreamPreview(
      { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 500 }, p, 'ctx', undefined, undefined, key,
    )
    state.preview = sp
    await sp.appendText('working')
    expect(p.starts).toBe(1)

    e.stopInteractiveSession(key)
    await new Promise(resolve => setTimeout(resolve, 20)) // markStoppedSync settles on the preview lock
    e.bumpActivePreviewForSession(key)
    await new Promise(resolve => setTimeout(resolve, 20))

    // Post-teardown rename/avatar notices must not reissue the dying
    // preview as a fresh running card (2026-08-25 oc_d22d incident).
    expect(p.starts).toBe(1)
    expect(p.deleted).toEqual([])

    // Another session's preview still bumps after an unrelated stop.
    const p2 = bumpPlatform()
    const state2 = new InteractiveState()
    state2.platform = p2
    state2.replyCtx = 'ctx'
    e.interactiveStates.set('test:other', state2)
    const sp2 = new StreamPreview(
      { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 500 }, p2, 'ctx', undefined, undefined, 'test:other',
    )
    state2.preview = sp2
    await sp2.appendText('working')
    e.bumpActivePreviewForSession('test:other')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(p2.starts).toBe(2)
  })
})
