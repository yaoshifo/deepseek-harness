import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentsRegistryLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'

// REAL-composition tripwires for the adapter's structurally-typed service
// seams (`ctx.get(...) as Dsh…Like`): the local interfaces and the unit-test
// fakes cannot see an upstream API removal, which is exactly how the
// userQuestions registerProvider break (2026-08-29 oc_cd00410d) reached
// production with green CI. Each case here drives one seam against the real
// upstream service, so an upstream rename fails this file before a rebuild
// ships it.

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

/** Fake registry agent whose session is a REAL durable dsh session. */
interface RealSessionAgent {
  readonly id: string
  readonly session: Session
  readonly status: 'idle' | 'running'
  followups: unknown[]
  steers: unknown[]
  disposed: boolean
  followup(message: unknown): void
  steer(message: unknown): void
  cancel(cause: { kind: string }): void
  inject(message: unknown): void
  emit(): void
}

/** One closed turn, so folding and plan-mode commit see live structure. */
function appendClosedTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** Real service tree plus an adapter whose registry hands out real sessions. */
async function seamHarness(): Promise<{
  ctx: Context
  adapter: DshAgentAdapter
  agents: RealSessionAgent[]
  persisted: Session
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const root = await mkdtemp(join(tmpdir(), 'fb-seams-'))
  roots.push(root)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  // PlanModeController injects tools + systemPrompt; without both the plugin
  // stays pending and its service never registers.
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(PlanModeController, { section: 'guidance' })
  await ctx.plugin(SessionProjectionRegistry)
  const cwd = '/workspace/project'
  const agents: RealSessionAgent[] = []
  const registry: DshAgentsRegistryLike = {
    create: async () => {
      const session = ctx.sessions.create(undefined, { meta: { cwd } })
      const agent: RealSessionAgent = {
        id: String(session.id),
        session,
        followups: [],
        steers: [],
        disposed: false,
        followup(message: unknown): void {
          agent.followups.push(message)
        },
        steer(message: unknown): void {
          agent.steers.push(message)
        },
        cancel(): void {},
        inject(): void {},
        emit(): void {},
        status: 'idle',
      }
      agents.push(agent)
      const handle: DshAgentHandleLike = {
        agent,
        dispose: async () => { agent.disposed = true },
      }
      return handle
    },
    resume: async () => { throw new Error('resume not used') },
    get: (id: unknown) => agents.find(a => a.id === String(id) && !a.disposed),
  }
  const adapterCtx: DshContextLike = {
    agents: registry,
    on: (event, listener) => ctx.on(event as never, listener as never),
    get: name => ctx.get(name) as unknown,
  }
  const adapter = new DshAgentAdapter(adapterCtx, {
    agentName: 'dsh',
    cwd,
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
    activeProvider: 'glm',
  })
  // A second durable session the adapter must reach only through
  // persistence (never live, never in ctx.agents).
  const persisted = ctx.sessions.create(undefined, { meta: { cwd } })
  appendClosedTurn(persisted)
  await ctx.sessions.flush(persisted)
  return { ctx, adapter, agents, persisted }
}

describe('DshAgentAdapter service seams against real upstream services', () => {
  it('startSession applies plan mode through the real planMode controller', async () => {
    const { adapter, agents } = await seamHarness()
    adapter.setDefaultMode('plan')
    await adapter.startSession('')
    // The controller committed a plan/mode event onto the real session.
    expect(agents[0]!.session.events.some(e => e.type === 'plan/mode')).toBe(true)
  })

  it('contextSnapshot reads the real sessionProjections registry', async () => {
    const { ctx, adapter, agents } = await seamHarness()
    await adapter.startSession('')
    const agent = agents[0]!
    ctx.agents.enter(agent as unknown as Agent, undefined)
    expect(adapter.contextSnapshot(agent.id)).toBeDefined()
  })

  it('listSessions and recentTurns read the real jsonl persistence', async () => {
    const { adapter, persisted } = await seamHarness()
    const listed = await adapter.listSessions()
    expect(listed.find(s => s.id === String(persisted.id))).toBeDefined()
    const turns = await adapter.recentTurns(String(persisted.id), 10)
    // The success path folds the persisted turn; an inspect API break is
    // swallowed to [] by recentTurns, so a non-empty fold is the tripwire.
    expect(turns.length).toBeGreaterThan(0)
  })
})
