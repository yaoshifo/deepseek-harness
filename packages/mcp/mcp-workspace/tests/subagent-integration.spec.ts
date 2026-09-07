/**
 * Continuable-subagent integration guard: a real SubagentRuntime composition
 * mounts the parent-cwd `.mcp.json` servers into every continuable child's own
 * scope before publication, and stops mounting once the mcp-workspace plugin
 * unloads. Locks the directory-mount semantics against the continuation
 * manager's setup chain, whichever side contributes the mount.
 *
 * @module dsh-mcp-workspace/tests-subagent-integration
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import McpWorkspaceService from '../src/index.ts'

const ECHO_SERVER = join(import.meta.dirname, 'fixtures', 'echo-server.mjs')

/** Session query whose search faces are unavailable, as the subagent tests use. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Tool names visible in one context's own scoped view. */
function toolNamesOf(ctx: Context): string[] {
  const tools = ctx.get('tools')
  return tools === undefined ? [] : tools.schemas(scopeOf(ctx)).map((schema: { name: string }) => schema.name)
}

let context: Context | undefined
let projectRoot: string | undefined
let dataRoot: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [projectRoot, dataRoot]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  projectRoot = undefined
  dataRoot = undefined
})

/** One continuable start request for the given parent. */
function startSpec(parent: Agent, prompt: string) {
  return {
    provider: 'spawn',
    label: prompt,
    request: { prompt: [{ type: 'text' as const, text: prompt }], parent },
    signal: new AbortController().signal,
  }
}

/** Boot the continuable stack with directory MCP discovery over one project cwd. */
async function setupWithProject(
  turns: number,
): Promise<{ ctx: Context; parent: Agent; workspaceFiber: { dispose(): Promise<void> } }> {
  projectRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-subagent-'))
  dataRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-subagent-data-'))
  const projectDir = join(projectRoot, 'dida')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      echo: { command: process.execPath, args: [ECHO_SERVER, 'from-directory'] },
    },
  }))

  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: dataRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const workspaceFiber = await ctx.plugin(McpWorkspaceService, { roots: [projectDir] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: turns }, () => textResponse('done'))))
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: projectDir },
  )
  return { ctx, parent, workspaceFiber }
}

describe('continuable subagents and directory MCP', () => {
  it('mounts the parent-cwd .mcp.json servers into each continuable child before publication', async () => {
    const { ctx, parent } = await setupWithProject(1)

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'child task'))

    const child = ctx.agents.get(started.childId)
    if (child === undefined) throw new Error('the continuable child is not live after startContinuable')
    expect(toolNamesOf(child.ctx)).toContain('mcp__echo__echo')
    expect(toolNamesOf(ctx)).not.toContain('mcp__echo__echo')
  })

  it('stops mounting after the mcp-workspace plugin unloads', async () => {
    const { ctx, parent, workspaceFiber } = await setupWithProject(2)
    const first = await ctx.subagents.startContinuable(startSpec(parent, 'first child'))
    const firstChild = ctx.agents.get(first.childId)
    if (firstChild === undefined) throw new Error('the first continuable child is not live')
    expect(toolNamesOf(firstChild.ctx)).toContain('mcp__echo__echo')

    await workspaceFiber.dispose()

    const second = await ctx.subagents.startContinuable(startSpec(parent, 'second child'))
    const secondChild = ctx.agents.get(second.childId)
    if (secondChild === undefined) throw new Error('the second continuable child is not live')
    expect(toolNamesOf(secondChild.ctx)).not.toContain('mcp__echo__echo')
  })

  it('mounts the same servers into one-shot children driven by the in-process driver', async () => {
    const { ctx, parent } = await setupWithProject(1)

    const run = await startInProcessRun({
      label: 'one-shot task',
      prompt: [{ type: 'text' as const, text: 'one-shot task' }],
      parent,
      signal: new AbortController().signal,
      descriptor: snapshotSubagentDescriptor({
        mode: 'one-shot' as const,
        provider: 'test',
        label: 'one-shot task',
      }),
    }, {})

    const child = ctx.agents.get(run.id)
    if (child === undefined) throw new Error('the one-shot child is not live')
    expect(toolNamesOf(child.ctx)).toContain('mcp__echo__echo')
    await run.dispose()
  })
})
