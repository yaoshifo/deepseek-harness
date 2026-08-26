// Drives the REAL plugin body: real SystemPrompt + ToolRuntime + AgentRegistry
// services with the plugin mounted, fake Agents backed by real Sessions. Only
// the agent wrapper is a stand-in; the section, tools, and pre-step listener
// are the shipping code.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { GLOBAL_MEMORY_PROMPT, MEMORY_PROMPT } from '../src/prompt.ts'

const CWD = '/home/hm/workspace/ainvest'
const signal = new AbortController().signal

let root: string
let context: Context | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-memory-idx-'))
})

afterAll(async () => {
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function setup(globalConfig?: plugin.GlobalConfig): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(plugin, {
    claudeHome: root,
    maxIndexBytes: 25_600,
    ...(globalConfig === undefined ? {} : { global: globalConfig }),
  })
  return ctx
}

let agentCounter = 0

function makeAgent(ctx: Context, over: { cwd?: string; origin?: 'subagent' | 'oneshot' } = {}): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(`mem-agent-${++agentCounter}`)
  const header = {
    version: 0,
    id,
    createdAt: Date.now(),
    ...(over.cwd !== undefined ? { cwd: over.cwd } : {}),
    ...(over.origin !== undefined ? { origin: over.origin } : {}),
  }
  const session = Session.create(id, [], header)
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

let callCounter = 0

function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

async function seedIndex(content: string): Promise<void> {
  const dir = join(root, 'projects', '-home-hm-workspace-ainvest', 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'MEMORY.md'), content)
}

async function seedGlobalIndex(content: string): Promise<void> {
  const dir = join(root, 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'MEMORY.md'), content)
}

describe('system-prompt section', () => {
  it('renders the verbatim strategy with the instantiated memory directory', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain(join(root, 'projects', '-home-hm-workspace-ainvest', 'memory'))
    expect(prompt).toContain('Each memory is one file holding one fact, with frontmatter:')
  })

  it('contributes nothing for a subagent or a cwd-less session', async () => {
    const ctx = await setup()
    context = ctx
    const sub = makeAgent(ctx, { cwd: CWD, origin: 'subagent' })
    const bare = makeAgent(ctx, {})
    const subPrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: sub, scope: sub }))
    const barePrompt = renderPrompt(await ctx.systemPrompt.assemble({ agent: bare, scope: bare }))
    expect(subPrompt.includes('persistent file-based memory')).toBe(false)
    expect(barePrompt.includes('persistent file-based memory')).toBe(false)
  })

  it('matches the prompt constant apart from the directory substitution', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).toContain(MEMORY_PROMPT.replaceAll(
      '{{memoryDirectory}}',
      join(root, 'projects', '-home-hm-workspace-ainvest', 'memory'),
    ))
  })
})

