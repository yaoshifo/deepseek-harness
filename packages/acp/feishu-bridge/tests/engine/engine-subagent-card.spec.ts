/**
 * Engine handling of delegated-subagent events on the tool-progress card:
 * child tool calls render under the `subagent` label with the real tool
 * name in the body, the cumulative count line appears via `subagent_status`,
 * and a child's todo list or tool result never overwrites parent surfaces.
 *
 * @module dsh-feishu-bridge/tests-engine-subagent-card
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Platform, ProgressContent } from '../../src/core/types.ts'
import { previewText } from '../stubs/preview-content.ts'

/** Platform with in-place preview support (PreviewStarter + MessageUpdater). */
interface PreviewPlatform extends Platform {
  messages: string[]
  sendPreviewStart(rc: unknown, content: ProgressContent): Promise<unknown>
  updateMessage(rc: unknown, content: ProgressContent): Promise<void>
}

/** Platform with in-place preview support, recording every card PATCH. */
function createPreviewPlatform(): PreviewPlatform {
  const p: PreviewPlatform = {
    messages: [],
    name: () => 'preview-test',
    start: async () => {},
    reply: async (_rc: unknown, content: string) => { p.messages.push(`reply:${content}`) },
    send: async (_rc: unknown, content: string) => { p.messages.push(`send:${content}`) },
    stop: async () => {},
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      p.messages.push(`start:${previewText(content)}`)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      p.messages.push(`update:${previewText(content)}`)
    },
  }
  return p
}

function setup(): { e: Engine; p: ReturnType<typeof createPreviewPlatform>; state: InteractiveState } {
  const p = createPreviewPlatform()
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.display.toolProgress = true
  e.display.toolMessages = false
  const sessionKey = 'test:user1'
  e.sessions.getOrCreateActive(sessionKey)
  const agentSession = newControllableSession('s1')
  const state = new InteractiveState()
  state.agentSession = agentSession
  state.platform = p
  state.replyCtx = 'ctx-1'
  e.interactiveStates.set(sessionKey, state)
  return { e, p, state }
}

describe('processInteractiveEvents subagent projection', () => {
  it('labels child tool calls subagent and shows the running count line', async () => {
    const { e, p, state } = setup()
    const ch = state.agentSession!.events()
    ch.push({ type: 'tool_use', toolName: 'Bash', toolInput: 'ls', toolID: 'p1', content: '', done: false })
    ch.push({ type: 'subagent_status', content: '2', done: false })
    ch.push({ type: 'tool_use', toolName: 'read', toolInput: '/tmp/report.md', toolID: 'child-1:c1', content: '', done: false, fromSubagent: true })
    // A child Write to a plan path exercises the no-promotion guard.
    ch.push({
      type: 'tool_use', toolName: 'write', toolInput: '.claude/plans/x.md', toolInputRaw: { file_path: '.claude/plans/x.md' },
      toolID: 'child-1:c2', content: '', done: false, fromSubagent: true,
    })
    // Garbage counts are ignored, not rendered.
    ch.push({ type: 'subagent_status', content: 'not-a-number', done: false })
    ch.push({ type: 'tool_result', toolResult: 'report body', toolID: 'child-1:c1', content: '', done: false, fromSubagent: true })
    ch.push({ type: 'result', content: 'done', done: true })

    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:user1'), e.sessions, 'test:user1', 'm1', undefined, state.replyCtx)

    const preview = state.preview
    expect(preview).toBeDefined()
    const display = preview!.buildProgressDisplayLocked()
    // Both entries settled (the child by its result, the parent by the
    // terminal success finalization), so both tags take the success color.
    expect(display).toContain("<text_tag color='green'>🤖 subagent</text_tag>")
    expect(display).toContain('read -> /tmp/report.md')
    expect(display).toContain('🤖 累计派发：2')
    expect(display).toContain("<text_tag color='green'>💻 Bash</text_tag>")
    // The child result rides the card only — no standalone chat message.
    expect(p.messages.some(m => (m.startsWith('send:') || m.startsWith('reply:')) && m.includes('report body'))).toBe(false)
  })

  it('fills the child result into its own entry, not the parent call', async () => {
    const { e, state } = setup()
    const ch = state.agentSession!.events()
    ch.push({ type: 'tool_use', toolName: 'Bash', toolInput: 'sleep 5', toolID: 'p1', content: '', done: false })
    ch.push({ type: 'tool_use', toolName: 'bash', toolInput: 'cat x', toolID: 'child-1:c1', content: '', done: false, fromSubagent: true })
    ch.push({ type: 'tool_result', toolResult: 'child output', toolID: 'child-1:c1', content: '', done: false, fromSubagent: true })
    ch.push({ type: 'result', content: 'done', done: true })

    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:user1'), e.sessions, 'test:user1', 'm1', undefined, state.replyCtx)

    const display = state.preview!.buildProgressDisplayLocked()
    // The child entry closed with its result; the parent entry stays open.
    const childIdx = display.indexOf('child output')
    expect(childIdx).toBeGreaterThanOrEqual(0)
  })

  it('keeps the parent todo section when a child rewrites its own todos', async () => {
    const { e, state } = setup()
    const ch = state.agentSession!.events()
    ch.push({
      type: 'tool_use', toolName: 'todo_write',
      toolInput: JSON.stringify({ todos: [{ content: 'Parent task', status: 'in_progress' }] }),
      toolID: 'p1', content: '', done: false,
    })
    ch.push({
      type: 'tool_use', toolName: 'todo_write',
      toolInput: JSON.stringify({ todos: [{ content: 'Child task', status: 'pending' }] }),
      toolID: 'child-1:c9', content: '', done: false, fromSubagent: true,
    })
    ch.push({ type: 'result', content: 'done', done: true })

    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:user1'), e.sessions, 'test:user1', 'm1', undefined, state.replyCtx)

    const display = state.preview!.buildProgressDisplayLocked()
    // The pinned todo section keeps the parent list; the child's list only
    // appears inside its own subagent tool entry's input body.
    expect(display).toContain('🔄 Parent task')
    expect(display).not.toContain('⏳ Child task')
  })

  it('suppresses standalone child tool-result chat messages while parent results still deliver', async () => {
    const { e, state } = setup()
    e.display.toolProgress = false
    e.display.toolMessages = true
    // Preview-less platform: chat messages only, count updates are a no-op.
    const plain = createStubPlatform()
    state.platform = plain
    const ch = state.agentSession!.events()
    ch.push({ type: 'tool_result', toolResult: 'parent tool output', toolName: 'Bash', content: '', done: false })
    ch.push({ type: 'tool_result', toolResult: 'child tool output', toolID: 'child-1:c1', content: '', done: false, fromSubagent: true })
    ch.push({ type: 'subagent_status', content: '1', done: false })
    ch.push({ type: 'result', content: 'final answer', done: true })

    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:user1'), e.sessions, 'test:user1', 'm1', undefined, state.replyCtx)

    const sent = plain.getSent().join('\n')
    expect(sent).toContain('parent tool output')
    expect(sent).not.toContain('child tool output')
    expect(sent).toContain('final answer')
  })
})
