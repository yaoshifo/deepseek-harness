/**
 * Scoped suppression of workspace-instruction injection: `suppress()` in an
 * agent's scope stops the baseline and every dynamic touch for that agent
 * without touching any other agent, a marker registered by an enclosing scope
 * also suppresses descendant agents, disposal restores injection, and a marker
 * registered on an unscoped context suppresses globally.
 *
 * @module dsh-agent-instructions/tests-suppression
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Inbox, agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'

const testToolSignal = new AbortController().signal

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-workspace-context-suppress-'))
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** Seed a repo with a user-global file and a project root AGENTS.md plus a nested one. */
async function seededRepo(): Promise<{ root: string; home: string }> {
  const root = await tempRepo()
  const home = await tempRepo()
  await mkdir(join(root, '.git'), { recursive: true })
  await write(join(home, 'AGENTS.md'), 'global rule')
  await write(join(root, 'AGENTS.md'), 'baseline root rule')
  await write(join(root, 'pkg/AGENTS.md'), 'nested package rule')
  await write(join(root, 'pkg/deep/file.txt'), 'hello')
  return { root, home }
}

function stubAgent(cwd: string): Agent {
  const id = SessionId('s1')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id: SessionId('a1'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('agent-instructions must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Drive one entering pre-step so the plugin composes and settles the inbox. */
async function drivePreStep(ctx: Context, agent: Agent): Promise<void> {
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step', { messages: [], turn: 1, step: 1, signal: testToolSignal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
}

async function pendingContext(agent: Agent): Promise<number> {
  return agent.inbox.nextStep.filter(message => message.source.kind === 'agent-instructions').length
}

async function waitForPending(agent: Agent): Promise<void> {
  await vi.waitFor(async () => {
    expect(await pendingContext(agent)).toBeGreaterThan(0)
  }, { timeout: 10_000 })
}

describe('agentInstructions.suppress', () => {
  it('a scoped suppressor stops the baseline for that agent', async () => {
    const { root, home } = await seededRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const scope = createScope(ctx, agent)
      const dispose = scope.ctx.get('agentInstructions')!.suppress()

      await drivePreStep(ctx, agent)

      expect(agent.inbox.nextStep).toEqual([])
      expect(await pendingContext(agent)).toBe(0)

      dispose()
      await scope.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a scoped suppressor leaves another agent\'s injection intact', async () => {
    const { root, home } = await seededRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const suppressed = stubAgent(root)
      const other = stubAgent(root)
      const scope = createScope(ctx, suppressed)
      scope.ctx.get('agentInstructions')!.suppress()

      await drivePreStep(ctx, suppressed)
      expect(suppressed.inbox.nextStep).toEqual([])
      // A registration that wrongly landed on the global layer would empty
      // this agent's baseline too — the negative control existing cases lack.
      await drivePreStep(ctx, other)
      await waitForPending(other)
      const text = other.inbox.nextStep
        .find(message => message.source.kind === 'agent-instructions')
        ?.content.map(block => block.type === 'text' ? block.text : '').join('\n') ?? ''
      expect(text).toContain('baseline root rule')

      await scope.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('an enclosing scope\'s marker suppresses a descendant agent', async () => {
    const { root, home } = await seededRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const parent = stubAgent(root)
      const child = stubAgent(root)
      const parentScope = createScope(ctx, parent)
      const dispose = parentScope.ctx.get('agentInstructions')!.suppress()
      bindScopeParent(child, parent)

      await drivePreStep(ctx, child)
      expect(child.inbox.nextStep).toEqual([])

      dispose()
      await drivePreStep(ctx, child)
      await waitForPending(child)
      const text = child.inbox.nextStep
        .find(message => message.source.kind === 'agent-instructions')
        ?.content.map(block => block.type === 'text' ? block.text : '').join('\n') ?? ''
      expect(text).toContain('baseline root rule')

      await parentScope.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposing the suppressor restores baseline injection', async () => {
    const { root, home } = await seededRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const scope = createScope(ctx, agent)
      const dispose = scope.ctx.get('agentInstructions')!.suppress()
      await drivePreStep(ctx, agent)
      expect(await pendingContext(agent)).toBe(0)

      dispose()
      await drivePreStep(ctx, agent)
      await waitForPending(agent)
      const text = agent.inbox.nextStep
        .find(message => message.source.kind === 'agent-instructions')
        ?.content.map(block => block.type === 'text' ? block.text : '').join('\n') ?? ''
      expect(text).toContain('baseline root rule')

      await scope.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('filesystem touches inject nothing while suppressed, then resume after disposal', async () => {
    const { root, home } = await seededRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(ToolFs)
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const scope = createScope(ctx, agent)
      const dispose = scope.ctx.get('agentInstructions')!.suppress()

      const first = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('read-suppressed'),
        name: 'read',
        arguments: { file_path: join(root, 'pkg/deep/file.txt') },
        agent,
      })
      expect(first.isError).toBe(false)
      await drivePreStep(ctx, agent)
      expect(await pendingContext(agent)).toBe(0)

      dispose()
      const second = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('read-restored'),
        name: 'read',
        arguments: { file_path: join(root, 'pkg/deep/file.txt') },
        agent,
      })
      expect(second.isError).toBe(false)
      await waitForPending(agent)
      const text = agent.inbox.nextStep
        .find(message => message.source.kind === 'agent-instructions')
        ?.content.map(block => block.type === 'text' ? block.text : '').join('\n') ?? ''
      expect(text).toContain('baseline root rule')
      expect(text).toContain('nested package rule')

      await scope.dispose()
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a suppressor registered on an unscoped context suppresses every agent', async () => {
    const { root, home } = await seededRepo()
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { cwd: '/' })
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
      await ctx.plugin(workspaceContext, { dshHome: home, maxBytes: 65536 })
      const agent = stubAgent(root)
      const dispose = ctx.get('agentInstructions')!.suppress()

      await drivePreStep(ctx, agent)
      expect(await pendingContext(agent)).toBe(0)

      dispose()
      await drivePreStep(ctx, agent)
      await waitForPending(agent)

      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
