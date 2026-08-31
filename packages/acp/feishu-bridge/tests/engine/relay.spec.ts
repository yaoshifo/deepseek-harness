/**
 * Relay domain tests ported from cc-connect core/relay_test.go (the 5 relay
 * cases): the manager's default/configured/disabled wait timeout, and
 * Engine.handleRelay's partial-response-on-timeout, error-on-timeout, and
 * stale-resume fallback behaviors, each draining the agent session in the
 * background. The insight-card spin-loop test in that file belongs to the
 * turn-summary domain (M7) and stays unported.
 *
 * Extra TS-only cases cover the binding lifecycle and persistence that Go
 * exercised only through the CLI.
 *
 * Red phase: src/engine/relay.ts and Engine.handleRelay do not exist yet.
 *
 * @module dsh-feishu-bridge/tests-engine-relay
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RelayManager, defaultRelayTimeoutMs, parseSessionKeyParts } from '../../src/engine/relay.ts'
import { Engine } from '../../src/engine/engine.ts'
import { createControllableAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Agent, AgentSession } from '../../src/core/types.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-relay-'))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

describe('RelayManager_DefaultTimeout', () => {
  it('waits 120s by default', () => {
    const rm = new RelayManager('')
    expect(rm.relayTimeoutMs()).toBe(defaultRelayTimeoutMs)
  })
})

describe('RelayManager_RelayContextHonorsConfiguredTimeout', () => {
  it('arms a wait signal when a timeout is configured', () => {
    const rm = new RelayManager('')
    rm.setTimeoutMs(3000)
    expect(rm.relayTimeoutMs()).toBe(3000)
    const signal = rm.relaySignal()
    expect(signal).toBeDefined()
  })
})

describe('RelayManager_RelayContextDisablesTimeoutAtZero', () => {
  it('returns no signal when the timeout is disabled', () => {
    const rm = new RelayManager('')
    rm.setTimeoutMs(0)
    expect(rm.relaySignal()).toBeUndefined()
  })
})

describe('HandleRelay_ReturnsPartialOnTimeout', () => {
  it('returns the partial text and drains the session in the background', async () => {
    const session = newControllableSession('relay-session')
    const e = new Engine('test', createControllableAgent(session), [createStubPlatform()], '', 'en')

    const signal = AbortSignal.timeout(20)
    const done = e.handleRelay(signal, 'source', 'chat-1', 'hello')

    session.channel.push({ type: 'text', content: 'partial response', done: false })
    await sleep(40)
    // After the timeout the caller returns on the abort arm; the background
    // drain consumes the turn's tail and closes the session cleanly.
    session.channel.push({ type: 'thinking', content: 'still working', done: false })
    session.channel.push({ type: 'result', content: 'done', done: true })

    await expect(done).resolves.toBe('partial response')

    await vi.waitFor(() => { expect(session.closed).toBe(true) })
  })
})

describe('HandleRelay_TimeoutWithoutTextReturnsContextError', () => {
  it('rejects with the abort reason when no text arrived', async () => {
    const session = newControllableSession('relay-session')
    const e = new Engine('test', createControllableAgent(session), [createStubPlatform()], '', 'en')

    const signal = AbortSignal.timeout(20)
    const done = e.handleRelay(signal, 'source', 'chat-1', 'hello')
    // Attach the catch before the timeout can fire — the abort arm now
    // rejects as soon as the signal trips, not at the next event.
    const errP = done.catch((e: unknown) => e)

    await sleep(40)
    // One event for the drain goroutine (the caller no longer needs one to
    // unblock its loop).
    session.channel.push({ type: 'result', content: 'done', done: true })

    const err: unknown = await errP
    expect(err).toBeDefined()
    expect(String(err)).toMatch(/abort|timeout/i)

    await vi.waitFor(() => { expect(session.closed).toBe(true) })
  })
})

describe('HandleRelay_ResumeFailureFallsBackToFreshSession', () => {
  it('recovers onto a fresh session when the stored resume id is stale', async () => {
    const freshSession = newControllableSession('fresh-session')
    let callCount = 0
    const agent: Agent = {
      name: () => 'fallback',
      startSession: async (sessionID: string): Promise<AgentSession> => {
        callCount++
        if (callCount === 1 && sessionID !== '') throw new Error('simulated resume failure')
        return freshSession
      },
      listSessions: async () => [],
      stop: async () => {},
    }
    const e = new Engine('test', agent, [createStubPlatform()], '', 'en')

    // Pre-set a stale session ID so the first startSession tries to resume.
    const sess = e.sessions.getOrCreateActive('relay:source:chat-1')
    sess.setAgentSessionID('stale-id', 'fallback')
    e.sessions.save()

    const done = e.handleRelay(undefined, 'source', 'chat-1', 'hello')

    // The fresh session receives the message and responds.
    freshSession.channel.push({ type: 'result', content: 'recovered', done: true })

    await expect(done).resolves.toBe('recovered')
    await vi.waitFor(() => { expect(freshSession.closed).toBe(true) })
  })
})

describe('HandleRelay_TimeoutWithSilentTarget', () => {
  it('returns at the timeout instead of hanging on a target that never emits events', async () => {
    // A target parked inside a long tool call emits nothing; polling the
    // abort flag only after receive() resolves never fires, so the caller's
    // rm.send would hang forever.
    const session = newControllableSession('relay-silent')
    const e = new Engine('test', createControllableAgent(session), [createStubPlatform()], '', 'en')

    const signal = AbortSignal.timeout(20)
    const done = e.handleRelay(signal, 'source', 'chat-1', 'hello')

    const settled: unknown = await Promise.race([
      done.then(
        () => 'resolved',
        (err: unknown) => `rejected:${String(err)}`,
      ),
      sleep(500).then(() => 'HUNG'),
    ])
    expect(settled, 'the relay must return once the wait signal aborts').not.toBe('HUNG')
    expect(String(settled)).toMatch(/rejected:.*(?:abort|timeout)/i)
  })
})

describe('RelayManager bindings (TS-only coverage)', () => {
  it('bind, addToBind, removeFromBind, and listBoundBots manage the binding', () => {
    const rm = new RelayManager('')
    rm.addToBind('feishu', 'chat-1', 'proj-a')
    rm.addToBind('feishu', 'chat-1', 'proj-b')

    const binding = rm.getBinding('chat-1')
    expect(binding?.platform).toBe('feishu')
    expect(Object.keys(binding?.bots ?? {}).sort()).toEqual(['proj-a', 'proj-b'])
    expect(rm.listBoundBots('chat-1', 'proj-a')).toEqual({ 'proj-b': 'proj-b' })

    expect(rm.removeFromBind('chat-1', 'proj-b')).toBe(true)
    expect(rm.getBinding('chat-1')?.bots).toEqual({ 'proj-a': 'proj-a' })
    expect(rm.removeFromBind('chat-1', 'missing')).toBe(false)
    // Removing the last bot drops the binding entirely.
    expect(rm.removeFromBind('chat-1', 'proj-a')).toBe(true)
    expect(rm.getBinding('chat-1')).toBeUndefined()
  })

  it('listBoundBots excludes the calling project', () => {
    const rm = new RelayManager('')
    rm.bind('feishu', 'chat-2', { 'proj-a': 'A Bot', 'proj-b': 'B Bot' })
    expect(rm.listBoundBots('chat-2', 'proj-a')).toEqual({ 'proj-b': 'B Bot' })
  })

  it('persists bindings to relay_bindings.json and reloads them', () => {
    const dir = tempDir()
    const rm = new RelayManager(dir)
    rm.bind('feishu', 'chat-9', { 'proj-a': 'A Bot', 'proj-b': 'B Bot' })

    const rm2 = new RelayManager(dir)
    expect(rm2.getBinding('chat-9')?.bots).toEqual({ 'proj-a': 'A Bot', 'proj-b': 'B Bot' })
  })

  it('send rejects without a binding for the chat', async () => {
    const rm = new RelayManager('')
    await expect(rm.send({ from: 'proj-a', to: 'proj-b', sessionKey: 'feishu:chat-x:u1', message: 'hi' }))
      .rejects.toThrow(/no binding/)
  })
})

describe('parseSessionKeyParts', () => {
  it('splits platform and chat, honoring the relay key form', () => {
    expect(parseSessionKeyParts('feishu:chat123:user456')).toEqual(['feishu', 'chat123'])
    expect(parseSessionKeyParts('telegram:987654321')).toEqual(['telegram', '987654321'])
    expect(parseSessionKeyParts('relay:source:chat-1')).toEqual(['relay', 'chat-1'])
    expect(() => parseSessionKeyParts('simplekey')).toThrow()
    expect(() => parseSessionKeyParts('')).toThrow()
  })
})
