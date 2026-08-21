import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function harness(adapter: MockAdapter): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-stall-retry-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function finalAssistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * The feishu-bridge stall-retry sequence at dsh level: a turn whose model
 * stream hangs mid-flight, the owning handle disposed (the bridge kills the
 * stalled session), and an immediate resume of the same session id that must
 * survive the old agent's teardown and complete its own turn.
 */
describe('stall-retry dispose-then-resume', () => {
  it('completes the resumed turn after a mid-turn dispose of the hung agent', async () => {
    const adapter = new MockAdapter(['hang-slow', textResponse('recovered')])
    const ctx = await harness(adapter)
    const sessionId = SessionId('cc-stall-retry')

    const first = await ctx.agents.create({
      sessionId,
      meta: { cwd: '/w' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    followup(first.agent, 'task')
    // Wait until the hung request is the adapter's in-flight one.
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    await first.dispose()
    expect(ctx.agents.get(sessionId)).toBeUndefined()

    const second = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const idle = waitForIdle(ctx, second.agent)
    followup(second.agent, '继续')
    await idle

    expect(finalAssistantText(second.agent)).toBe('recovered')
    expect(ctx.agents.get(sessionId)).toBe(second.agent)
  })
})
