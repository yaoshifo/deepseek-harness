/**
 * Native session-event → bridge Event projection tests: the signals the
 * migration's lossy projection dropped (tool/result failure, todo/write
 * snapshots, compaction lifecycle, per-request usage, tool-result meta)
 * must survive the projection.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-projection
 */
import { describe, expect, it } from 'vitest'
import { DshAgentSession } from '../../src/agent-dsh/adapter.ts'
import type { Event } from '../../src/core/types.ts'

function newSession(): DshAgentSession {
  return new DshAgentSession('test:u1', { agent: { id: 'a1' } } as never)
}

describe('pendingBackgroundJobs', () => {
  const job = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'bash-1', kind: 'bash', label: 'build', status: 'running',
    ownerSession: 'a1', startedAt: 0, reported: false, ...over,
  })

  function newSessionWithJobs(list: () => Array<Record<string, unknown>>): DshAgentSession {
    const ctx = { get: (name: string) => (name === 'jobs' ? { list } : undefined) }
    return new DshAgentSession('test:u1', { agent: { id: 'a1' } } as never, '', ctx as never)
  }

  it("counts this session's live jobs only (running or stopping)", () => {
    const s = newSessionWithJobs(() => [
      job({ id: 'bash-1' }),
      job({ id: 'bash-2', status: 'stopping' }),
      job({ id: 'bash-3', status: 'completed', finishedAt: 1 }),
      job({ id: 'bash-4', status: 'failed', finishedAt: 1 }),
      job({ id: 'bash-5', ownerSession: 'other-session' }),
      job({ id: 'bash-6', ownerSession: undefined }),
    ])
    expect(s.pendingBackgroundJobs()).toBe(2)
  })

  it('returns 0 when the registry is absent from the context, and without a context at all', () => {
    const noRegistry = new DshAgentSession('test:u1', { agent: { id: 'a1' } } as never, '',
      { get: () => undefined } as never)
    expect(noRegistry.pendingBackgroundJobs()).toBe(0)
    expect(newSession().pendingBackgroundJobs()).toBe(0)
  })
})

/** Project one wrapped session event and drain buffered bridge events (bounded: the channel stays open). */
async function project(session: DshAgentSession, wrapped: Record<string, unknown>): Promise<Event[]> {
  session.projectSessionEvent(wrapped)
  return drain(session)
}

