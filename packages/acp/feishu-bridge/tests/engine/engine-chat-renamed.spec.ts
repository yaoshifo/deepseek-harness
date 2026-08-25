/**
 * Chat-renamed wiring (Go engine.go platform startup + handleChatRenamed):
 * engine.start() registers the rename/changed handlers on every platform
 * exposing them; a rename syncs the renamed chat's own session Name and the
 * ParentChatName of children pointing at it, so jump-button labels stay
 * current; the changed handler lands in the debounced preview bump.
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { createStubAgent, createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.js'
import type { Platform } from '../../src/core/types.js'
import { StreamPreview } from '../../src/streaming.js'

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

describe('stopInteractiveSession drops the bump binding', () => {
  it('a stopped session no longer bumps its bound preview', () => {
    const p = createStubPlatform('test')
    const e = newEngine(p)
    const key = 'test:chat'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)
    const sp = new StreamPreview(
      { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 500 }, p, 'ctx', undefined, undefined, key,
    )
    const bump = vi.spyOn(sp, 'bumpToEnd')
    e.bindActivePreview(sp, key)

    e.stopInteractiveSession(key)
    e.bumpActivePreviewForSession(key)

    // Post-teardown rename/avatar notices must not reissue the dying
    // preview as a fresh running card (2026-08-25 oc_d22d incident).
    expect(bump).not.toHaveBeenCalled()

    // Another session's binding survives an unrelated stop.
    const sp2 = new StreamPreview(
      { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 500 }, p, 'ctx', undefined, undefined, 'test:other',
    )
    const bump2 = vi.spyOn(sp2, 'bumpToEnd')
    e.bindActivePreview(sp2, 'test:other')
    e.bumpActivePreviewForSession('test:other')
    expect(bump2).toHaveBeenCalledTimes(1)
  })
})
