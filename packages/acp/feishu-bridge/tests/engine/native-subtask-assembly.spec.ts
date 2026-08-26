/**
 * REAL-composition test for the native continuable subtask path (de-baggage
 * B4): a real Cordis Context boots the real agent stack (AgentLoop, session
 * persistence, SubagentRuntime mounted with external settlement, the
 * in-process spawn provider) plus the bridge's own buildProjectAssembly; only
 * the LLM is a scripted mock adapter and the platform is a recording stub —
 * the two external surfaces. The full chain runs: parent session up →
 * spawnSubtaskNative → the child's real turn → subagent/end → the settlement
 * listener → the report card + `[子任务完成]` wake opening the parent's next
 * real turn.
 *
 * @module dsh-feishu-bridge/tests-native-subtask-assembly
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import { buildProjectAssembly, registerNativeSettlementListener, type FeishuBridgeConfig, type ProjectConfig } from '../../src/index.js'
import { InteractiveState } from '../../src/engine/engine.js'
import { WorktreeMode } from '../../src/engine/worktree.js'
import { createStubCardPlatformFull, newStubMessage, type RecordedCard } from '../stubs/engine-stubs.js'
import type { ProgressContent, TextPreviewContent } from '../../src/core/types.js'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

/** The markdown body of a recorded card. */
function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

