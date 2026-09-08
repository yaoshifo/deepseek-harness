/**
 * REAL-composition coverage for the model-switch notice: a hot provider
 * switch resumes the same session on a different route, and the next model
 * request must tell the new model that earlier assistant turns came from
 * another model (upstream `installModelSelection`, wired into the adapter's
 * session setup chain).
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-model-switch-notice
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import { buildProjectAssembly, type FeishuBridgeConfig, type ProjectConfig } from '../../src/index.ts'
import type { DshAgentSession } from '../../src/agent-dsh/adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('model-switch notice (REAL composition)', () => {
  it('appends the model-change notice to the first request after a hot route switch', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-model-switch-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    // Both bridge routes share the scripted LLM provider; only the model id
    // differs, which is exactly what the notice compares.
    const config: FeishuBridgeConfig = {
      providers: {
        routeA: { route: 'mock', model: 'model-a' },
        routeB: { route: 'mock', model: 'model-b' },
      },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'ms-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    const llm = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
    ctx.llm.registerAdapter(['mock'], llm)

    const key = 'test:ms-chat:u1'
    adapter.setActiveProvider('routeA')
    const first = (await adapter.startSession('', { sessionKey: key })) as DshAgentSession
    await first.send('first question', [], [])
    await vi.waitFor(() => { expect(first.lastAssistantText()).toBe('first answer') })
    expect(JSON.stringify(llm.requests[0]?.messages)).not.toContain('[model changed:')

    // Hot switch (the /provider switch --resume shape): keep the session id,
    // drop the live agent, pin the session to route B, resume on next send.
    const sessionId = first.currentSessionID()
    await first.close()
    adapter.setSessionProvider(key, 'routeB')
    const resumed = (await adapter.startSession(sessionId, { sessionKey: key })) as DshAgentSession
    await resumed.send('second question', [], [])
    await vi.waitFor(() => { expect(resumed.lastAssistantText()).toBe('second answer') })

    const second = llm.requests[1]
    expect(second).toBeDefined()
    expect(JSON.stringify(second?.messages)).toContain('[model changed:')
    expect(JSON.stringify(second?.messages)).toContain('model-a')
    expect(JSON.stringify(second?.messages)).toContain('model-b')
  }, 30_000)
  it('does not append a notice when the resume keeps the same route', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-model-switch-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    const config: FeishuBridgeConfig = {
      providers: {
        routeA: { route: 'mock', model: 'model-a' },
        routeB: { route: 'mock', model: 'model-b' },
      },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'ms-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    const llm = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
    ctx.llm.registerAdapter(['mock'], llm)

    const key = 'test:ms-same:u1'
    adapter.setActiveProvider('routeA')
    const first = (await adapter.startSession('', { sessionKey: key })) as DshAgentSession
    await first.send('first question', [], [])
    await vi.waitFor(() => { expect(first.lastAssistantText()).toBe('first answer') })

    const sessionId = first.currentSessionID()
    await first.close()
    const resumed = (await adapter.startSession(sessionId, { sessionKey: key })) as DshAgentSession
    await resumed.send('second question', [], [])
    await vi.waitFor(() => { expect(resumed.lastAssistantText()).toBe('second answer') })

    expect(JSON.stringify(llm.requests[1]?.messages)).not.toContain('[model changed:')
  }, 30_000)

  it('keeps a project-level effort across a route switch (effort rides every route)', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-model-switch-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    const config: FeishuBridgeConfig = {
      providers: {
        routeA: { route: 'mock', model: 'model-a' },
        routeB: { route: 'mock', model: 'model-b' },
      },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'ms-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
      // The project-level effort rides every route, so a switch between
      // routes must keep it on the new model's requests.
      agent: { reasoningEffort: 'high' },
    }
    const { adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    // The mock model must declare its reasoning efforts, or the runtime
    // rejects the effort-stamped request before it ever reaches the adapter.
    const llm = new MockAdapter(
      [textResponse('first answer'), textResponse('second answer')],
      { efforts: [{ id: ReasoningEffortId('high'), name: 'high' }], defaultEffort: ReasoningEffortId('high') },
    )
    ctx.llm.registerAdapter(['mock'], llm)

    const key = 'test:ms-effort:u1'
    adapter.setActiveProvider('routeA')
    const first = (await adapter.startSession('', { sessionKey: key })) as DshAgentSession
    await first.send('first question', [], [])
    await vi.waitFor(() => { expect(first.lastAssistantText()).toBe('first answer') }, { timeout: 10_000 })
    expect(llm.requests[0]?.reasoningEffort).toBe('high')

    const sessionId = first.currentSessionID()
    await first.close()
    adapter.setSessionProvider(key, 'routeB')
    const resumed = (await adapter.startSession(sessionId, { sessionKey: key })) as DshAgentSession
    await resumed.send('second question', [], [])
    await vi.waitFor(() => { expect(resumed.lastAssistantText()).toBe('second answer') })

    expect(llm.requests[1]?.reasoningEffort).toBe('high')
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain('[model changed:')
  }, 30_000)
})