describe('memory tools', () => {
  it('writes with the session id as provenance, then reads and deletes', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const write = await call(ctx, 'memory_write', {
      name: 'feedback-x',
      content: '---\nname: feedback-x\nmetadata:\n  type: feedback\n---\nbody',
    }, agent)
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('expected success')
    expect((write.value as { name: string }).name).toBe('feedback-x.md')
    const read = await call(ctx, 'memory_read', { name: 'feedback-x.md' }, agent)
    expect(read.isError).toBe(false)
    if (read.isError) throw new Error('expected success')
    expect((read.value as { content: string }).content).toContain(`originSessionId: ${String(agent.session.id)}`)
    const list = await call(ctx, 'memory_list', {}, agent)
    expect(list.isError).toBe(false)
    if (list.isError) throw new Error('expected success')
    const listed = list.value as { exists: boolean; entries: { name: string }[] }
    expect(listed.exists).toBe(true)
    expect(listed.entries.map(entry => entry.name)).toContain('feedback-x.md')
    const remove = await call(ctx, 'memory_delete', { name: 'feedback-x.md' }, agent)
    expect(remove.isError).toBe(false)
    const after = await call(ctx, 'memory_read', { name: 'feedback-x.md' }, agent)
    expect(after.isError).toBe(true)
  })

  it('reports a missing read as an error and a missing directory as exists=false', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: '/home/hm/workspace/fresh' })
    const missing = await call(ctx, 'memory_read', { name: 'MEMORY.md' }, agent)
    expect(missing.isError).toBe(true)
    const list = await call(ctx, 'memory_list', {}, agent)
    expect(list.isError).toBe(false)
    if (list.isError) throw new Error('expected success')
    expect((list.value as { exists: boolean }).exists).toBe(false)
  })

  it('rejects an agentless caller', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('call-agentless'),
      name: 'memory_list',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    void agent
  })

  it('upserts and removes a pointer line through memory_index', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const upsert = await call(ctx, 'memory_index', {
      action: 'upsert',
      name: 'feedback-x',
      title: 'Feedback X',
      hook: 'about x',
    }, agent)
    expect(upsert.isError).toBe(false)
    if (upsert.isError) throw new Error('expected success')
    expect(upsert.value).toMatchObject({ name: 'feedback-x.md', action: 'upsert', changed: true })
    const indexed = await call(ctx, 'memory_read', { name: 'MEMORY.md' }, agent)
    expect(indexed.isError).toBe(false)
    if (indexed.isError) throw new Error('expected success')
    expect((indexed.value as { content: string }).content).toContain('- [Feedback X](feedback-x.md) — about x')
    const remove = await call(ctx, 'memory_index', { action: 'remove', name: 'feedback-x.md' }, agent)
    expect(remove.isError).toBe(false)
    if (remove.isError) throw new Error('expected success')
    expect(remove.value).toMatchObject({ name: 'feedback-x.md', action: 'remove', changed: true })
    const after = await call(ctx, 'memory_read', { name: 'MEMORY.md' }, agent)
    expect(after.isError).toBe(false)
    if (after.isError) throw new Error('expected success')
    expect((after.value as { content: string }).content).not.toContain('](feedback-x.md)')
  })

  it('rejects a memory_index upsert missing title or hook, and multi-line values', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const bare = await call(ctx, 'memory_index', { action: 'upsert', name: 'x' }, agent)
    expect(bare.isError).toBe(true)
    const multiline = await call(ctx, 'memory_index', {
      action: 'upsert',
      name: 'x',
      title: 'T\nT',
      hook: 'h',
    }, agent)
    expect(multiline.isError).toBe(true)
  })
})

/** Enter-message count for one decision; rejects non-enter outcomes loudly. */
function enterCount(decision: PreStepDecision): number {
  return decision.kind === 'enter' ? decision.messages.length : -1
}

/** Drive one agent/pre-step waterfall with the given claimed prompt messages. */
async function emitPreStep(ctx: Context, agent: Agent, over: {
  step?: number
  decision?: PreStepDecision
  messages?: unknown[]
} = {}): Promise<PreStepDecision> {
  const prompt = createUserMessage({
    content: [{ type: 'text', text: 'do work' }],
    source: { kind: 'plugin', plugin: 'test' },
  })
  const messages = over.messages === undefined ? [prompt] : over.messages as never[]
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: over.step ?? 1, signal },
    () => Promise.resolve(over.decision ?? { kind: 'enter' as const, messages }),
  )
}