describe('native subtask REAL composition (buildProjectAssembly + SubagentRuntime external settlement)', () => {
  it('runs spawn → child turn → settlement → report card and parent wake end to end', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-native-assembly-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { settlementNotice: 'external' })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    // The bridge's adapter consumes the structural ctx slice only.
    const config: FeishuBridgeConfig = {
      providers: { mock: { route: 'mock', model: 'mock' } },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'native-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    // Only the external Feishu surface is stubbed: swap the platform list.
    const p = createStubCardPlatformFull('test')
    engine.platforms.splice(0, engine.platforms.length, p)
    registerNativeSettlementListener(ctx, [{ engine }])
    // Register the scripted LLM route the provider config names: the child's
    // turn is the first request, the parent's wake turn the second.
    const adapter2 = new MockAdapter([
      // Child's first (and only) turn: its answer becomes the settlement payload.
      textResponse('child answer'),
      // Parent's wake turn: synthesizes the child result.
      textResponse('parent synthesized'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter2)

    // Parent session up (the engine's normal path creates this on the first
    // message; here the wake message itself is the first turn input).
    const parentKey = 'test:parent-chat:u1'

    const agentSession = await adapter.startSession('', { sessionKey: parentKey })
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'parent-rctx'
    engine.interactiveStates.set(parentKey, state)

    // The delegating parent must be live in ctx.agents for native authority.
    const parentNativeID = agentSession.currentSessionID()
    expect(parentNativeID).not.toBe('')

    const { childKey } = await engine.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'render the summary')
    expect(childKey).not.toBe('')
    const entry = engine.nativeChildEntries()[childKey]
    expect(entry?.parent_key).toBe(parentKey)
    expect(entry?.reported).toBe(false)

    // The child's epoch settles → subagent/end → settlement listener → the
    // report card lands in the parent chat and the [子任务完成] wake opens
    // the parent's turn, whose reply the stub platform records.
    await vi.waitFor(() => {
      expect(engine.nativeChildEntries()[childKey]?.reported).toBe(true)
    }, { timeout: 20_000 })
    await vi.waitFor(() => {
      expect(p.sentCards.length).toBeGreaterThanOrEqual(1)
    }, { timeout: 20_000 })
    expect(p.sentCards.map(cardBody).join('\n')).toContain('child answer')
    await vi.waitFor(() => {
      expect(p.getSent().join('\n')).toContain('parent synthesized')
    }, { timeout: 20_000 })
  })

  it('features.subtaskQuiet settles without a card but still wakes the parent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-native-assembly-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { settlementNotice: 'external' })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const config: FeishuBridgeConfig = {
      providers: { mock: { route: 'mock', model: 'mock' } },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'native-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    const p = createStubCardPlatformFull('test')
    engine.platforms.splice(0, engine.platforms.length, p)
    registerNativeSettlementListener(ctx, [{ engine }])
    const adapter2 = new MockAdapter([
      textResponse('quiet child answer'),
      textResponse('quiet parent synthesized'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter2)

    const parentKey = 'test:parent-chat:u1'
    const agentSession = await adapter.startSession('', { sessionKey: parentKey })
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'parent-rctx'
    engine.interactiveStates.set(parentKey, state)
    engine.setSubtaskQuiet(true)

    const { childKey } = await engine.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'render quietly')

    await vi.waitFor(() => {
      expect(engine.nativeChildEntries()[childKey]?.reported).toBe(true)
    }, { timeout: 20_000 })
    // Quiet: no settlement card ever lands in the parent chat…
    expect(p.sentCards.length).toBe(0)
    // …but the [子任务完成] wake still opens the parent's real turn.
    await vi.waitFor(() => {
      expect(p.getSent().join('\n')).toContain('quiet parent synthesized')
    }, { timeout: 20_000 })
  })

  it('a parent turn settling mid-child carries the running-children count on the card', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-native-assembly-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { settlementNotice: 'external' })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const config: FeishuBridgeConfig = {
      providers: { mock: { route: 'mock', model: 'mock' } },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'native-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    // Preview-recording platform: the only stub, same as the sibling cases.
    const base = createStubCardPlatformFull('test')
    const contents: ProgressContent[] = []
    const p = Object.assign(base, {
      contents,
      async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
        contents.push(content)
        return 'preview-handle'
      },
      async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
        contents.push(content)
      },
    })
    engine.platforms.splice(0, engine.platforms.length, p)
    registerNativeSettlementListener(ctx, [{ engine }])
    engine.setDisplayConfig({ toolProgress: true })
    // Script: #1 is the spawned child's turn — it hangs mid-stream, so the
    // child stays unreported; #2 settles the parent's foreground turn while
    // the child runs (the sibling cases pin the same child-first ordering).
    const adapter2 = new MockAdapter(['hang', textResponse('parent interim note')])
    ctx.llm.registerAdapter(['mock'], adapter2)

    const parentKey = 'test:parent-chat:u1'
    const agentSession = await adapter.startSession('', { sessionKey: parentKey })
    // Record the live agent session on the session entry so the message path
    // reuses this state instead of recycling into a fresh start.
    engine.sessions.getOrCreateActive(parentKey).setAgentSessionID(agentSession.currentSessionID(), 'test')
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'parent-rctx'
    engine.interactiveStates.set(parentKey, state)

    await engine.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'slow review')
    engine.receiveMessage(p, {
      ...newStubMessage(),
      sessionKey: parentKey,
      platform: p.name(),
      userID: 'u1',
      content: '看下进展',
      replyCtx: 'parent-rctx',
    })

    // The message pump is fire-and-forget; wait for the settled card.
    await vi.waitFor(() => {
      expect(contents.some(c => c.kind === 'text' && c.status?.state === 'completed')).toBe(true)
    }, { timeout: 20_000 })
    const terminal = [...contents].reverse()
      .find(c => c.kind === 'text' && c.status?.state === 'completed') as TextPreviewContent | undefined
    expect(terminal?.status?.pendingSubtasks).toBe(1)
    // buildProjectAssembly engines run zh; the unit cases pin the en wording.
    expect(terminal?.text).toContain('1 个子任务后台运行中')
  })

  it('a blocking gather resolves in-turn with the combined summary, no card, no wake turn', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-native-assembly-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { settlementNotice: 'external' })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const config: FeishuBridgeConfig = {
      providers: { mock: { route: 'mock', model: 'mock' } },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'native-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    const p = createStubCardPlatformFull('test')
    engine.platforms.splice(0, engine.platforms.length, p)
    registerNativeSettlementListener(ctx, [{ engine }])
    // One script entry: the child's turn. A wake turn would consume a second
    // entry; its absence proves the summary landed as the tool result instead.
    const adapter2 = new MockAdapter([textResponse('gather child answer')])
    ctx.llm.registerAdapter(['mock'], adapter2)

    const parentKey = 'test:parent-chat:u1'
    const agentSession = await adapter.startSession('', { sessionKey: parentKey })
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'parent-rctx'
    engine.interactiveStates.set(parentKey, state)

    const { childKey } = await engine.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'gather task')
    // Arm immediately after spawn returns (before the child's turn can
    // settle) so the barrier sees the child as expected.
    const gathered = engine.gatherSubtasksBlocking(parentKey)
    expect(engine.sessions.getOrCreateActive(parentKey).getPendingSubtaskGather()?.expected.size).toBe(1)

    const summary = await gathered
    expect(summary).toContain('gather child answer')
    expect(engine.nativeChildEntries()[childKey]?.reported).toBe(true)
    // The waiter held the turn open: no per-child settlement card posted…
    expect(p.sentCards.length).toBe(0)
    // …and exactly one LLM request ran (the child's) — no wake turn opened.
    expect(adapter2.requests).toHaveLength(1)
    expect(engine.sessions.getOrCreateActive(parentKey).getGatherWaiter()).toBeUndefined()
  })

  it('a max-tokens child settles through the blocking gather with failure semantics', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const root = await mkdtemp(join(tmpdir(), 'fb-native-assembly-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime, { settlementNotice: 'external' })
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const config: FeishuBridgeConfig = {
      providers: { mock: { route: 'mock', model: 'mock' } },
      projects: [],
    }
    const project: ProjectConfig = {
      name: 'native-project',
      workdir: root,
      feishu: { appId: 'cli_test', appSecret: 'sec' },
    }
    const { engine, adapter } = buildProjectAssembly(ctx, config, project, join(root, 'data'))
    const p = createStubCardPlatformFull('test')
    engine.platforms.splice(0, engine.platforms.length, p)
    registerNativeSettlementListener(ctx, [{ engine }])
    const adapter2 = new MockAdapter([maxTokensResponse('truncated work')])
    ctx.llm.registerAdapter(['mock'], adapter2)

    const parentKey = 'test:parent-chat:u1'
    const agentSession = await adapter.startSession('', { sessionKey: parentKey })
    const state = new InteractiveState()
    state.agentSession = agentSession
    state.platform = p
    state.replyCtx = 'parent-rctx'
    engine.interactiveStates.set(parentKey, state)

    const { childKey } = await engine.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'ceiling task')
    const gathered = engine.gatherSubtasksBlocking(parentKey)

    const summary = await gathered
    // The failure prefix marks the child as unfinished while keeping its
    // partial output (this engine runs en; the unit cases pin the vocabulary).
    expect(summary).toContain('ran out of output room')
    expect(summary).toContain('truncated work')
    expect(engine.nativeChildEntries()[childKey]?.reported).toBe(true)
    expect(p.sentCards.length).toBe(0)
  })
})
