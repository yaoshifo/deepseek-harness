/**
 * Reply-HTML render status PATCHes must not precede the turn's terminal card
 * PATCH: the first 渲染中 status rebuilds the card from the preview cache, and
 * a pre-terminal cache repaints a settled card with its old running state
 * (green → 思考中 → green, 2026-09-15 oc_1b7e).
 *
 * @module dsh-feishu-bridge/tests-engine-reply-render-order
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { newControllableSession } from '../stubs/engine-stubs.ts'
import { statusOf } from '../stubs/preview-content.ts'
import { createCardMediaPlatform, createRenderAgent, newRenderEngine, pollUntil } from './plan-render-helpers.ts'
import type { ProgressContent } from '../../src/core/types.ts'

/** One card-affecting platform call, recorded at dispatch entry. */
interface CardCall {
  kind: 'updateMessage' | 'renderStatus'
  state: string | undefined
}

/** Card+media platform whose preview and render-status calls record into one sequence. */
type OrderPlatform = ReturnType<typeof createCardMediaPlatform> & { calls: CardCall[] }

function createOrderPlatform(): OrderPlatform {
  const base = createCardMediaPlatform()
  const calls: CardCall[] = []
  return Object.assign(base, {
    calls,
    async sendPreviewStart(_rc: unknown, _content: ProgressContent): Promise<unknown> {
      return { exportKey: () => 'om_render_1' }
    },
    async updateMessage(_handle: unknown, content: ProgressContent): Promise<void> {
      calls.push({ kind: 'updateMessage', state: statusOf(content)?.state })
    },
    async updateRenderStatus(_rc: unknown, _exportKey: string, _statusText: string): Promise<void> {
      calls.push({ kind: 'renderStatus', state: undefined })
    },
  })
}

const longReply = `本机测试分三层。${'单元测试零环境依赖，随时可跑；'.repeat(60)}`

/** Drive one turn: a thinking flush lands, then the terminal result arrives. */
async function runRenderTurn(e: Engine, p: OrderPlatform, result: Record<string, unknown>): Promise<void> {
  const sess = newControllableSession('render-order-1')
  const key = 'test:render-order'
  const session = e.sessions.getOrCreateActive(key)
  const state = new InteractiveState()
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx-1'
  e.interactiveStates.set(key, state)
  const loop = e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx-1')
  sess.channel.push({ type: 'thinking_delta', content: 'weighing how to answer', done: false } as never)
  // Past progressFlushInterval so the 思考中 header PATCH lands first — the
  // card the render-status PATCH would wrongly rebuild is a thinking card.
  setTimeout(() => { sess.channel.push(result as never) }, 400)
  await loop
}

describe('reply-HTML render ordering vs the terminal card PATCH', () => {
  it('the first render-status PATCH lands after the completed terminal PATCH', async () => {
    const p = createOrderPlatform()
    const e = newRenderEngine(createRenderAgent({}), p)
    e.setDisplayConfig({ toolProgress: true })
    await runRenderTurn(e, p, { type: 'result', content: longReply, done: true })

    await pollUntil(() => p.calls.some(c => c.kind === 'renderStatus'), 3000)
    const completedIdx = p.calls.findIndex(c => c.kind === 'updateMessage' && c.state === 'completed')
    const firstRenderIdx = p.calls.findIndex(c => c.kind === 'renderStatus')
    expect(completedIdx, `calls=${JSON.stringify(p.calls)}`).toBeGreaterThanOrEqual(0)
    expect(firstRenderIdx, `calls=${JSON.stringify(p.calls)}`).toBeGreaterThanOrEqual(0)
    expect(firstRenderIdx, `calls=${JSON.stringify(p.calls)}`).toBeGreaterThan(completedIdx)
  })

  it('the first render-status PATCH lands after the failed terminal PATCH', async () => {
    const p = createOrderPlatform()
    const e = newRenderEngine(createRenderAgent({}), p)
    e.setDisplayConfig({ toolProgress: true })
    // Errored turns render their failure text (engine replaces the reply with
    // the error message), so the error itself must clear the render threshold.
    const longError = `provider unreachable: ${'upstream connection reset mid-stream; '.repeat(40)}`
    await runRenderTurn(e, p, { type: 'result', content: '', errorText: longError, done: true })

    await pollUntil(() => p.calls.some(c => c.kind === 'renderStatus'), 3000)
    const failedIdx = p.calls.findIndex(c => c.kind === 'updateMessage' && c.state === 'failed')
    const firstRenderIdx = p.calls.findIndex(c => c.kind === 'renderStatus')
    expect(failedIdx, `calls=${JSON.stringify(p.calls)}`).toBeGreaterThanOrEqual(0)
    expect(firstRenderIdx, `calls=${JSON.stringify(p.calls)}`).toBeGreaterThanOrEqual(0)
    expect(firstRenderIdx, `calls=${JSON.stringify(p.calls)}`).toBeGreaterThan(failedIdx)
  })
})
