/**
 * The real pending-inbox reader: queued inbox input that died with a daemon
 * CRASH survives in the session log (a graceful shutdown cancels it), and a
 * fresh composition over the same persistence root cold-reads the pending
 * count from the inbox projection.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-pending-inbox-reader
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TestSessionQuery } from '../../../../subagent/subagent/tests/test-session-query.ts'
import { createPendingInboxReader } from '../../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Adapter that holds the first stream open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  entered = false

  private readonly gate = Promise.withResolvers<undefined>()

  release(): void {
    this.gate.resolve(undefined)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.entered = true
    // Abortable hang: fiber disposal cancels the turn, ending the stream.
    await Promise.race([
      this.gate.promise,
      new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve(undefined)
        else options.signal?.addEventListener('abort', () => { resolve(undefined) }, { once: true })
      }),
    ])
    if (options.signal?.aborted) throw new Error('aborted')
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function user(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('pending-inbox reader (REAL cold read)', () => {
  it('counts restart-surviving queued input from a fresh composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-inbox-reader-'))
    roots.push(root)
    const adapter = new GatedAdapter()

    // First process: a running turn with a queued steer behind it, then the
    // process dies (fiber dispose) with the input still pending.
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('reader-agent'), { provider: 'mock', model: 'm' })
    agent.followup(user('first question'))
    await vi.waitFor(() => { expect(adapter.entered).toBe(true) })
    agent.steer(user('queued while busy'))
    await ctx.sessions.flush(agent.session)
    // The process dies WITHOUT unwinding (crash, not a graceful dispose —
    // graceful disposal cancels pending input with outcome "canceled"). The
    // afterAll fiber dispose happens after the assertions below.

    // Second process: a fresh composition over the same root cold-reads the
    // pending count through the inbox projection.
    const ctx2 = new Context()
    contexts.push(ctx2)
    await mountAgentLoopTestDependencies(ctx2)
    await ctx2.plugin(JsonlSessionPersistence, { root })
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(TestSessionQuery)
    const reader = createPendingInboxReader(ctx2)
    await expect(reader.pendingCount('reader-agent')).resolves.toBe(1)
    await expect(reader.pendingCount('never-persisted')).resolves.toBe(0)
  }, 30_000)
})
