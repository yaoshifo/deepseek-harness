/**
 * MCP health runtime-context tests: the opt-in `mcpHealth` config must
 * register a `feishu-bridge:mcp-health` system-prompt context that states
 * every configured server still missing from the process-global tool
 * registry (after the startup grace), stay silent while healthy, and prove
 * HMR disposal. Runs over a real Cordis Context with real SystemPrompt /
 * ToolRuntime services; the watched tool is registered by a separate plugin
 * fiber, the same cross-instance shape the daemon's mcp-client rows use.
 *
 * @module dsh-feishu-bridge/tests-mcp-health
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Fiber } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as entry from '../src/index.js'
import { MCP_HEALTH_CONTEXT_NAME, registerMcpHealthContext, splitMcpToolName } from '../src/core/mcp-health.js'
import type { McpHealthConfig, FeishuBridgeConfig } from '../src/index.js'

const contexts: CordisContext[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(): Promise<CordisContext> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  // The bridge declares sessionProjections in its inject (the /context card
  // reads the registry); dsh-base always mounts it, and so does this minimal
  // host or the bridge fiber stays inactive.
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

function baseConfig(mcpHealth?: McpHealthConfig): FeishuBridgeConfig {
  // Isolated dataDir: without it the process-wide cron/relay stores would
  // read (and potentially write) the developer's live daemon state.
  return {
    projects: [],
    providers: {},
    dataDir: mkdtempSync(join(tmpdir(), 'fb-mcp-health-')),
    ...(mcpHealth === undefined ? {} : { mcpHealth }),
  }
}

function healthConfig(servers: McpHealthConfig['servers']): McpHealthConfig {
  return { servers, startupGraceSecs: 0 }
}

/** A minimal mcp-client-shaped tool, registered through its own plugin fiber. */
async function mountMcpToolFiber(ctx: CordisContext, toolName: string): Promise<Fiber> {
  const tool = defineContentToolFixture({
    name: toolName,
    description: 'mcp fixture tool',
    parameters: {},
    execute: async () => [{ type: 'text', text: 'pong' }],
  })
  const fiber = ctx.plugin({
    name: 'mcp-fixture-row',
    inject: ['tools'],
    apply: (row: CordisContext) => { row.tools.register(tool) },
  })
  await fiber
  return fiber
}

async function healthText(ctx: CordisContext): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble()
  return assembly.contexts.find(context => context.name === MCP_HEALTH_CONTEXT_NAME)?.text ?? ''
}

describe('config schema (loader resolveConfig path)', () => {
  const validate = (config: unknown): Record<string, unknown> => {
    const result = entry.Config['~standard'].validate(config)
    if ('then' in result) throw new TypeError('unexpected async validation')
    if (result.issues) throw new Error(`validation issues: ${JSON.stringify(result.issues)}`)
    return result.value as Record<string, unknown>
  }

  it('materializes an empty default mcpHealth when absent (fully off)', () => {
    // Schemastery fills nested defaults even for an absent key, so "off" is
    // the empty servers list the apply() guard checks, not a missing key.
    expect(validate({ projects: [], providers: {} }).mcpHealth).toEqual({ servers: [], startupGraceSecs: 180 })
  })

  it('fills the servers/startupGraceSecs defaults when mcpHealth is present', () => {
    const resolved = validate({ projects: [], providers: {}, mcpHealth: {} }).mcpHealth as Record<string, unknown>
    expect(resolved.servers).toEqual([])
    expect(resolved.startupGraceSecs).toBe(180)
  })

  it('requires serverName on each entry and keeps an explicit fixHint', () => {
    const bad = entry.Config['~standard'].validate({
      projects: [], providers: {}, mcpHealth: { servers: [{ fixHint: 'x' }] },
    })
    expect('issues' in bad && bad.issues !== undefined).toBe(true)

    const good = validate({
      projects: [], providers: {},
      mcpHealth: { servers: [{ serverName: 'devx-mcp', fixHint: 'renew' }], startupGraceSecs: 30 },
    }).mcpHealth as Record<string, unknown>
    expect(good.servers).toEqual([{ serverName: 'devx-mcp', fixHint: 'renew' }])
    expect(good.startupGraceSecs).toBe(30)
  })
})

