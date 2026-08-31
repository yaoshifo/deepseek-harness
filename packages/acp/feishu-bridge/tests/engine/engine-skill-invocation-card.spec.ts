/**
 * Slash-gesture skill loads must surface on the tool-process card: the
 * adapter projects the injected skill-invocation message as a
 * `skill_invocation` channel event, and the interactive loop renders it
 * with the same 📚 presentation the model-invoked `skill` tool call gets
 * (entry tag plus the per-turn 「📚 技能：」 summary line).
 *
 * @module dsh-feishu-bridge/tests-engine-skill-invocation-card
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Platform, ProgressContent } from '../../src/core/types.ts'
import { previewText } from '../stubs/preview-content.ts'

interface PreviewPlatform extends Platform {
  bodies: string[]
}

/** Legacy-style preview-capable platform recording every card body in order. */
function createPreviewPlatform(): PreviewPlatform {
  const bodies: string[] = []
  return Object.assign(createStubPlatform('feishu'), {
    bodies,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      bodies.push(previewText(content))
      return 'preview-1'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      bodies.push(previewText(content))
    },
  }) as PreviewPlatform
}

/** Run one interactive turn over the given channel events and return the recorded card bodies. */
async function runTurn(events: Array<Record<string, unknown>>): Promise<string[]> {
  const p = createPreviewPlatform()
  const e = new Engine('test', createStubAgent(), [p], '', 'zh')
  e.setDisplayConfig({ toolProgress: true })
  const key = 'test:user1'
  const session = e.sessions.getOrCreateActive(key)
  const sess = newControllableSession('skill-card-1')
  const state = new InteractiveState()
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)

  for (const ev of events) sess.channel.push(ev as never)
  await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')
  return p.bodies
}

describe('skill_invocation card rendering', () => {
  it('renders the slash-loaded skill as a 📚 entry with the summary line', async () => {
    const bodies = await runTurn([
      { type: 'skill_invocation', content: 'explain', done: false },
      { type: 'result', content: '图已生成', done: true },
    ])
    const card = bodies.join('\n---\n')
    expect(card, `bodies=${JSON.stringify(bodies)}`).toContain('📚 explain')
    expect(card).toContain('📚 技能：explain')
    expect(card).toContain('已加载技能指令')
  })

  it('leaves the card without skill rows when no skill was loaded', async () => {
    const bodies = await runTurn([
      { type: 'result', content: '直接回答', done: true },
    ])
    const card = bodies.join('\n---\n')
    expect(card).not.toContain('📚')
  })
})