/** Drain buffered bridge events (bounded: the channel stays open). */
async function drain(session: DshAgentSession): Promise<Event[]> {
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

  it('carries activeForm through and drops an empty one', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'todo/write', seq: 1, time: 0,
      data: { todos: [
        { content: 'first', status: 'in_progress', activeForm: 'Doing first' },
        { content: 'second', status: 'pending', activeForm: '' },
      ] },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.todos).toEqual([
      { content: 'first', status: 'in_progress', activeForm: 'Doing first' },
      { content: 'second', status: 'pending' },
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

describe('projectSessionEvent skill-invocation injection', () => {
  it('projects the injected skill instructions message as a skill_invocation event', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'user/message', seq: 1, time: 0,
      data: {
        content: [{ type: 'text', text: '<skill_content name="explain">…</skill_content>' }],
        source: { kind: 'skill-invocation', name: 'explain', form: 'instructions' },
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('skill_invocation')
    expect(events[0]?.content).toBe('explain')
  })

  it('emits nothing for non-invocation sources and nameless invocations', async () => {
    const cases: Array<Record<string, unknown>> = [
      { kind: 'user' },
      { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      { kind: 'skill-catalog', form: 'catalog' },
      { kind: 'dsh-memory', version: 2 },
      { kind: 'skill-invocation' },
      { kind: 'skill-invocation', name: '' },
      { kind: 'skill-invocation', name: 42 },
    ]
    for (const source of cases) {
      const s = newSession()
      const events = await project(s, {
        type: 'user/message', seq: 1, time: 0,
        data: { content: [{ type: 'text', text: 'x' }], source },
      })
      expect(events, JSON.stringify(source)).toHaveLength(0)
    }
  })
})

describe('projectStreamChunk assistant-stream projection', () => {
  it('projects a reasoning-delta chunk into a thinking_delta event', async () => {
    const s = newSession()
    s.projectStreamChunk({ type: 'reasoning-delta', index: 0, text: '想' })
    const events = await drain(s)
    expect(events).toEqual([{ type: 'thinking_delta', content: '想', done: false }])
  })

  it('projects a text-delta chunk into a text_delta event', async () => {
    const s = newSession()
    s.projectStreamChunk({ type: 'text-delta', index: 1, text: '答' })
    const events = await drain(s)
    expect(events).toEqual([{ type: 'text_delta', content: '答', done: false }])
  })

  it('emits nothing for non-delta chunk kinds', async () => {
    const s = newSession()
    s.projectStreamChunk({ type: 'block-start', index: 0 })
    s.projectStreamChunk({ type: 'block-end', index: 0 })
    s.projectStreamChunk({ type: 'usage' })
    s.projectStreamChunk({ type: 'finish' })
    s.projectStreamChunk({ type: 'tool-call', index: 2 })
    const events = await drain(s)
    expect(events).toHaveLength(0)
  })
})

describe('projectSessionEvent turn/end stop-reason projection', () => {
  it('carries a max-tokens reason on the result event so the card need not claim completion', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'turn/end', seq: 1, time: 0,
      data: { turn: 1, reason: { kind: 'max-tokens' } },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('result')
    expect(events[0]?.stopReason).toBe('max-tokens')
  })

  it('omits stopReason for a completed turn', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'turn/end', seq: 1, time: 0,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.stopReason).toBeUndefined()
  })
})

describe('projectSessionEvent agent/inbox/spliced tool-jobs notice', () => {
  it('projects a next-step tool-jobs notice as a bg_task_notice event carrying its ids', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'agent/inbox/spliced', seq: 1, time: 0,
      data: {
        target: 'next-step', start: 0,
        inserted: [{
          role: 'user', id: 'n1',
          content: [{ type: 'text', text: 'background job bash-6 (bash: deploy) finished [status: completed, exit code: 0]. Read its output with job_output.' }],
          source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'bash deploy' },
        }],
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('bg_task_notice')
    expect(events[0]?.bgNoticeIDs).toEqual(['n1'])
  })

  it('collects every tool-jobs notice id from one splice and skips other messages', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'agent/inbox/spliced', seq: 1, time: 0,
      data: {
        target: 'next-step', start: 0,
        inserted: [
          { role: 'user', id: 'n1', content: [{ type: 'text', text: 'notice 1' }], source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' } },
          { role: 'user', id: 'u1', content: [{ type: 'text', text: 'steered text' }], source: { kind: 'user' } },
          { role: 'user', id: 'n2', content: [{ type: 'text', text: 'notice 2' }], source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' } },
        ],
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.bgNoticeIDs).toEqual(['n1', 'n2'])
  })

  it('projects nothing for next-turn splices, foreign sources, and removal-only splices', async () => {
    const notice = { role: 'user', id: 'n1', content: [{ type: 'text', text: 'notice' }], source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' } }
    const cases: Array<Record<string, unknown>> = [
      { target: 'next-turn', start: 0, inserted: [notice] },
      { target: 'next-step', start: 0, inserted: [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }] },
      { target: 'next-step', start: 0, inserted: [{ role: 'user', id: 's1', content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-invocation', name: 'explain', form: 'instructions' } }] },
      { target: 'next-step', start: 0, inserted: [{ role: 'user', id: 'p1', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'other-plugin', form: 'notice' } }] },
      { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      { target: 'next-step', start: 0, inserted: [{ role: 'user', content: [{ type: 'text', text: 'idless' }], source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice' } }] },
    ]
    for (const data of cases) {
      const s = newSession()
      const events = await project(s, { type: 'agent/inbox/spliced', seq: 1, time: 0, data: { ...data } })
      expect(events, JSON.stringify(data)).toHaveLength(0)
    }
  })
})

describe('projectSessionEvent deliverables/presented', () => {
  it('projects a presented deliverable batch with its declared files', async () => {
    const s = newSession()
    const events = await project(s, {
      type: 'deliverables/presented', seq: 1, time: 0,
      data: { turn: 1, callId: 'call_present', files: [{ path: 'out/report.md', description: 'the report' }, { path: 'out/chart.png' }] },
    })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('presented')
    expect(events[0]?.content).toContain('out/report.md')
    expect(events[0]?.content).toContain('out/chart.png')
    expect(events[0]?.toolInputRaw).toEqual({
      files: [{ path: 'out/report.md', description: 'the report' }, { path: 'out/chart.png' }],
    })
    expect(events[0]?.done).toBe(false)
  })
})