describe('mcpHealth context registration', () => {
  it('registers no context by default and with an empty servers list', async () => {
    const offCtx = await mount()
    await offCtx.plugin(entry, baseConfig())
    expect((await offCtx.systemPrompt.assemble()).contexts.map(c => c.name))
      .not.toContain(MCP_HEALTH_CONTEXT_NAME)

    const emptyCtx = await mount()
    await emptyCtx.plugin(entry, baseConfig(healthConfig([])))
    expect((await emptyCtx.systemPrompt.assemble()).contexts.map(c => c.name))
      .not.toContain(MCP_HEALTH_CONTEXT_NAME)
  })

  it('reports each missing server (name + fix hint) after the grace period', async () => {
    const ctx = await mount()
    await ctx.plugin(entry, baseConfig(healthConfig([
      { serverName: 'devx-mcp', fixHint: 'python3 ~/.dsh/tools/agentichub-mcp-renew.py' },
      { serverName: 'zeus-devx-database' },
    ])))

    const text = await healthText(ctx)
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"devx-mcp"')
    expect(lines[0]).toContain('python3 ~/.dsh/tools/agentichub-mcp-renew.py')
    expect(lines[1]).toContain('"zeus-devx-database"')
    expect(lines[1]).not.toContain('Fix:')
  })

  it('stays silent while every configured server has registered tools, across plugin fibers', async () => {
    const ctx = await mount()
    // The tool registers from its own plugin fiber — another plugin instance —
    // so this pins that the no-scope registry view enumerates cross-instance
    // registrations (the mcp-client mount shape).
    await mountMcpToolFiber(ctx, 'mcp__devx-mcp__list_apps')
    await mountMcpToolFiber(ctx, 'mcp__zeus-devx-database__list_tables')
    await ctx.plugin(entry, baseConfig(healthConfig([
      { serverName: 'devx-mcp' },
      { serverName: 'zeus-devx-database' },
    ])))

    expect(await healthText(ctx)).toBe('')
  })

  it('stays silent inside the startup grace period even with tools missing', async () => {
    const ctx = await mount()
    await ctx.plugin(entry, baseConfig({
      servers: [{ serverName: 'devx-mcp' }],
      startupGraceSecs: 600,
    }))

    expect(await healthText(ctx)).toBe('')
  })

  it('recovers when a degraded server re-registers its tools', async () => {
    const ctx = await mount()
    await ctx.plugin(entry, baseConfig(healthConfig([{ serverName: 'devx-mcp' }])))
    expect(await healthText(ctx)).toContain('"devx-mcp"')

    const fiber = await mountMcpToolFiber(ctx, 'mcp__devx-mcp__list_apps')
    expect(await healthText(ctx)).toBe('')

    // Unregister (reconnect exhausted) → degraded again; the text is
    // re-evaluated per assembly, so both transitions need no listener.
    await fiber.dispose()
    expect(await healthText(ctx)).toContain('"devx-mcp"')
  })

  it('unregisters the context when the plugin fiber is disposed (HMR safety)', async () => {
    const ctx = await mount()
    const fiber = await ctx.plugin(entry, baseConfig(healthConfig([{ serverName: 'devx-mcp' }])))
    expect((await ctx.systemPrompt.assemble()).contexts.map(c => c.name))
      .toContain(MCP_HEALTH_CONTEXT_NAME)

    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).contexts.map(c => c.name))
      .not.toContain(MCP_HEALTH_CONTEXT_NAME)
  })
})

describe('registry enumeration failure containment', () => {
  /** Capture the context registration a stub context receives. */
  function captureText(config: McpHealthConfig): string {
    let text: ((context: unknown) => string) | undefined
    const stub = {
      systemPrompt: {
        context: (registration: { text: (context: unknown) => string }) => {
          text = registration.text
          return () => {}
        },
      },
      tools: { schemas: () => { throw new Error('registry view failed') } },
      effect: () => () => {},
    } as unknown as CordisContext
    registerMcpHealthContext(stub, config)
    if (text === undefined) throw new Error('context was not registered')
    return text({})
  }

  it('reads as healthy when the registry view throws', () => {
    expect(captureText({ servers: [{ serverName: 'devx-mcp' }], startupGraceSecs: 0 })).toBe('')
  })

  it('applies the default grace when startupGraceSecs is omitted', () => {
    // Within the default 180s grace the throwing registry is never reached;
    // the empty result comes from the grace branch, not the catch.
    expect(captureText({ servers: [{ serverName: 'devx-mcp' }] })).toBe('')
  })

  it('omits the Fix suffix for an empty fixHint', () => {
    let text: ((context: unknown) => string) | undefined
    const stub = {
      systemPrompt: {
        context: (registration: { text: (context: unknown) => string }) => {
          text = registration.text
          return () => {}
        },
      },
      tools: { schemas: () => [] },
      effect: () => () => {},
    } as unknown as CordisContext
    registerMcpHealthContext(stub, { servers: [{ serverName: 'devx-mcp', fixHint: '' }], startupGraceSecs: 0 })
    if (text === undefined) throw new Error('context was not registered')
    expect(text({})).toContain('"devx-mcp"')
    expect(text({})).not.toContain('Fix:')
  })

  it('states the observable fact without asserting tool failure (zero-tool servers)', () => {
    // Registry presence cannot distinguish a dead connection from a server
    // that legitimately exposes no tools (resources/prompts-only): the line
    // must not inject "its tools will fail" as fact into every prompt.
    let text: ((context: unknown) => string) | undefined
    const stub = {
      systemPrompt: {
        context: (registration: { text: (context: unknown) => string }) => {
          text = registration.text
          return () => {}
        },
      },
      tools: { schemas: () => [] },
      effect: () => () => {},
    } as unknown as CordisContext
    registerMcpHealthContext(stub, { servers: [{ serverName: 'devx-mcp' }], startupGraceSecs: 0 })
    if (text === undefined) throw new Error('context was not registered')
    const line = text({})
    expect(line).toContain('"devx-mcp"')
    expect(line).toContain('no tools registered')
    expect(line).not.toContain('will fail')
  })
})

describe('splitMcpToolName (mcp-client naming contract)', () => {
  const cases: Array<[name: string, want: { server: string; raw: string } | undefined]> = [
    ['mcp__zread__search_doc', { server: 'zread', raw: 'search_doc' }],
    // serverName 允许含 _：分隔符是双下划线，单下划线不切散。
    ['mcp__web_search__query', { server: 'web_search', raw: 'query' }],
    // 首 __ 切分：raw 内剩余 __ 保持原样。
    ['mcp__a__b__c', { server: 'a', raw: 'b__c' }],
    // 残缺形态（无分隔 / 空 server）与非 MCP 名都不是 mcp-client 契约名。
    ['mcp__foo', undefined],
    ['mcp___foo', undefined],
    ['mcp__', undefined],
    ['read', undefined],
  ]
  for (const [name, want] of cases) {
    it(`splits ${name}`, () => {
      expect(splitMcpToolName(name)).toEqual(want)
    })
  }
})
