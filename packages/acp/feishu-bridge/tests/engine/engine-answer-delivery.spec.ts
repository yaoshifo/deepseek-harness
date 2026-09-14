/**
 * Answer-delivery outcome tracking (dsh-im absorption batch 1, u2+u3): the
 * turn-end plain-text answer sends classify their failures into the
 * three-state DeliveryOutcome on the turn state, and the finished turn no
 * longer reads as plain success when its answer did not provably land —
 * 'unknown' warns against immediate resubmission, 'failed' states the
 * answer was not delivered.
 *
 * @module dsh-feishu-bridge/tests-engine-answer-delivery
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession, newResultAgentSession, newStubMessage } from '../stubs/engine-stubs.ts'
import { classifyDeliveryFailure } from '../../src/feishu/delivery-outcome.ts'
import type { Agent, Message, Platform } from '../../src/core/types.ts'

/** Controllable agent whose session answers with one result event. */
function resultAgent(text: string): Agent {
  const base = createStubAgent()
  return {
    ...base,
    startSession: async () => newResultAgentSession(text),
  } as Agent
}

function msg(content: string): Message {
  return {
    ...newStubMessage(),
    sessionKey: 'testchat',
    platform: 'test',
    messageID: 'om_test',
    content,
    originalContent: content,
    machine: false,
  }
}

/**
 * Platform whose first send throws the given error (the answer delivery),
 * later sends succeed (the warning that follows), and which classifies
 * failures through the real feishu judgment — mirroring FeishuPlatform's
 * DeliveryOutcomeClassifier wiring.
 */
function flakyPlatform(error: unknown): Platform & { sent: string[] } {
  const p = createStubPlatform('test')
  let failedOnce = false
  p.send = async (_rc: unknown, content: string) => {
    if (!failedOnce) {
      failedOnce = true
      throw error
    }
    p.sent.push(content)
  }
  return Object.assign(p, {
    classifyDeliveryFailure: (err: unknown): 'failed' | 'unknown' => classifyDeliveryFailure(err),
  }) as Platform & { sent: string[] }
}

/**
 * Agent whose session streams one narration block, a thinking block (the
 * inter-segment plain-text flush point), a tool call, a final block, then an
 * empty-carrier result (the accumulated textParts are the answer).
 */
function segmentedAgent(): Agent {
  const base = createStubAgent()
  return {
    ...base,
    startSession: async () => {
      const s = newControllableSession('segment-session')
      let sentOnce = false
      s.send = async () => {
        if (sentOnce) return
        sentOnce = true
        s.channel.push({ type: 'text', content: 'precious first segment', done: false })
        s.channel.push({ type: 'thinking', content: 'pondering deeply', done: false })
        s.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
        s.channel.push({ type: 'text', content: 'final segment answer', done: false })
        s.channel.push({ type: 'result', content: '', done: true })
      }
      return s
    },
  } as Agent
}

/**
 * Platform whose first `failCount` sends throw the given error and are
 * classified through the real Feishu judgment; later sends succeed and are
 * recorded.
 */
function segmentFlakyPlatform(error: unknown, failCount: number): Platform & { sent: string[] } {
  const p = createStubPlatform('test')
  let failures = 0
  return Object.assign(p, {
    classifyDeliveryFailure: (err: unknown): 'failed' | 'unknown' => classifyDeliveryFailure(err),
    send: async (_rc: unknown, content: string) => {
      if (failures < failCount) {
        failures++
        throw error
      }
      p.sent.push(content)
    },
  }) as Platform & { sent: string[] }
}

/** Timeout symptom: the bridge's own synthesized per-attempt deadline. */
const deadlineError = new Error('context deadline exceeded')

/** AxiosError shape the SDK surfaces for a definite HTTP rejection. */
const forbiddenError = {
  message: 'Request failed with status code 403',
  response: { status: 403, data: {} },
}

/**
 * Preview-card platform whose terminal PATCH never lands: every
 * updateMessage throws, the fallback re-delivery send fails once with the
 * definite rejection, later sends (the warning) succeed and are recorded,
 * and the ✅ completion card rides sendCardWithHandle.
 */
function failingCardPlatform(error: unknown): Platform & { sent: string[]; cards: unknown[] } {
  const p = createStubPlatform('test')
  const cards: unknown[] = []
  let fallbackFailed = false
  return Object.assign(p, {
    cards,
    async sendPreviewStart(_rc: unknown): Promise<unknown> {
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown): Promise<void> {
      // A real PATCH crosses the network: the terminal outcome settles on a
      // macrotask, after the engine's synchronous post-delivery steps.
      await new Promise((resolve) => { setTimeout(resolve, 25) })
      throw new Error('terminal PATCH rejected')
    },
    async sendCardWithHandle(_rc: unknown, card: unknown): Promise<unknown> {
      cards.push(card)
      return 'card-handle'
    },
    classifyDeliveryFailure: (err: unknown): 'failed' | 'unknown' => classifyDeliveryFailure(err),
    send: async (_rc: unknown, content: string) => {
      if (!fallbackFailed) {
        fallbackFailed = true
        throw error
      }
      p.sent.push(content)
    },
  }) as Platform & { sent: string[]; cards: unknown[] }
}

/**
 * Drive one inbound message to a settled turn and return the engine.
 * @param p - Platform under test.
 * @param agent - Agent whose session emits one result event per send.
 */
async function runTurn(p: Platform, agent: Agent): Promise<Engine> {
  const e = new Engine('test', agent, [p], '', 'en')
  e.receiveMessage(p, msg('please answer'))
  await vi.waitFor(() => {
    expect(e.interactiveStates.get('testchat')?.answerDelivery).toBeDefined()
  }, { timeout: 5000 })
  return e
}

