/**
 * Kill-path partial-answer delivery (dsh-im absorption batch 1, u4): the
 * two forceful exits — stall exhaustion and the hard turn cap — used to
 * return without delivering the turn's completed streamed text; the
 * channel-closed path already delivered it. Drives the event pump with a
 * controllable session that streams one text block then goes silent, and
 * asserts both kills deliver the completed textParts alongside their
 * notice.
 *
 * @module dsh-feishu-bridge/tests-engine-kill-delivery
 */

import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import { classifyDeliveryFailure } from '../../src/feishu/delivery-outcome.ts'
import type { Platform, ProgressContent } from '../../src/core/types.ts'

/** Platform whose sends succeed (records texts). */
function okPlatform(): Platform & { sent: string[] } {
  return createStubPlatform('test')
}

/** AxiosError shape the SDK surfaces for a definite HTTP rejection. */
const forbiddenError = {
  message: 'Request failed with status code 403',
  response: { status: 403, data: {} },
}

/**
 * Platform that definitely rejects the partial-answer send and classifies
 * through the real Feishu judgment, while every other send (notices, the
 * warning) succeeds and is recorded.
 */
function answerRejectingPlatform(error: unknown): Platform & { sent: string[] } {
  const p = createStubPlatform('test')
  return Object.assign(p, {
    classifyDeliveryFailure: (err: unknown): 'failed' | 'unknown' => classifyDeliveryFailure(err),
    send: async (_rc: unknown, content: string) => {
      if (content.includes('precious partial answer')) throw error
      p.sent.push(content)
    },
  })
}

/**
 * Preview-capable platform: records plain sends and every PATCH body, so a
 * test can tell what reached the chat as text versus what rides the card.
 */
function previewRecordingPlatform(): Platform & { sent: string[]; patches: string[] } {
  const p = createStubPlatform('test')
  const patches: string[] = []
  return Object.assign(p, {
    patches,
    async sendPreviewStart(_rc: unknown): Promise<unknown> {
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      patches.push(JSON.stringify(content))
    },
  })
}

/**
 * Preview-card platform whose terminal PATCH always rejects on a real
 * macrotask delay (so the settled outcome only exists after the sender
 * barrier drains it): the stall kill's markFailed fallback re-delivery is
 * the make-or-break surface. `failAnswerOnce` fails exactly the first
 * answer-content send (the fallback's attempt); otherwise every
 * answer-content send fails.
 */
function failingTerminalCardPlatform(error: unknown, failAnswerOnce: boolean): Platform & { sent: string[]; patches: string[] } {
  const p = createStubPlatform('test')
  const patches: string[] = []
  let answerFailed = false
  return Object.assign(p, {
    patches,
    async sendPreviewStart(_rc: unknown): Promise<unknown> {
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      await new Promise((resolve) => { setTimeout(resolve, 25) })
      patches.push(JSON.stringify(content))
      throw new Error('terminal PATCH rejected')
    },
    classifyDeliveryFailure: (err: unknown): 'failed' | 'unknown' => classifyDeliveryFailure(err),
    send: async (_rc: unknown, content: string) => {
      if (content.includes('precious partial answer') && (!failAnswerOnce || !answerFailed)) {
        answerFailed = true
        throw error
      }
      p.sent.push(content)
    },
  })
}

/**
 * Run one turn whose session streams a text block, then goes silent until
 * the engine's idle watchdog kills it (no stall retries).
 * @param p - Platform recording sends.
 * @param opts - idle window.
 */
async function runKilledTurn(
  p: Platform,
  opts: { idleMs: number; card?: boolean; workDir?: string },
): Promise<{ e: Engine; state: InteractiveState }> {
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.setDisplayConfig({ toolProgress: opts.card === true })
  e.setEventIdleTimeout(opts.idleMs)
  if (opts.workDir !== undefined) e.setBaseWorkDir(opts.workDir)
  e.setStallMaxRetries(-1)
  const key = 'test:user1'
  const session = e.sessions.getOrCreateActive(key)
  const state = new InteractiveState()
  const sess = newControllableSession('kill-session')
  // The prompt send resolves (success); the session streams one completed
  // text block, then the channel stays open and silent.
  sess.send = async () => {
    sess.channel.push({ type: 'text', content: 'precious partial answer', done: false })
  }
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  const sendDone = sess.send('task', [], [])
  await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', sendDone, 'ctx')
  return { e, state }
}

/**
 * Run one turn whose session streams a text block, then keeps the pump fed
 * with thinking deltas under the idle window until the hard turn cap
 * (idle×2×3) fires on a delta event.
 * @param p - Platform recording sends.
 * @param opts - idle window.
 */
async function runHardCappedTurn(
  p: Platform,
  opts: { idleMs: number; workDir?: string },
): Promise<{ e: Engine; state: InteractiveState }> {
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.setDisplayConfig({ toolProgress: false })
  e.setEventIdleTimeout(opts.idleMs)
  if (opts.workDir !== undefined) e.setBaseWorkDir(opts.workDir)
  const key = 'test:user1'
  const session = e.sessions.getOrCreateActive(key)
  const state = new InteractiveState()
  const sess = newControllableSession('kill-session')
  sess.send = async () => {
    sess.channel.push({ type: 'text', content: 'precious partial answer', done: false })
    // Keep events flowing well past the hard cap (idle×2×3) without ever
    // completing the turn: each delta resets the stall clock, and the cap
    // check runs on every event arrival.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, Math.max(20, opts.idleMs / 4)))
      sess.channel.push({ type: 'thinking_delta', content: `tick ${i} `, done: false })
    }
  }
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  const sendDone = sess.send('task', [], [])
  await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', sendDone, 'ctx')
  return { e, state }
}

