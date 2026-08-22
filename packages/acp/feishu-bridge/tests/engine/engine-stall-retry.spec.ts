/**
 * REAL-composition stall-retry regression: the engine's idle watchdog kills
 * a stalled agent session and resumes it with 「继续」. The production
 * incident (2026-08-21, chat oc_07627) showed the resumed agent reported as
 * "process exited" the moment its first event arrived: the event loop
 * re-armed its receive promise on the pre-retry session's closed channel.
 * This suite drives the full engine + DshAgentAdapter over a real Cordis
 * runtime with a scripted LLM adapter whose first request hangs mid-stream —
 * the exact incident shape.
 *
 * @module dsh-feishu-bridge/tests-engine-stall-retry
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DshAgentAdapter } from '../../src/agent-dsh/adapter.js'
import { Engine } from '../../src/engine/engine.js'
import { createStubPlatform, type StubPlatform } from '../stubs/engine-stubs.js'

/** One scripted model-call behavior. */
type ScriptEntry =
  | 'hang'
  | { readonly text: string; readonly firstChunkDelayMs: number }

/**
 * Scripted LLM adapter: each model call consumes the next script entry.
 * 'hang' streams one reasoning chunk then waits for the abort signal (a
 * stalled mid-stream request); the object form delays the first chunk (LLM
 * latency on the retry) then completes with the text.
 */
class StallScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('StallScriptAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'partial thinking' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    await new Promise<void>((resolve) => { setTimeout(() => { resolve() }, entry.firstChunkDelayMs) })
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: entry.text },
      { type: 'block-end', index: 0, block: { type: 'text', text: entry.text } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: entry.text.length } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

interface Runtime {
  ctx: Context
  adapter: DshAgentAdapter
  engine: Engine
  platform: StubPlatform & { messages: string[] }
  llm: StallScriptAdapter
}

/** Boot the full dsh runtime + bridge engine with a shrunk idle timeout. */
async function bootRuntime(script: ScriptEntry[]): Promise<Runtime> {
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'fb-stall-persist-'))
  const storeDir = await mkdtemp(join(tmpdir(), 'fb-stall-store-'))
  const sessionStore = join(storeDir, 'sessions.json')
  const llm = new StallScriptAdapter(script)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
  ctx.llm.registerAdapter(['mock'], llm)

  const adapter = new DshAgentAdapter(ctx, {
    agentName: 'dsh',
    cwd: persistenceRoot,
    providers: [{ name: 'mify', provider: 'mock', model: 'mock-model' }],
    activeProvider: 'mify',
  })
  const messages: string[] = []
  const platform = Object.assign(createStubPlatform(), {
    messages,
    async sendPreviewStart(_rc: unknown, content: string): Promise<unknown> {
      messages.push(`start:${content}`)
      return 'preview-handle'
    },
    async updateMessage(_handle: unknown, content: string): Promise<void> {
      messages.push(`update:${content}`)
    },
    async renderStoppedCard(_rc: unknown, id: unknown): Promise<void> {
      messages.push(`stopped:${String(id)}`)
    },
  })
  const engine = new Engine('stall-retry-test', adapter, [platform], sessionStore, 'en')
  engine.setDisplayConfig({ toolProgress: true })
  engine.setEventIdleTimeout(400)
  engine.setStallMaxRetries(3)

  cleanup.push(async () => {
    await engine.stop().catch(() => undefined)
    await ctx.fiber.dispose()
    await rm(persistenceRoot, { recursive: true, force: true })
    await rm(storeDir, { recursive: true, force: true })
  })
  return { ctx, adapter, engine, platform, llm }
}

function receive(engine: Engine, platform: StubPlatform, content: string): void {
  engine.receiveMessage(platform, {
    sessionKey: 'test:ch:user1',
    platform: 'test',
    messageID: '',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content,
    originalContent: content,
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
  })
}