describe('session-start index injection', () => {
  it('folds the index message right after the claimed prompt on step 1', async () => {
    const ctx = await setup()
    context = ctx
    await seedIndex('# Memory Index\n\n- [A](a.md) — hook about ainvest')
    const agent = makeAgent(ctx, { cwd: CWD })
    const decision = await emitPreStep(ctx, agent)
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages.at(1)
    if (injected === undefined) throw new Error('expected injected message')
    expect(injected.source).toMatchObject({ kind: 'claude-memory', project: '-home-hm-workspace-ainvest' })
    expect(JSON.stringify(injected.content)).toContain('hook about ainvest')
    expect(JSON.stringify(injected.content)).toContain('<system-reminder>')
  })

  it('injects only once per session', async () => {
    const ctx = await setup()
    context = ctx
    await seedIndex('# Memory Index\n- [A](a.md)')
    const agent = makeAgent(ctx, { cwd: CWD })
    const first = await emitPreStep(ctx, agent)
    if (first.kind !== 'enter') throw new Error('expected enter')
    for (const message of first.messages) {
      if (message.source.kind === 'claude-memory') {
        agent.session.append('user/message', message, { surfaceOp: 'append' })
      }
    }
    const second = await emitPreStep(ctx, agent)
    expect(enterCount(second)).toBe(1)
  })

  it('skips injection without MEMORY.md, for subagents and oneshot side queries, and after step 1', async () => {
    const ctx = await setup()
    context = ctx
    const bare = makeAgent(ctx, { cwd: '/home/hm/workspace/bare' })
    expect(enterCount(await emitPreStep(ctx, bare))).toBe(1)
    await seedIndex('# Memory Index\n- [A](a.md)')
    const sub = makeAgent(ctx, { cwd: CWD, origin: 'subagent' })
    expect(enterCount(await emitPreStep(ctx, sub))).toBe(1)
    // A oneshot side query (group naming, rendering) carries its context in
    // the prompt; a cwd-derived index would be noise that can skew its output.
    const oneshot = makeAgent(ctx, { cwd: CWD, origin: 'oneshot' })
    expect(enterCount(await emitPreStep(ctx, oneshot))).toBe(1)
    const later = makeAgent(ctx, { cwd: CWD })
    expect(enterCount(await emitPreStep(ctx, later, { step: 2 }))).toBe(1)
  })

  it('leaves a reject decision untouched', async () => {
    const ctx = await setup()
    context = ctx
    await seedIndex('# Memory Index\n- [A](a.md)')
    const agent = makeAgent(ctx, { cwd: CWD })
    const reject: PreStepDecision = { kind: 'reject' }
    const decision = await emitPreStep(ctx, agent, { decision: reject })
    expect(decision.kind).toBe('reject')
  })
})

