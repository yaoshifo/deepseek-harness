/**
 * MCP health + real mcp-client composition: pins the production shapes end
 * to end with NO mocks — a real `mcp-client` plugin instance connected to
 * the real stdio fixture MCP server (dsh-mcp-client's own fixture) registers
 * `mcp__devx-mcp__*` tools from its own plugin fiber, and the
 * `feishu-bridge:mcp-health` context text must read healthy while they are
 * registered and degraded when the connection fails with
 * `failOnStartupError: false` (the token-expiry path: the server is
 * unreachable, nothing registers, no error surfaces anywhere else).
 *
 * @module dsh-feishu-bridge/tests-mcp-health-mcp-client
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { apply as applyMcpClient } from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as entry from '../src/index.ts'
import { MCP_HEALTH_CONTEXT_NAME } from '../src/core/mcp-health.ts'

// dsh-mcp-client's own stdio fixture server (registers add/greet/fail/image).
const fixtureServerPath = fileURLToPath(new URL('../../../../packages/mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

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
  return ctx
}

function mcpClientConfig(command: string, args: string[]): McpClientConfig {
  return {
    transport: 'stdio',
    serverName: 'devx-mcp',
    command,
    args,
    env: {},
    cwd: dirname(fixtureServerPath),
    toolCallTimeoutMs: 15_000,
    failOnStartupError: false,
  }
}

// entry.apply's first statement awaits its service install and the
// mcp-health context registration runs after that boundary; awaiting the
// full apply keeps assemble from racing the registration.
async function applyBridge(ctx: CordisContext): Promise<void> {
  await entry.apply(ctx, {
    projects: [],
    providers: {},
    dataDir: mkdtempSync(join(tmpdir(), 'fb-mcp-health-mcp-')),
    mcpHealth: { servers: [{ serverName: 'devx-mcp', fixHint: 'python3 ~/.dsh/tools/agentichub-mcp-renew.py' }], startupGraceSecs: 0 },
  })
}

async function healthText(ctx: CordisContext): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble()
  return assembly.contexts.find(context => context.name === MCP_HEALTH_CONTEXT_NAME)?.text ?? ''
}

describe('mcpHealth against a real mcp-client instance', () => {
  it('reads healthy while the connected server has registered its tools', async () => {
    const ctx = await mount()
    await applyMcpClient(ctx, mcpClientConfig(process.execPath, [fixtureServerPath]))
    expect(ctx.tools.get('mcp__devx-mcp__add')).toBeDefined()

    await applyBridge(ctx)
    expect(await healthText(ctx)).toBe('')
  }, 30_000)

  it('reports the server degraded when the connection fails and no tools register', async () => {
    const ctx = await mount()
    // A command that exits immediately: the stdio transport never connects
    // (the shape of an expired gateway token — every connect attempt fails).
    await applyMcpClient(ctx, mcpClientConfig('/usr/bin/false', []))
    expect(ctx.tools.get('mcp__devx-mcp__add')).toBeUndefined()

    await applyBridge(ctx)
    const text = await healthText(ctx)
    expect(text).toContain('"devx-mcp"')
    expect(text).toContain('python3 ~/.dsh/tools/agentichub-mcp-renew.py')
  }, 30_000)
})
