/**
 * Shared fixtures for the M7 plan/reply HTML render specs, ported from the
 * Go engine_plan_render_test.go stubs (renderAgent, keepPreviewFilePlatform,
 * reconstructFilePlatform) plus render-image stubs from
 * engine_render_image_test.go.
 *
 * @module dsh-feishu-bridge/tests-plan-render-helpers
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import type { Agent, AgentSession, Platform, RenderQuerier } from '../../src/core/types.ts'
import { errRenderStalled } from '../../src/engine/plan-render.ts'
import { createStubAgent, createStubMediaPlatform, createStubPlatform } from '../stubs/engine-stubs.ts'

/** One recorded renderQuery invocation (Go renderAgentCall). */
interface RenderAgentCall {
  prompt: string
  provider: string
  systemPrompt: string
  workDir: string
}

export interface RenderAgent extends Agent, RenderQuerier {
  getCalls(): RenderAgentCall[]
  cancelledCount(): number
}

/**
 * Stub Agent that records every renderQuery call (Go renderAgent): lets tests
 * assert the engine forked a render session with the right prompt / provider /
 * env without spawning a real agent. `blockCount` first calls block until the
 * signal aborts (LLM hang), `stallCount` first calls throw errRenderStalled.
 */
export function createRenderAgent(opts: {
  delayMs?: number
  err?: Error
  blockCount?: number
  stallCount?: number
  stallPartial?: boolean
} = {}): RenderAgent {
  const calls: RenderAgentCall[] = []
  let cancelled = 0
  const base = createStubAgent()
  const agent: RenderAgent = {
    ...base,
    name: () => 'render',
    getCalls: () => [...calls],
    cancelledCount: () => cancelled,
    async renderQuery(prompt: string, provider: string, systemPrompt: string, signal?: AbortSignal, workDir?: string): Promise<string> {
      const callIdx = calls.length
      calls.push({ prompt, provider, systemPrompt, workDir: workDir ?? '' })
      const block = (opts.blockCount ?? 0) > 0 && callIdx < (opts.blockCount ?? 0)
      const stall = (opts.stallCount ?? 0) > 0 && callIdx < (opts.stallCount ?? 0)
      if (stall) {
        // Simulate the render session writing a partial body before the stall
        // detector fires (Go stallPartial).
        if (opts.stallPartial === true) {
          const path = htmlPathFromPrompt(prompt)
          if (path !== '') writeFileSync(path, '<div class="wrap"><p>partial</p></div>', 'utf8')
        }
        throw errRenderStalled
      }
      if (block || (opts.delayMs ?? 0) > 0) {
        const aborted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { resolve(false) }, opts.delayMs ?? 86_400_000)
          signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(true) }, { once: true })
        })
        if (aborted) {
          cancelled++
          throw new Error('render query aborted')
        }
      }
      if (opts.err !== undefined) throw opts.err
      // Simulate the real fork: the render session writes only the body
      // fragment to html_path; the engine assembles the full document.
      const path = htmlPathFromPrompt(prompt)
      if (path !== '') writeFileSync(path, '<div class="wrap"><header><h1>stub</h1></header></div>', 'utf8')
      return 'HTML rendered and sent: /tmp/plan.html'
    },
  }
  return agent
}

/** Extract <html_path>…</html_path> from a render prompt (Go htmlPathFromPrompt). */
export function htmlPathFromPrompt(prompt: string): string {
  const open = '<html_path>'
  const close = '</html_path>'
  const i = prompt.indexOf(open)
  if (i < 0) return ''
  const j = prompt.indexOf(close, i)
  if (j < 0) return ''
  return prompt.slice(i + open.length, j)
}

/** A media platform that also records sent cards + uploads (Go stubCardMediaPlatform). */
export interface StubCardMediaPlatform extends ReturnType<typeof createStubMediaPlatform> {
  uploaded: number
  cards: unknown[]
  cardErr?: Error
  uploadImage(img: { fileName?: string }): Promise<string>
  sendCard(replyCtx: unknown, card: unknown): Promise<void>
  replyCard(replyCtx: unknown, card: unknown): Promise<void>
}