describe('answer delivery outcome', () => {
  it('a delivered plain-text answer records sent without a warning', async () => {
    const p = createStubPlatform('test') as Platform & { sent: string[] }
    const e = await runTurn(p, resultAgent('final answer text'))
    expect(e.interactiveStates.get('testchat')?.answerDelivery).toBe('sent')
    expect(p.sent.join('\n')).not.toContain('⚠️')
  })

  it('a timeout symptom records unknown and warns against resubmission', async () => {
    const p = flakyPlatform(deadlineError)
    const e = await runTurn(p, resultAgent('final answer text'))
    expect(e.interactiveStates.get('testchat')?.answerDelivery).toBe('unknown')
    const texts = p.sent.join('\n')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('not be confirmed')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('Do not resend')
  })

  it('a definite HTTP rejection records failed and states the answer was not delivered', async () => {
    const p = flakyPlatform(forbiddenError)
    const e = await runTurn(p, resultAgent('final answer text'))
    expect(e.interactiveStates.get('testchat')?.answerDelivery).toBe('failed')
    const texts = p.sent.join('\n')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('failed to deliver')
  })

  it('an undeliverable answer is saved next to the session and the warning carries the path', async () => {
    // The answer send fails (definite rejection); the later warning send
    // succeeds (flaky platform) — the answer must be persisted to the chat
    // workspace and the warning must point at the file.
    const workDir = await mkdtemp(joinPath(tmpdir(), 'fb-undelivered-'))
    try {
      const p = flakyPlatform(forbiddenError)
      const e = new Engine('test', resultAgent('the recoverable answer'), [p], '', 'en')
      e.setBaseWorkDir(workDir)
      e.receiveMessage(p, msg('please answer'))
      await vi.waitFor(() => {
        expect(e.interactiveStates.get('testchat')?.answerDelivery).toBe('failed')
      }, { timeout: 5000 })
      const texts = p.sent.join('\n')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('failed to deliver')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('undelivered-reply-')
      const saved = readdirSync(workDir).filter(f => f.startsWith('undelivered-reply-'))
      expect(saved, `dir=${workDir}`).toHaveLength(1)
      expect(readFileSync(joinPath(workDir, saved[0]!), 'utf8')).toContain('the recoverable answer')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('a card turn whose terminal PATCH and fallback re-delivery both fail warns, saves, and marks the ✅ card', async () => {
    // The streamed-card surfaces deliver through the async terminal PATCH;
    // its outcome (and the fallback's) is final only after the sender
    // barrier. The turn must still warn, persist the answer, and keep the ✅
    // push from reading as plain success.
    const workDir = await mkdtemp(joinPath(tmpdir(), 'fb-undelivered-card-'))
    try {
      const p = failingCardPlatform(forbiddenError)
      const e = new Engine('test', resultAgent('the recoverable card answer'), [p], '', 'en')
      e.setDisplayConfig({ toolProgress: true })
      e.setBaseWorkDir(workDir)
      e.receiveMessage(p, msg('please answer'))
      await vi.waitFor(() => {
        expect(p.cards.length, `sent=${JSON.stringify(p.sent)}`).toBeGreaterThan(0)
      }, { timeout: 5000 })
      expect(e.interactiveStates.get('testchat')?.answerDelivery,
        'the post-barrier card outcome reaches the turn state').toBe('failed')
      const texts = p.sent.join('\n')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('failed to deliver')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('undelivered-reply-')
      const saved = readdirSync(workDir).filter(f => f.startsWith('undelivered-reply-'))
      expect(saved, `dir=${workDir}`).toHaveLength(1)
      expect(readFileSync(joinPath(workDir, saved[0]!), 'utf8')).toContain('the recoverable card answer')
      expect(JSON.stringify(p.cards[0]), 'the ✅ card leads with the delivery warning')
        .toContain('failed to deliver')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  it('a mid-turn segment flush failure is re-delivered with the turn-end remainder', async () => {
    // Both thinking-block flush attempts for the first segment are definitely
    // rejected: the segment must stay unsent (segmentStart holds) so the
    // turn-end remainder branch re-delivers it, and the recovered delivery
    // clears the earlier failure — no warning, no silent loss.
    const p = segmentFlakyPlatform(forbiddenError, 2)
    const e = await runTurn(p, segmentedAgent())
    const texts = p.sent.join('\n')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('precious first segment')
    expect(e.interactiveStates.get('testchat')?.answerDelivery,
      'the turn-end re-delivery resolves the segment failure').toBe('sent')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).not.toContain('failed to deliver')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).not.toContain('not be confirmed')
  })

  it('an uncertain mid-turn segment flush keeps the unknown verdict and never re-sends', async () => {
    const workDir = await mkdtemp(joinPath(tmpdir(), 'fb-segment-unknown-'))
    try {
      const p = segmentFlakyPlatform(deadlineError, 1)
      const e = new Engine('test', segmentedAgent(), [p], '', 'en')
      e.setBaseWorkDir(workDir)
      e.receiveMessage(p, msg('please answer'))
      await vi.waitFor(() => {
        expect(e.interactiveStates.get('testchat')?.answerDelivery).toBe('unknown')
      }, { timeout: 5000 })
      // The uncertain segment may have landed — it must never be re-sent
      // (only the thinking notice and the remainder that provably succeeded).
      expect(p.sent.join('\n'), `sent=${JSON.stringify(p.sent)}`).not.toContain('precious first segment')
      const texts = p.sent.join('\n')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('not be confirmed')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('Do not resend')
      expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('undelivered-reply-')
      const saved = readdirSync(workDir).filter(f => f.startsWith('undelivered-reply-'))
      expect(saved, `dir=${workDir}`).toHaveLength(1)
      expect(readFileSync(joinPath(workDir, saved[0]!), 'utf8')).toContain('precious first segment')
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
