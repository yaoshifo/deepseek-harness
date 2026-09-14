/**
 * Agent-message observation wiring (2026-09-13 chatroom postmortem): a
 * child's runtime send_message lands on the parent native session as a
 * user/message event with source kind 'agent-message' and never passes the
 * engine pipeline, so the subtask-report dedup seam (noteAgentDirectMessage)
 * had no producer. The adapter now observes the relay at the session/event
 * projection point and forwards (parent bridge key, sender native id, text)
 * to a notifier the engine registers at construction.
 *
 * @module dsh-feishu-bridge/tests-adapter-agent-message
 */

import { describe, expect, it, vi } from 'vitest'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentLike, type DshContextLike, type DshCreateOptionsLike } from '../../src/agent-dsh/adapter.ts'

interface Harness {
  ctx: DshContextLike
  emit: (sessionId: string, event: Record<string, unknown>) => void
  createdIds: string[]
}

function createHarness(): Harness {
  const listeners = new Map<string, Array<(session: { id: unknown }, event: Record<string, unknown>) => void>>()
  const createdIds: string[] = []
  const emit = (sessionId: string, event: Record<string, unknown>): void => {
    const { type, ...data } = event
    for (const l of listeners.get('session/event') ?? []) {
      l({ id: sessionId }, { type, seq: 0, time: 0, data })
    }
  }
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        const sid = options.sessionId
        const id = typeof sid === 'string' ? sid : `agent-${createdIds.length + 1}`
        createdIds.push(id)
        const agent: DshAgentLike = {
          id,
          status: 'idle',
          session: { snapshotEvents: () => [] },
          followup: () => {},
          steer: () => {},
          cancel: () => {},
        }
        const handle: DshAgentHandleLike = { agent, dispose: async () => {} }
        return handle
      },
      resume: async () => {
        const agent: DshAgentLike = {
          id: 'resumed',
          status: 'idle',
          session: { snapshotEvents: () => [] },
          followup: () => {},
          steer: () => {},
          cancel: () => {},
        }
        return { agent, dispose: async () => {} }
      },
      get: () => undefined,
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener as (session: { id: unknown }, event: Record<string, unknown>) => void)
      listeners.set(event, list)
      return () => {}
    },
    get: () => undefined,
  }
  return { ctx, emit, createdIds }
}

function newAdapter(h: Harness): DshAgentAdapter {
  return new DshAgentAdapter(h.ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
    activeProvider: 'glm',
  })
}

describe('agent-message observation at the session/event projection', () => {
  it('forwards a relayed agent-message on a live session to the registered notifier', async () => {
    const h = createHarness()
    const adapter = newAdapter(h)
    // Empty sessionID = fresh create; sessionKey binds the bridge key.
    await adapter.startSession('', { sessionKey: 'vault:oc_hub' })
    const notifier = vi.fn()
    adapter.registerAgentDirectMessageNotifier(notifier)

    h.emit(h.createdIds[0] ?? '', {
      type: 'user/message',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'cc-child-native' },
      content: [{ type: 'text', text: '汇报：渲染完成，产物已投递。' }],
    })

    expect(notifier).toHaveBeenCalledWith('vault:oc_hub', 'cc-child-native', '汇报：渲染完成，产物已投递。')
  })

  it('a plain human message does not reach the notifier', async () => {
    const h = createHarness()
    const adapter = newAdapter(h)
    await adapter.startSession('', { sessionKey: 'vault:oc_hub' })
    const notifier = vi.fn()
    adapter.registerAgentDirectMessageNotifier(notifier)

    h.emit(h.createdIds[0] ?? '', {
      type: 'user/message',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '人工消息' }],
    })

    expect(notifier).not.toHaveBeenCalled()
  })

  it('an agent-message on a session the adapter does not own is ignored', async () => {
    const h = createHarness()
    const adapter = newAdapter(h)
    await adapter.startSession('vault:oc_hub')
    const notifier = vi.fn()
    adapter.registerAgentDirectMessageNotifier(notifier)

    h.emit('cc-not-live', {
      type: 'user/message',
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'cc-child-native' },
      content: [{ type: 'text', text: '孤儿事件' }],
    })

    expect(notifier).not.toHaveBeenCalled()
  })

  it('events flow without a registered notifier', async () => {
    const h = createHarness()
    const adapter = newAdapter(h)
    await adapter.startSession('', { sessionKey: 'vault:oc_hub' })

    expect(() => {
      h.emit(h.createdIds[0] ?? '', {
        type: 'user/message',
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'cc-child-native' },
        content: [{ type: 'text', text: '无观察者' }],
      })
    }).not.toThrow()
  })
})
