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
import { Engine, InteractiveState, type DisplayCfg } from '../../src/engine/engine.ts'
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
  })
}

/**
 * Run one interactive turn over the given channel events and return the recorded card bodies.
 *
 * @param events - Channel events pushed before the turn runs.
 * @param display - Extra display flags; the deployed projects run quiet
 *   (`toolMessages: false`), where tool results ride the card. With the
 *   engine's default `toolMessages: true` they leave the card as standalone
 *   messages instead.
 */
async function runTurn(events: Array<Record<string, unknown>>, display: Partial<DisplayCfg> = {}): Promise<string[]> {
  const p = createPreviewPlatform()
  const e = new Engine('test', createStubAgent(), [p], '', 'zh')
  e.setDisplayConfig({ toolProgress: true, ...display })
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

  it('fills the slash entry input line with the skill name, keeping the five-line block', async () => {
    const bodies = await runTurn([
      { type: 'skill_invocation', content: 'explain', done: false },
      { type: 'result', content: '图已生成', done: true },
    ])
    const lines = bodies.join('\n').split('\n')
    // 该手势没有工具调用输入，输入行用技能名填；块恒 5 行
    // （输入行 / --- / 结果 3 行）是卡片高度不跳的条件。
    const divider = lines.findIndex(line => line.trim() === '---')
    expect(divider, `card=${bodies.join('\n')}`).toBeGreaterThan(0)
    expect(lines[divider - 1]?.trim()).toBe('explain')
    expect(lines[divider + 1]?.trim()).toBe('已加载技能指令')
    expect(lines[divider + 4]).toBe('```')
  })

  it('leaves the card without skill rows when no skill was loaded', async () => {
    const bodies = await runTurn([
      { type: 'result', content: '直接回答', done: true },
    ])
    const card = bodies.join('\n---\n')
    expect(card).not.toContain('📚')
  })
})

describe('skill tool card rendering', () => {
  it('shows the loaded notice instead of the model-facing envelope', async () => {
    const envelope = [
      '<skill_content name="tdd">',
      '<skill_resources>',
      'Resources for this skill are managed by provider "feishu-bridge-skills".',
      'Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      '# TDD',
      'Write the failing test first.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n')
    const bodies = await runTurn([
      { type: 'tool_use', toolName: 'skill', toolInput: '{"name":"tdd"}', toolID: 't1', content: '', done: false },
      { type: 'tool_result', toolResult: envelope, toolID: 't1', content: '', done: false },
      { type: 'result', content: '做完了', done: true },
    ], { toolMessages: false })
    const card = bodies.join('\n')
    expect(card, `card=${card}`).toContain("<text_tag color='green'>📚 tdd</text_tag>")
    expect(card).toContain('已加载技能指令')
    // 模型面的信封从不进卡面；输入行是技能名而不是空白。
    expect(card).not.toContain('<skill_content')
    expect(card).not.toContain('<skill_resources>')
    const lines = card.split('\n')
    const divider = lines.findIndex(line => line.trim() === '---')
    expect(lines[divider - 1]?.trim()).toBe('tdd')
  })

  it('keeps the failure diagnostic for a failed skill load', async () => {
    const bodies = await runTurn([
      { type: 'tool_use', toolName: 'skill', toolInput: '{"name":"nope"}', toolID: 't1', content: '', done: false },
      {
        type: 'tool_result',
        toolResult: 'Error: skill "nope" is unknown or no longer available',
        toolID: 't1',
        toolSuccess: false,
        content: '',
        done: false,
      },
      { type: 'result', content: '没找到', done: true },
    ], { toolMessages: false })
    const card = bodies.join('\n')
    expect(card).toContain('skill "nope" is unknown or no longer available')
    expect(card).not.toContain('已加载技能指令')
  })
})