describe('kill-path partial-answer delivery', () => {
  it('stall exhaustion delivers the completed streamed text before the kill', { timeout: 10_000 }, async () => {
    const p = okPlatform()
    const { state } = await runKilledTurn(p, { idleMs: 80 })
    expect(state.textParts, 'the streamed block completed into textParts').toHaveLength(1)
    const texts = p.sent.join('\n')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('precious partial answer')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('stopped responding')
  })

  it('hard turn cap delivers the completed streamed text before the kill', { timeout: 10_000 }, async () => {
    const p = okPlatform()
    const { state } = await runHardCappedTurn(p, { idleMs: 80 })
    const texts = p.sent.join('\n')
    expect(state.textParts, 'the streamed block completed into textParts').toHaveLength(1)
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('precious partial answer')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('exceeded the maximum turn duration')
  })

  it('a stall kill whose partial delivery fails warns and saves the answer copy', { timeout: 10_000 }, async () => {
    const workDir = await mkdtemp(joinPath(tmpdir(), 'fb-kill-undelivered-'))
    try {
      const p = answerRejectingPlatform(forbiddenError)
      const { state } = await runKilledTurn(p, { idleMs: 80, workDir })
      expect(state.answerDelivery, 'the kill path settles the delivery outcome').toBe('failed')
      const texts = p.sent.join('\n')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('stopped responding')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('failed to deliver')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('undelivered-reply-')
      const saved = readdirSync(workDir).filter(f => f.startsWith('undelivered-reply-'))
      expect(saved, `dir=${workDir}`).toHaveLength(1)
      expect(readFileSync(joinPath(workDir, saved[0]!), 'utf8')).toContain('precious partial answer')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('a hard-cap kill whose partial delivery fails warns and saves the answer copy', { timeout: 10_000 }, async () => {
    const workDir = await mkdtemp(joinPath(tmpdir(), 'fb-kill-undelivered-cap-'))
    try {
      const p = answerRejectingPlatform(forbiddenError)
      const { state } = await runHardCappedTurn(p, { idleMs: 80, workDir })
      expect(state.answerDelivery, 'the kill path settles the delivery outcome').toBe('failed')
      const texts = p.sent.join('\n')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('exceeded the maximum turn duration')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('failed to deliver')
      const saved = readdirSync(workDir).filter(f => f.startsWith('undelivered-reply-'))
      expect(saved, `dir=${workDir}`).toHaveLength(1)
      expect(readFileSync(joinPath(workDir, saved[0]!), 'utf8')).toContain('precious partial answer')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('an in-progress preview card keeps the streamed segment off the plain-text re-delivery', { timeout: 10_000 }, async () => {
    const p = previewRecordingPlatform()
    const { state } = await runKilledTurn(p, { idleMs: 80, card: true })
    // The failed card carries the streamed text (its 实时播报 section).
    await vi.waitFor(() => {
      expect(p.patches.some(body => body.includes('precious partial answer')),
        `patches=${JSON.stringify(p.patches)}`).toBe(true)
    }, { timeout: 5000 })
    // The same text must not also arrive as a plain message.
    expect(p.sent.join('\n'), `sent=${JSON.stringify(p.sent)}`).not.toContain('precious partial answer')
    expect(state.answerDelivery, 'nothing owed on the plain path leaves no outcome').toBeUndefined()
  })

  it('a killed card whose terminal and fallback re-delivery both fail settles the segment as plain text', { timeout: 10_000 }, async () => {
    // The terminal PATCH rejects and markFailed's internal fallback
    // re-delivery is also definitely rejected: with the streamed segment
    // neither on the card nor re-delivered, the kill path must retry it as
    // plain text (duplication-safe — a definite rejection never landed)
    // instead of dropping it silently.
    const p = failingTerminalCardPlatform(forbiddenError, true)
    const { state } = await runKilledTurn(p, { idleMs: 80, card: true })
    const texts = p.sent.join('\n')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('precious partial answer')
    expect(state.answerDelivery, 'the retry settles the outcome').toBe('sent')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).not.toContain('failed to deliver')
  })

  it('a killed card whose every delivery surface fails warns and saves the answer copy', { timeout: 10_000 }, async () => {
    const workDir = await mkdtemp(joinPath(tmpdir(), 'fb-kill-card-undelivered-'))
    try {
      const p = failingTerminalCardPlatform(forbiddenError, false)
      const { state } = await runKilledTurn(p, { idleMs: 80, card: true, workDir })
      expect(state.answerDelivery, 'the kill path settles the card outcome').toBe('failed')
      const texts = p.sent.join('\n')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('failed to deliver')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('undelivered-reply-')
      const saved = readdirSync(workDir).filter(f => f.startsWith('undelivered-reply-'))
      expect(saved, `dir=${workDir}`).toHaveLength(1)
      expect(readFileSync(joinPath(workDir, saved[0]!), 'utf8')).toContain('precious partial answer')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
