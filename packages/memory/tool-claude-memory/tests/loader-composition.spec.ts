// REAL-composition proof: the plugin boots through the real Loader from a
// cordis.yml file, its config is real configurability (the index budget is set
// from YAML), the section/tools/pre-step all work on the booted tree, and
// disposing the plugin fiber removes its contributions (HMR safety).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ClaudeMemory from '@deepseek-ai/dsh-tool-claude-memory'

const signal = new AbortController().signal
const CWD = '/home/hm/workspace/ainvest'

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  root = undefined
  context = undefined
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(configFor: (home: string) => readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-claude-memory-loader-'))
  const configLines = configFor(join(root, 'claude'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-claude-memory'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-claude-memory', ClaudeMemory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function makeAgent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('claude-memory-loader-agent')
  const session = Session.create(id, [], { version: 0, id, createdAt: Date.now(), cwd: CWD })
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

async function seedIndex(claudeHome: string, content: string): Promise<void> {
  const dir = join(claudeHome, 'projects', '-home-hm-workspace-ainvest', 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'MEMORY.md'), content)
}

async function seedGlobalIndex(claudeHome: string, content: string): Promise<void> {
  const dir = join(claudeHome, 'memory')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'MEMORY.md'), content)
}

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

describe('claude-memory real Loader composition through cordis.yml', () => {
  it('boots with YAML config and works end to end', async () => {
    const ctx = await boot(home => [
      `    claudeHome: ${home}`,
      '    maxIndexBytes: 25600',
      '    maxIndexLines: 5',
    ])
    await seedIndex(join(root!, 'claude'), '# Memory Index\n- [A](a.md) — hook')

    for (const tool of ['memory_list', 'memory_read', 'memory_write', 'memory_delete', 'memory_index']) {
      expect(toolNames(ctx)).toContain(tool)
    }

    const agent = makeAgent(ctx)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).toContain(join(root!, 'claude', 'projects', '-home-hm-workspace-ainvest', 'memory'))
    expect(prompt).toContain('Each memory is one file holding one fact')

    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [proposed], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages.at(1)?.source.kind).toBe('claude-memory')

    const write = await ctx.tools.execute({
      signal,
      callId: CallId('loader-write'),
      name: 'memory_write',
      arguments: {
        name: 'feedback-loader.md',
        content: '---\nname: feedback-loader\nmetadata:\n  type: feedback\n---\nbody',
      },
      agent,
    })
    expect(write.isError).toBe(false)
    const index = await ctx.tools.execute({
      signal,
      callId: CallId('loader-index'),
      name: 'memory_index',
      arguments: { action: 'upsert', name: 'feedback-loader', title: 'Feedback loader', hook: 'loader hook' },
      agent,
    })
    expect(index.isError).toBe(false)
    if (index.isError) throw new Error('expected success')
    expect(index.value).toMatchObject({ name: 'feedback-loader.md', changed: true })
  }, 30_000)

  it('fails loading when maxIndexBytes is omitted', async () => {
    await expect(boot(() => [])).rejects.toThrow('$.maxIndexBytes missing required value')
  }, 30_000)

  it('fails loading when global memory is enabled without a byte budget', async () => {
    await expect(boot(home => [
      `    claudeHome: ${home}`,
      '    maxIndexBytes: 25600',
      '    global:',
      '      maxIndexLines: 5',
    ])).rejects.toThrow('global.maxIndexBytes must be a positive number')
  }, 30_000)

  it('boots with global memory enabled and injects both indexes', async () => {
    const ctx = await boot(home => [
      `    claudeHome: ${home}`,
      '    maxIndexBytes: 25600',
      '    global:',
      '      maxIndexBytes: 8192',
    ])
    await seedIndex(join(root!, 'claude'), '# Memory Index\n- [A](a.md) — hook')
    await seedGlobalIndex(join(root!, 'claude'), '# Memory Index\n- [G](g.md) — holds everywhere')

    const agent = makeAgent(ctx)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).toContain('## Global memory')
    expect(prompt).toContain(join(root!, 'claude', 'memory'))

    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [proposed], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
    )
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(3)
    expect(decision.messages.at(1)?.source).toMatchObject({ kind: 'claude-memory', scope: 'global' })
    expect(JSON.stringify(decision.messages.at(1)?.content)).toContain('holds everywhere')
    expect(decision.messages.at(2)?.source).toMatchObject({ kind: 'claude-memory', scope: 'project' })

    const write = await ctx.tools.execute({
      signal,
      callId: CallId('loader-global-write'),
      name: 'memory_write',
      arguments: {
        scope: 'global',
        name: 'machine-pit-loader.md',
        content: '---\nname: machine-pit-loader\nmetadata:\n  type: feedback\n---\nbody',
      },
      agent,
    })
    expect(write.isError).toBe(false)
    const read = await ctx.tools.execute({
      signal,
      callId: CallId('loader-global-read'),
      name: 'memory_read',
      arguments: { scope: 'global', name: 'machine-pit-loader.md' },
      agent,
    })
    expect(read.isError).toBe(false)
    if (read.isError) throw new Error('expected success')
    expect((read.value as { content: string }).content).toContain('machine-pit-loader')
  }, 30_000)

  it('disposes cleanly: disposing the plugin fiber removes section, tools, and listener', async () => {
    // HMR safety: mount the plugin directly, then dispose the fiber and
    // observe every contribution leave. (The Loader-booted tree keeps its own
    // instance; stacking a second registration of the same plugin would
    // duplicate names, so this scenario mounts on a bare tree.)
    root = await mkdtemp(join(tmpdir(), 'dsh-claude-memory-dispose-'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(ClaudeMemory, {
      claudeHome: join(root, 'claude'),
      maxIndexBytes: 25_600,
    })
    expect(toolNames(ctx)).toContain('memory_write')
    await fiber.dispose()
    expect(toolNames(ctx)).not.toContain('memory_write')
    const agent = makeAgent(ctx)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).not.toContain('persistent file-based memory')

    await seedIndex(join(root, 'claude'), '# Memory Index\n- [A](a.md)')
    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [proposed], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
    )
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(1)
  }, 30_000)
})
