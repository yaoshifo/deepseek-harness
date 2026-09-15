/**
 * SessionManager.save() trailing debounce (2026-09-13 chatroom postmortem):
 * every save() fully serialized and atomically wrote the store, and the
 * chatroom turn-start path fires one per turn. save() now coalesces into one
 * trailing write per 1s window; flushNow() writes a pending save immediately
 * and dispose()/process-beforeExit never leave state behind.
 *
 * @module dsh-feishu-bridge/tests-session-save-debounce
 */

import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from '../../src/engine/session.ts'
import { Engine } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.ts'

/** Counted real writes through the mocked atomic writer. */
const writes = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../src/atomicwrite.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/atomicwrite.ts')>()
  return {
    ...actual,
    atomicWriteFileSync: (path: string, data: Uint8Array, perm: number): void => {
      writes.count++
      actual.atomicWriteFileSync(path, data, perm)
    },
  }
})

async function tempSessionsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fb-save-debounce-'))
  return join(dir, 'sessions.json')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager save debounce', () => {
  it('coalesces N consecutive saves into one trailing write', async () => {
    vi.useFakeTimers()
    const path = await tempSessionsPath()
    const sm = new SessionManager(path)
    sm.getOrCreateActive('user1')
    const baseline = writes.count // the creation itself persisted synchronously

    for (let i = 0; i < 5; i++) sm.save()
    expect(writes.count, 'no write before the debounce window closes').toBe(baseline)

    vi.advanceTimersByTime(1000)

    expect(writes.count, 'exactly one trailing write').toBe(baseline + 1)
    const snap = JSON.parse(readFileSync(path, 'utf8')) as { userSessions: Record<string, string[]> }
    expect(snap.userSessions.user1).toHaveLength(1)
    sm.dispose()
  })

  it('flushNow writes a pending save immediately', async () => {
    const path = await tempSessionsPath()
    const sm = new SessionManager(path)
    sm.getOrCreateActive('user1')
    const baseline = writes.count // the creation itself persisted synchronously

    sm.save()
    expect(writes.count, 'the debounced save has not landed yet').toBe(baseline)

    sm.flushNow()
    expect(writes.count, 'flushNow writes without waiting for the window').toBe(baseline + 1)
    const snap = JSON.parse(readFileSync(path, 'utf8')) as { userSessions: Record<string, string[]> }
    expect(snap.userSessions.user1).toHaveLength(1)
    sm.dispose()
  })

  it('dispose flushes at once and leaves nothing pending', async () => {
    vi.useFakeTimers()
    const path = await tempSessionsPath()
    const sm = new SessionManager(path)
    const baseline = writes.count

    sm.save()
    sm.dispose()
    expect(writes.count, 'dispose flushes the pending write immediately').toBe(baseline + 1)

    vi.advanceTimersByTime(5000)
    expect(writes.count, 'the cancelled timer writes nothing more').toBe(baseline + 1)
    // A later flushNow with nothing pending is a no-op, not a spurious write.
    sm.flushNow()
    expect(writes.count).toBe(baseline + 1)
  })
})

describe('SIGTERM flush of pending debounced saves', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a SIGTERM flushes the pending debounced save and re-raises the default death', async () => {
    const path = await tempSessionsPath()
    // The handler re-raises SIGTERM to keep dying-by-signal semantics; spy
    // it so the emitted (not killed) signal cannot take the worker down.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const e = new Engine('test', createStubAgent(), [createStubPlatform('test')], path, 'en')
    try {
      e.sessions.getOrCreateActive('user1')
      const baseline = writes.count // the creation itself persisted synchronously

      e.sessions.save()
      expect(writes.count, 'the debounced save has not landed yet').toBe(baseline)

      process.emit('SIGTERM', 'SIGTERM')

      expect(writes.count, 'the signal flushed the pending write').toBe(baseline + 1)
      const snap = JSON.parse(readFileSync(path, 'utf8')) as { userSessions: Record<string, string[]> }
      expect(snap.userSessions.user1).toHaveLength(1)
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    } finally {
      await e.stop().catch(() => undefined)
    }
  })

  it('engine stop unregisters the signal hook', async () => {
    const before = process.listenerCount('SIGTERM')
    const e = new Engine('test', createStubAgent(), [createStubPlatform('test')], '', 'en')
    expect(process.listenerCount('SIGTERM'), 'a live engine owns one hook').toBe(before + 1)
    await e.stop()
    expect(process.listenerCount('SIGTERM'), 'the stopped engine leaves no hook behind').toBe(before)
  })
})
