/**
 * Real-composition guard (packages/AGENTS.md): the real mcp-workspace service
 * boots from a test-only cordis.yml through the actual Loader, and a session
 * created in a configured root directory mounts its `.mcp.json` stdio server
 * (a real child process) into the agent scope: the tool is visible and
 * callable in the agent's own view, invisible from the root view and from a
 * session outside the roots, unregistered on agent disposal, and a
 * same-named global instance is shadowed (not warned). The agent factory is
 * stubbed to the exact create path agent-loop runs — session create, mint
 * the agent scope, await setup, register — because the loop machine's LLM
 * side is the external boundary here.
 *
 * @module dsh-mcp-workspace/tests-composition
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, CreateAgentOptions, ResumeAgentOptions, AgentHandle } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as mcpWorkspaceEntry from '../src/index.ts'

const ECHO_SERVER = join(import.meta.dirname, 'fixtures', 'echo-server.mjs')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Minimal agent-loop-shaped factory: session create → agent scope → setup → register. */
function stubFactory(ctx: Context): AgentFactory {
  return {
    async createAgent(_ownerCtx, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, options.meta === undefined ? {} : { meta: options.meta })
      const agent = { id: session.id, session, status: 'idle' } as unknown as Agent
      const scope = createScope(ctx, agent)
      const agentCtx = scope.ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: async () => {
          unregister()
          await scope.dispose()
        },
      }
    },
    async resume(_ownerCtx, _options: ResumeAgentOptions): Promise<AgentHandle> {
      throw new Error('composition spec: resume is not exercised through the stub factory')
    },
  }
}

/** Names visible in one context's own scoped tool view (the agent view). */
function toolNamesOf(ctx: Context): string[] {
  const tools = ctx.get('tools')
  return tools === undefined ? [] : tools.schemas(scopeOf(ctx)).map((schema: { name: string }) => schema.name)
}

/** One tool definition as this context's own scope sees it. */
function scopedTool(ctx: Context, name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined {
  const tools = ctx.get('tools')
  return tools === undefined ? undefined : tools.get(name, scopeOf(ctx))
}

async function boot(configPath: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-mcp-workspace', mcpWorkspaceEntry],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('mcp-workspace plugin Config validation', () => {
  it('rejects a relative roots entry at load', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(mcpWorkspaceEntry.default, {
      roots: ['relative/root'],
      startupTimeoutMs: 10_000,
    })).rejects.toThrow('not an absolute directory path')
    await ctx.fiber.dispose()
  })
})

describe('mcp-workspace real Loader composition', () => {
  it('mounts a roots-directory .mcp.json server into the agent scope only', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-'))
    const projectDir = join(root, 'dida')
    const outsideDir = join(root, 'elsewhere')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        echo: { command: process.execPath, args: [ECHO_SERVER, 'from-directory'] },
      },
    }))

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: agents',
      "  name: '@deepseek-ai/dsh-agent'",
      '- id: sessions',
      "  name: '@deepseek-ai/dsh-session'",
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: mcp-workspace',
      "  name: '@deepseek-ai/dsh-mcp-workspace'",
      '  config:',
      `    roots: [${JSON.stringify(projectDir)}]`,
      '',
    ].join('\n'))

    context = await boot(configPath)
    const service = context.get('mcpWorkspace')
    if (service === undefined) throw new Error('the Loader composition did not mount the mcpWorkspace service')
    context.agents.setFactory(stubFactory(context))

    // Directory session: the mounted tool exists in the agent's own view and
    // executes against the real child process; the root view stays clean.
    const inside = await context.agents.create({
      sessionId: SessionId('in-dir'),
      meta: { cwd: projectDir },
      setup: service.wrap(undefined),
    })
    const agentTools = toolNamesOf((inside.agent as unknown as { ctx: Context }).ctx)
    expect(agentTools).toContain('mcp__echo__echo')
    expect(toolNamesOf(context)).not.toContain('mcp__echo__echo')

    const definition = scopedTool((inside.agent as unknown as { ctx: Context }).ctx, 'mcp__echo__echo')
    if (definition === undefined) throw new Error('the directory tool is missing from the agent tool view')
    const result = await definition.execute({ text: 'hi' }, { signal: new AbortController().signal })
    expect(JSON.stringify(result)).toContain('from-directory:hi')

    // Outside the roots: nothing mounts, same service, same wrap.
    const outside = await context.agents.create({
      sessionId: SessionId('out-dir'),
      meta: { cwd: outsideDir },
      setup: service.wrap(undefined),
    })
    expect(toolNamesOf((outside.agent as unknown as { ctx: Context }).ctx)).not.toContain('mcp__echo__echo')

    // mountedFor answers the /mcp listing for both cwds.
    await expect(service.mountedFor(projectDir)).resolves.toEqual([{ name: 'echo', transport: 'stdio' }])
    await expect(service.mountedFor(outsideDir)).resolves.toEqual([])

    // Disposal unregisters the directory tools (HMR-safety).
    await inside.dispose()
    expect(toolNamesOf((outside.agent as unknown as { ctx: Context }).ctx)).not.toContain('mcp__echo__echo')
    const afterDispose = await context.agents.create({
      sessionId: SessionId('in-dir-2'),
      meta: { cwd: projectDir },
      setup: service.wrap(undefined),
    })
    expect(toolNamesOf((afterDispose.agent as unknown as { ctx: Context }).ctx)).toContain('mcp__echo__echo')
    await afterDispose.dispose()
    await outside.dispose()
  })

  it('shadows a same-named global instance instead of colliding', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-shadow-'))
    const projectDir = join(root, 'dida')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        echo: { command: process.execPath, args: [ECHO_SERVER, 'from-directory'] },
      },
    }))

    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: agents',
      "  name: '@deepseek-ai/dsh-agent'",
      '- id: sessions',
      "  name: '@deepseek-ai/dsh-session'",
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: mcp-workspace',
      "  name: '@deepseek-ai/dsh-mcp-workspace'",
      '  config:',
      `    roots: [${JSON.stringify(projectDir)}]`,
      '',
    ].join('\n'))

    context = await boot(configPath)
    const service = context.get('mcpWorkspace')!
    context.agents.setFactory(stubFactory(context))

    // A GLOBAL instance owns the same serverName first.
    await context.plugin(McpClient, McpClient.Config({
      transport: 'stdio',
      serverName: 'echo',
      command: process.execPath,
      args: [ECHO_SERVER, 'from-global'],
      cwd: root,
    }))

    const agentHandle = await context.agents.create({
      sessionId: SessionId('shadow'),
      meta: { cwd: projectDir },
      setup: service.wrap(undefined),
    })
    const agentCtx = (agentHandle.agent as unknown as { ctx: Context }).ctx

    // The scoped registration shadows the global one: the agent executes the
    // directory server, the root view keeps the global one.
    const agentTools = toolNamesOf(agentCtx)
    expect(agentTools).toContain('mcp__echo__echo')
    const scoped = scopedTool(agentCtx, 'mcp__echo__echo')!
    const scopedResult = await scoped.execute({ text: 'x' }, { signal: new AbortController().signal })
    expect(JSON.stringify(scopedResult)).toContain('from-directory:x')

    const globalTool = scopedTool(context, 'mcp__echo__echo')
    if (globalTool === undefined) throw new Error('the global instance lost its tool')
    const globalResult = await globalTool.execute({ text: 'x' }, { signal: new AbortController().signal })
    expect(JSON.stringify(globalResult)).toContain('from-global:x')

    await agentHandle.dispose()
  })
})
