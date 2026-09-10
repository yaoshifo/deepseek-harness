/**
 * The real native-catalog reader: `subagent/catalog` facts a parent session
 * logged before a daemon restart survive in the session log, and a fresh
 * composition over the same persistence root cold-reads the direct-child
 * list through the subagentCatalog projection. The reader feeds restart
 * reconciliation, so unknown or unreadable sessions resolve to an empty
 * list instead of throwing.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-native-catalog-reader
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TestSessionQuery } from '../../../../subagent/subagent/tests/test-session-query.ts'
import { createNativeCatalogReader } from '../../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('native-catalog reader (REAL cold read)', () => {
  it('lists direct children a parent session logged before the restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-catalog-reader-'))
    roots.push(root)

    // First process: one parent session with two logged creation facts.
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('parent-agent'), { provider: 'mock', model: 'm' })
    agent.session.append('subagent/catalog', {
      version: 0,
      childId: 'child-continuable-1',
      childCreatedAt: 100,
      mode: 'continuable',
      label: 'research the seam',
    })
    agent.session.append('subagent/catalog', {
      version: 0,
      childId: 'child-oneshot-1',
      childCreatedAt: 200,
      mode: 'one-shot',
    })
    await ctx.sessions.flush(agent.session)

    // Second process: a fresh composition over the same root cold-reads the
    // catalog through the subagentCatalog projection.
    const ctx2 = new Context()
    contexts.push(ctx2)
    await mountAgentLoopTestDependencies(ctx2)
    await ctx2.plugin(JsonlSessionPersistence, { root })
    await ctx2.plugin(TestSessionQuery)
    const reader = createNativeCatalogReader(ctx2)
    await expect(reader.children('parent-agent')).resolves.toEqual([
      { id: 'child-continuable-1', createdAt: 100, mode: 'continuable', label: 'research the seam' },
      { id: 'child-oneshot-1', createdAt: 200, mode: 'one-shot' },
    ])
    await expect(reader.children('never-persisted')).resolves.toEqual([])
  }, 30_000)
})