describe('stall retry over the real dsh runtime', () => {
  it('restarts the stalled session and completes the retried turn without an exit notification', async () => {
    const rt = await bootRuntime([
      'hang',
      { text: 'recovered', firstChunkDelayMs: 250 },
    ])

    receive(rt.engine, rt.platform, 'task')
    // The stalled first request hangs; the idle watchdog fires, restarts the
    // agent, and notifies the user — mirroring the production incident.
    await vi.waitFor(() => {
      expect(rt.platform.sent.some(s => s.includes('Agent stalled') || s.includes('无响应超时'))).toBe(true)
    }, { timeout: 5_000 })
    // The retried 「继续」 turn completes and delivers the reply (as a plain
    // send, or on the preview card once toolProgress renders one).
    await vi.waitFor(() => {
      const delivered = rt.platform.sent.some(s => s.includes('recovered'))
        || rt.platform.messages.some(m => m.includes('recovered'))
      expect(delivered).toBe(true)
    }, { timeout: 5_000 })

    // The retry must NOT be reported as an agent exit: the first event of the
    // retried turn once re-armed the loop on the dead pre-retry channel.
    expect(rt.platform.sent.some(s => s.includes('exited unexpectedly') || s.includes('进程意外退出'))).toBe(false)
    const state = rt.engine.interactiveStates.get('test:ch:user1')
    expect(state?.agentSession?.alive()).toBe(true)
  })

  it('exhausts stall retries and kills the session when the retry also stalls', async () => {
    const rt = await bootRuntime(['hang', 'hang', 'hang', 'hang'])

    receive(rt.engine, rt.platform, 'task')
    await vi.waitFor(() => {
      expect(rt.platform.sent.some(s => s.includes('Session terminated') || s.includes('会话已终止'))).toBe(true)
    }, { timeout: 10_000 })

    // One stall notification per retry attempt (1/3, 2/3, 3/3), then the
    // terminal kill — and no spurious exit notification anywhere.
    const stalls = rt.platform.sent.filter(s => s.includes('retrying') || s.includes('正在重试')).length
    expect(stalls).toBe(3)
    expect(rt.platform.sent.some(s => s.includes('exited unexpectedly') || s.includes('进程意外退出'))).toBe(false)
    expect(rt.engine.interactiveStates.has('test:ch:user1')).toBe(false)
  })

  it('retires the stalled card with a failed render and starts a fresh card for the retried turn', { timeout: 15_000 }, async () => {
    const rt = await bootRuntime(['hang', { text: 'recovered', firstChunkDelayMs: 250 }])

    receive(rt.engine, rt.platform, 'task')
    await vi.waitFor(() => {
      const delivered = rt.platform.sent.some(s => s.includes('recovered'))
        || rt.platform.messages.some(m => m.includes('recovered'))
      expect(delivered, `sent=${JSON.stringify(rt.platform.sent)} messages=${JSON.stringify(rt.platform.messages)}`).toBe(true)
    }, { timeout: 10_000 })

    const messages = rt.platform.messages
    const failedIdx = messages.findIndex(m => m.includes('__cc_state__:failed'))
    expect(failedIdx, `messages=${JSON.stringify(messages)}`).toBeGreaterThanOrEqual(0)
    // The fresh card for the resumed turn starts after the failed one.
    const startsAfter = messages.slice(failedIdx + 1).filter(m => m.startsWith('start:'))
    expect(startsAfter, `messages=${JSON.stringify(messages)}`).not.toEqual([])
  })

  it('fails the preview card when stall retries are exhausted', async () => {
    const rt = await bootRuntime(['hang', 'hang', 'hang', 'hang'])

    receive(rt.engine, rt.platform, 'task')
    await vi.waitFor(() => {
      expect(rt.platform.sent.some(s => s.includes('Session terminated') || s.includes('会话已终止'))).toBe(true)
    }, { timeout: 10_000 })
    await vi.waitFor(() => {
      expect(rt.platform.messages.some(m => m.includes('__cc_state__:failed'))).toBe(true)
    }, { timeout: 2_000 })
  })
})