export function createCardMediaPlatform(cardErr?: Error): StubCardMediaPlatform {
  const p = createStubMediaPlatform('feishu')
  const stub: StubCardMediaPlatform = {
    ...p,
    uploaded: 0,
    cards: [],
    ...(cardErr !== undefined ? { cardErr } : {}),
    uploadImage: async () => {
      stub.uploaded++
      return 'img_key_stub'
    },
    sendCard: async (_rc, card) => {
      stub.cards.push(card)
      if (stub.cardErr !== undefined) throw stub.cardErr
    },
    replyCard: async (rc, card) => { await stub.sendCard(rc, card) },
  }
  return stub
}

/** A file-sending platform that also reconstructs reply contexts (Go reconstructFilePlatform). */
export interface ReconstructFilePlatform extends ReturnType<typeof createStubMediaPlatform> {
  reconstructCalls: string[]
  reconstructReplyCtx(sessionKey: string): unknown
}

export function createReconstructFilePlatform(): ReconstructFilePlatform {
  const p = createStubMediaPlatform('feishu')
  const stub: ReconstructFilePlatform = {
    ...p,
    reconstructCalls: [],
    reconstructReplyCtx: (sessionKey: string) => {
      stub.reconstructCalls.push(sessionKey)
      return 'rebuilt-ctx'
    },
  }
  return stub
}

/** A platform recording updateCardWithHandle calls (Go stubCardUpdatePlatform). */
export interface StubCardUpdatePlatform extends Platform {
  updated: Array<{ handle: unknown; card: unknown }>
  sendCardWithHandle?(replyCtx: unknown, card: unknown): Promise<unknown>
  updateCardWithHandle(handle: unknown, card: unknown): Promise<void>
}

export function createCardUpdatePlatform(n = 'feishu'): StubCardUpdatePlatform {
  const base = createStubPlatform(n)
  const stub: StubCardUpdatePlatform = {
    ...base,
    updated: [],
    updateCardWithHandle: async (handle, card) => {
      stub.updated.push({ handle, card })
    },
  }
  return stub
}

/** New engine wired with a render-capable agent + enabled plan_render (Go test setup). */
export function newRenderEngine(agent: Agent, platform: Platform, opts: { timeoutMs?: number } = {}): Engine {
  const e = new Engine('test', agent, [platform], '', 'en')
  e.planRenderEnabled = true
  e.planRenderProvider = 'p'
  e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
  if (opts.timeoutMs !== undefined) e.planRenderTimeoutMs = opts.timeoutMs
  return e
}

/**
 * The render skill body exactly as the dsh skill registry loads it:
 * skills/feishu-bridge-render/SKILL.md minus frontmatter, trimmed — the
 * single source the render-session prompts inline.
 */
export function renderSkillBodyFixture(): string {
  const raw = readFileSync(new URL('../../skills/feishu-bridge-render/SKILL.md', import.meta.url), 'utf8')
  const close = raw.indexOf('\n---\n', 3)
  return raw.slice(close + 5).trim()
}

/** A ready interactive state bound to a platform + replyCtx (Go test setup). */
export function newRenderState(platform: Platform, agentSession?: AgentSession): InteractiveState {
  const state = new InteractiveState()
  state.platform = platform
  state.replyCtx = 'ctx-1'
  if (agentSession !== undefined) state.agentSession = agentSession
  return state
}

/** Write an executable shell script and return its path (Go writeRenderTestScript). */
export function writeRenderTestScript(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body, { mode: 0o755 })
  return path
}

/** Fresh temp dir (Go t.TempDir). */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Poll until the predicate holds or the deadline passes (Go deadline loops). */
export async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, intervalMs) })
  }
}
