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

import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newResultAgentSession } from '../stubs/engine-stubs.ts'
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
    sessionKey: 'testchat',
    platform: 'test',
    messageID: 'om_test',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content,
    originalContent: content,
    images: [],
    files: [],
    machine: false,
  } as Message
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

/** Timeout symptom: the bridge's own synthesized per-attempt deadline. */
const deadlineError = new Error('context deadline exceeded')

/** AxiosError shape the SDK surfaces for a definite HTTP rejection. */
const forbiddenError = {
  message: 'Request failed with status code 403',
  response: { status: 403, data: {} },
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
})
