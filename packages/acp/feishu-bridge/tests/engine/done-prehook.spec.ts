/**
 * /done pre-hook dispatch: cmdDone announces the subtree teardown through
 * the `feishuBridge/pre-done` waterfall before cleaning anything, and skips
 * descendants a listener declares fully handled (the chatroom plugin
 * interrupts a live room there and owns its role groups' cleanup). With no
 * listener the teardown runs unchanged.
 *
 * @module dsh-feishu-bridge/tests-engine-done-prehook
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { cmdDone, registerSessionCommands } from '../../src/engine/commands.ts'
import type { BridgeDispatch } from '../../src/bridge-service.ts'
import { createStubAgent, createStubCardPlatformFull, newStubMessage, type StubCardPlatform } from '../stubs/engine-stubs.ts'
import type { Message, ChatPhase } from '../../src/core/types.ts'

/** Card platform recording the avatar/spawned-registry capabilities /done uses. */
interface DoneStubPlatform extends StubCardPlatform {
  doneKeys: Set<string>
  phaseCalls: Array<{ sessionKey: string; phase: string }>
  reactions: string[]
  setChatPhase(sessionKey: string, phase: ChatPhase): Promise<void>
  markSpawnedChatDone(sessionKey: string): Promise<void>
  addReaction(replyCtx: unknown, emoji: string): void
}

function newDonePlatform(): DoneStubPlatform {
  const p = createStubCardPlatformFull('test') as unknown as DoneStubPlatform
  p.doneKeys = new Set<string>()
  p.phaseCalls = []
  p.reactions = []
  p.setChatPhase = async (sessionKey, phase) => { p.phaseCalls.push({ sessionKey, phase }) }
  p.markSpawnedChatDone = async (sessionKey) => { p.doneKeys.add(sessionKey) }
  p.addReaction = (_replyCtx, emoji) => { p.reactions.push(emoji) }
  return p
}

/** Bridge dispatch recording waterfall channels; test listeners answer through `on`. */
interface FakeDispatch extends BridgeDispatch {
  calls: Array<{ name: string; payload: unknown }>
  on(name: 'feishuBridge/pre-done', listener: (payload: { engine: Engine; sessionKey: string; handled: string[] }, next: () => void) => void): void
}

function fakeDispatch(): FakeDispatch {
  const listeners: Array<(payload: { engine: Engine; sessionKey: string; handled: string[] }, next: () => void) => void> = []
  const calls: Array<{ name: string; payload: unknown }> = []
  const impl = {
    calls,
    on: (_name: 'feishuBridge/pre-done', listener: (payload: { engine: Engine; sessionKey: string; handled: string[] }, next: () => void) => void) => { listeners.push(listener) },
    emit: () => undefined,
    serial: () => Promise.resolve(undefined),
    waterfall: (name: string, ...args: unknown[]) => {
      calls.push({ name, payload: args[0] })
      const base = args[args.length - 1] as () => unknown
      if (listeners.length === 0) return base()
      let i = 0
      const run = (): unknown => {
        const l = listeners[i++]
        if (l === undefined) return base()
        l(args[0] as { engine: Engine; sessionKey: string; handled: string[] }, run)
        return undefined
      }
      return run()
    },
  }
  return impl as unknown as FakeDispatch
}

function doneMsg(content: string, sessionKey: string): Message {
  return { ...newStubMessage(), sessionKey, userID: 'u1', replyCtx: 'ctx', content, chatType: 'group' }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`)
    await settle()
  }
}

/** An engine whose hub chat has two child sessions parented on it. */
function newEngineWithSubtree(): { e: Engine; p: DoneStubPlatform; d: FakeDispatch; dispose: () => void } {
  const p = newDonePlatform()
  const d = fakeDispatch()
  const e = new Engine('test', createStubAgent(), [p], '', 'en', d)
  const dispose = registerSessionCommands(e)
  const hubKey = 'test:hub:u1'
  for (const name of ['child-a', 'child-b']) {
    e.sessions.getOrCreateActive(`test:${name}:u1`).setParentSessionKey(hubKey)
  }
  e.sessions.getOrCreateActive(hubKey)
  return { e, p, d, dispose }
}

describe('cmdDone pre-done dispatch', () => {
  it('announces the teardown on feishuBridge/pre-done with engine, sessionKey, and handled', async () => {
    const { e, p, d, dispose } = newEngineWithSubtree()
    try {
      d.on('feishuBridge/pre-done', (_payload, next) => { next() })
      await cmdDone(e, p, doneMsg('/done', 'test:hub:u1'), [])
      await waitFor(() => p.doneKeys.has('test:hub:u1'), 'hub teardown')

      const call = d.calls.find(c => c.name === 'feishuBridge/pre-done')
      expect(call, 'pre-done dispatched').toBeDefined()
      expect(call!.payload).toMatchObject({ engine: e, sessionKey: 'test:hub:u1' })
      expect((call!.payload as { handled: string[] }).handled).toEqual([])
    } finally {
      dispose()
    }
  })

  it('skips descendants a listener pushed into handled; the rest still clean', async () => {
    const { e, p, d, dispose } = newEngineWithSubtree()
    try {
      d.on('feishuBridge/pre-done', (payload, next) => {
        payload.handled.push('test:child-a:u1')
        next()
      })
      await cmdDone(e, p, doneMsg('/done', 'test:hub:u1'), [])
      await waitFor(() => p.doneKeys.has('test:hub:u1'), 'hub teardown')

      // The handled child was not re-cleaned by /done's own loop.
      expect(p.doneKeys.has('test:child-a:u1')).toBe(false)
      expect(p.phaseCalls.find(c => c.sessionKey === 'test:child-a:u1')).toBeUndefined()
      // The unhandled child and the root chat were cleaned as before.
      expect(p.doneKeys.has('test:child-b:u1')).toBe(true)
      expect(p.phaseCalls.find(c => c.sessionKey === 'test:child-b:u1')?.phase).toBe('done')
      expect(p.doneKeys.has('test:hub:u1')).toBe(true)
      expect(p.reactions).toContain('Done')
    } finally {
      dispose()
    }
  })

  it('with no listener the teardown cleans every descendant unchanged', async () => {
    const { e, p, d, dispose } = newEngineWithSubtree()
    try {
      expect(d.calls.length).toBe(0) // no listener registered anywhere
      await cmdDone(e, p, doneMsg('/done', 'test:hub:u1'), [])
      await waitFor(() => p.doneKeys.has('test:hub:u1'), 'hub teardown')

      expect(d.calls.map(c => c.name)).toEqual(['feishuBridge/pre-done'])
      expect(p.doneKeys.has('test:child-a:u1')).toBe(true)
      expect(p.doneKeys.has('test:child-b:u1')).toBe(true)
      // The recursive summary still counts every descendant the bridge cleaned.
      expect(p.sent.some(s => s.includes('2') && s.includes('sub-task'))).toBe(true)
    } finally {
      dispose()
    }
  })
})
