/**
 * Native session-event → bridge Event projection tests: the signals the
 * migration's lossy projection dropped (tool/result failure, todo/write
 * snapshots, compaction lifecycle, per-request usage, tool-result meta)
 * must survive the projection.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-projection
 */
import { describe, expect, it } from 'vitest'
import { DshAgentSession } from '../../src/agent-dsh/adapter.js'
import type { Event } from '../../src/core/types.js'

function newSession(): DshAgentSession {
  return new DshAgentSession('test:u1', { agent: { id: 'a1' } } as never)
}

/** Project one wrapped session event and drain buffered bridge events (bounded: the channel stays open). */
async function project(session: DshAgentSession, wrapped: Record<string, unknown>): Promise<Event[]> {
  session.projectSessionEvent(wrapped)
  const out: Event[] = []
  for (;;) {
    const r = await Promise.race([
      session.events().receive(),
      new Promise<'empty'>((resolve) => { setTimeout(() => { resolve('empty') }, 10) }),
    ])
    if (r === 'empty' || r.done) break
    out.push(r.event)
  }
  return out
}

describe('projectSessionEvent tool/result failure identity', () => {
  it('projects error as toolSuccess=false', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'tool/result', seq: 1, time: 0,
      data: { message: { content: [{ type: 'text', text: 'boom' }] }, error: { name: 'ToolError', code: 'E_TOOL' } },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tool_result')
    expect(events[0]?.toolSuccess).toBe(false)
  })

  it('leaves toolSuccess absent for a successful result', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'tool/result', seq: 1, time: 0,
      data: { message: { content: [{ type: 'text', text: 'ok' }] } },
    })
    expect(events[0]?.toolSuccess).toBeUndefined()
  })
})

describe('projectSessionEvent toolInputRaw projection', () => {
  it('carries the parsed arguments record for typed-field consumers', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'tool/call', seq: 1, time: 0,
      data: { callId: 'c1', name: 'write', arguments: '{"file_path":"/x/.claude/plans/p.md","content":"# p"}' },
    })
    expect(events[0]?.toolInputRaw).toEqual({ file_path: '/x/.claude/plans/p.md', content: '# p' })
  })

  it('leaves the field absent for non-object and unparseable arguments', async () => {
    const s = newSession()
    const arr = await project(s, {
      type: 'tool/call', seq: 1, time: 0,
      data: { callId: 'c1', name: 'bash', arguments: '[1,2]' },
    })
    expect(arr[0]?.toolInputRaw).toBeUndefined()

    const bad = await project(s, {
      type: 'tool/call', seq: 2, time: 0,
      data: { callId: 'c2', name: 'bash', arguments: 'not-json' },
    })
    expect(bad[0]?.toolInputRaw).toBeUndefined()
  })
})

describe('projectSessionEvent run_in_background detection', () => {
  it('marks a tool call whose arguments set run_in_background', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'tool/call', seq: 1, time: 0,
      data: { callId: 'c1', name: 'bash', arguments: '{"command":"npm run build","run_in_background":true}' },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('tool_use')
    expect(events[0]?.toolBackground).toBe(true)
  })

  it('leaves the flag absent for foreground calls and unparseable arguments', async () => {
    const s = newSession()
    const fg = await project(s, {
      type: 'tool/call', seq: 1, time: 0,
      data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    expect(fg[0]?.toolBackground).toBeUndefined()

    const bad = await project(s, {
      type: 'tool/call', seq: 2, time: 0,
      data: { callId: 'c2', name: 'bash', arguments: 'not json' },
    })
    expect(bad[0]?.toolBackground).toBeUndefined()
  })
})

describe('projectSessionEvent todo/write snapshot', () => {
  it('maps the whole-list snapshot to a todo_update event', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'todo/write', seq: 1, time: 0,
      data: { todos: [{ content: 'first', status: 'completed' }, { content: 'second', status: 'in_progress' }] },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('todo_update')
    expect(events[0]?.todos).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
    ])
  })

  it('drops a snapshot without todos', async () => {
    const s = newSession()
    const events = await project(s, { type: 'todo/write', seq: 1, time: 0, data: {} })
    expect(events).toHaveLength(0)
  })
})

describe('projectSessionEvent per-request usage and tool-result meta', () => {
  it('rides the request usage on the text event', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'assistant/message', seq: 1, time: 0,
      data: {
        message: { content: [{ type: 'text', text: 'answer' }] },
        usage: { inputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2, outputTokens: 7 },
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('text')
    expect(events[0]?.inputTokens).toBe(10)
    expect(events[0]?.totalInputTokens).toBe(17)
    expect(events[0]?.outputTokens).toBe(7)
  })

  it('rides the request usage on the thinking event of a text-less message', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'assistant/message', seq: 1, time: 0,
      data: {
        message: { content: [{ type: 'reasoning', text: 'hmm' }] },
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('thinking')
    expect(events[0]?.inputTokens).toBe(3)
    expect(events[0]?.totalInputTokens).toBe(3)
    expect(events[0]?.outputTokens).toBe(4)
  })

  it('omits usage fields when the native event reports none', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'assistant/message', seq: 1, time: 0,
      data: { message: { content: [{ type: 'text', text: 'answer' }] } },
    })
    expect(events[0]?.inputTokens).toBeUndefined()
    expect(events[0]?.totalInputTokens).toBeUndefined()
  })

})

describe('projectSessionEvent compaction lifecycle', () => {
  it('projects compaction/start as a compaction event', async () => {
    const s = newSession()
    const events = await project(s, { type: 'compaction/start', seq: 1, time: 0, data: { compactionId: 'c1' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('compaction')
  })
})