describe('global memory scope', () => {
  it('is enabled by default with the project budget, and disabled by enabled: false', async () => {
    const ctx = await setup()
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).toContain('## Global memory')
    expect(prompt).toContain(GLOBAL_MEMORY_PROMPT.replaceAll('{{globalMemoryDirectory}}', join(root, 'memory')))

    const off = await setup({ enabled: false })
    context = off
    const offAgent = makeAgent(off, { cwd: CWD })
    const offPrompt = renderPrompt(await off.systemPrompt.assemble({ agent: offAgent, scope: offAgent }))
    expect(offPrompt).not.toContain('## Global memory')
    const globalWrite = await call(off, 'memory_write', {
      scope: 'global',
      name: 'machine-pit',
      content: 'body',
    }, offAgent)
    expect(globalWrite.isError).toBe(true)
  })

  it('appends the global strategy with its instantiated directory when enabled', async () => {
    const ctx = await setup({ maxIndexBytes: 8_192 })
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).toContain(GLOBAL_MEMORY_PROMPT.replaceAll('{{globalMemoryDirectory}}', join(root, 'memory')))
    expect(prompt).toContain(MEMORY_PROMPT.replaceAll(
      '{{memoryDirectory}}',
      join(root, 'projects', '-home-hm-workspace-ainvest', 'memory'),
    ))
  })

  it('injects the global index first, then the project index, each once', async () => {
    const ctx = await setup({ maxIndexBytes: 8_192 })
    context = ctx
    await seedGlobalIndex('# Memory Index\n\n- [Machine pit](machine-pit.md) — holds everywhere')
    await seedIndex('# Memory Index\n\n- [A](a.md) — hook about ainvest')
    const agent = makeAgent(ctx, { cwd: CWD })
    const first = await emitPreStep(ctx, agent)
    if (first.kind !== 'enter') throw new Error('expected enter')
    expect(first.messages).toHaveLength(3)
    expect(first.messages.at(1)?.source).toMatchObject({ kind: 'claude-memory', scope: 'global', version: 2 })
    expect(first.messages.at(1)?.source).not.toHaveProperty('project')
    expect(JSON.stringify(first.messages.at(1)?.content)).toContain('Global memory index')
    expect(JSON.stringify(first.messages.at(1)?.content)).toContain('holds everywhere')
    expect(first.messages.at(2)?.source).toMatchObject({ kind: 'claude-memory', scope: 'project', project: '-home-hm-workspace-ainvest' })
    expect(JSON.stringify(first.messages.at(2)?.content)).toContain('hook about ainvest')
    for (const message of first.messages) {
      if (message.source.kind === 'claude-memory') {
        agent.session.append('user/message', message, { surfaceOp: 'append' })
      }
    }
    const second = await emitPreStep(ctx, agent)
    expect(enterCount(second)).toBe(1)
  })

  it('skips the global injection without a global MEMORY.md or for a subagent', async () => {
    const ctx = await setup({ maxIndexBytes: 8_192 })
    context = ctx
    await rm(join(root, 'memory'), { recursive: true, force: true })
    await seedIndex('# Memory Index\n- [A](a.md)')
    const agent = makeAgent(ctx, { cwd: CWD })
    const onlyProject = await emitPreStep(ctx, agent)
    if (onlyProject.kind !== 'enter') throw new Error('expected enter')
    expect(onlyProject.messages).toHaveLength(2)
    expect(onlyProject.messages.at(1)?.source).toMatchObject({ scope: 'project' })
    const sub = makeAgent(ctx, { cwd: CWD, origin: 'subagent' })
    expect(enterCount(await emitPreStep(ctx, sub))).toBe(1)
  })

  it('routes scope=global tools to the global directory and keeps project the default', async () => {
    const ctx = await setup({ maxIndexBytes: 8_192 })
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const write = await call(ctx, 'memory_write', {
      scope: 'global',
      name: 'machine-pit',
      content: '---\nname: machine-pit\nmetadata:\n  type: feedback\n---\nbody',
    }, agent)
    expect(write.isError).toBe(false)
    if (write.isError) throw new Error('expected success')
    const read = await call(ctx, 'memory_read', { scope: 'global', name: 'machine-pit.md' }, agent)
    expect(read.isError).toBe(false)
    if (read.isError) throw new Error('expected success')
    expect((read.value as { content: string }).content).toContain('originSessionId: ' + String(agent.session.id))
    const list = await call(ctx, 'memory_list', { scope: 'global' }, agent)
    expect(list.isError).toBe(false)
    if (list.isError) throw new Error('expected success')
    expect((list.value as { exists: boolean; entries: { name: string }[] }).entries.map(entry => entry.name))
      .toContain('machine-pit.md')
    // Default scope stays project: the same name does not exist there.
    const projectRead = await call(ctx, 'memory_read', { name: 'machine-pit.md' }, agent)
    expect(projectRead.isError).toBe(true)
    const remove = await call(ctx, 'memory_delete', { scope: 'global', name: 'machine-pit.md' }, agent)
    expect(remove.isError).toBe(false)
  })

  it('keeps the global index budget separate from the project one', async () => {
    const ctx = await setup({ maxIndexBytes: 8_192, maxIndexLines: 5 })
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const overLines = Array.from({ length: 6 }, (_, i) => `- item ${i}`).join('\n')
    const globalWrite = await call(ctx, 'memory_write', { scope: 'global', name: 'MEMORY.md', content: overLines }, agent)
    expect(globalWrite.isError).toBe(false)
    if (globalWrite.isError) throw new Error('expected success')
    expect((globalWrite.value as { warning?: string }).warning).toMatch(/5 lines/)
    const projectWrite = await call(ctx, 'memory_write', { name: 'MEMORY.md', content: overLines }, agent)
    expect(projectWrite.isError).toBe(false)
    if (projectWrite.isError) throw new Error('expected success')
    expect((projectWrite.value as { warning?: string }).warning).toBeUndefined()
  })

  it('fails loud when scope=global reaches a disabled deployment', async () => {
    const ctx = await setup({ enabled: false })
    context = ctx
    const agent = makeAgent(ctx, { cwd: CWD })
    const result = await call(ctx, 'memory_write', {
      scope: 'global',
      name: 'machine-pit',
      content: 'body',
    }, agent)
    expect(result.isError).toBe(true)
  })

  it('rejects an agentless global-scope caller', async () => {
    const ctx = await setup({ maxIndexBytes: 8_192 })
    context = ctx
    const result = await ctx.tools.execute({
      signal,
      callId: CallId('call-agentless-global'),
      name: 'memory_list',
      arguments: { scope: 'global' },
    })
    expect(result.isError).toBe(true)
  })
})
