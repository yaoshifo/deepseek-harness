/**
 * M7 render-session fork tests, ported from cc-connect
 * core/engine_plan_render_test.go: renderPlanToHTML / renderReplyToHTML prompt
 * + env contracts, failure swallowing, timeout honoring, ASCII temp write
 * path, sibling artifact copy, reply-ctx reconstruction, single-flight,
 * stall/timeout retry, cancel semantics, and the event-loop integration
 * (pre-render auto-deliver, ExitPlanMode reply-render skip, plan stall retry).
 *
 * @module dsh-feishu-bridge/tests-engine-plan-render-fork
 */

import { describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { ProjectStateStore } from '../../src/engine/project-state.ts'
import {
  deliverReplyHTML,
  getRenderStatus,
  launchPlanRender,
  renderAndDeliverReply,
  renderPlanToHTML,
  renderReplyToHTML,
  renderReplySummaryPrompt,
  renderSessionPrompt,
  slugifyTitle,
  shouldRenderPlan,
} from '../../src/engine/plan-render.ts'
import {
  createStubAgent,
  createStubMediaPlatform,
  createStubPlatform,
  newControllableSession,
} from '../stubs/engine-stubs.ts'
import {
  createReconstructFilePlatform,
  createRenderAgent,
  htmlPathFromPrompt,
  newRenderEngine,
  newRenderState,
  pollUntil,
  renderSkillBodyFixture,
  tempDir,
  writeRenderTestScript,
} from './plan-render-helpers.ts'
import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ctxBridgeDispatch } from '../../src/bridge-service.ts'
import type { Session } from '../../src/engine/session.ts'

// Policy-listener contexts are disposed after each test.
const contextsForDispose: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contextsForDispose.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The raw chatroom section of a session (opaque bag; written directly here). */
function chatroomSection(session: Session): Record<string, unknown> {
  let section = session.featureState.chatroom
  if (typeof section !== 'object' || section === null) {
    section = {}
    session.featureState.chatroom = section
  }
  return section as Record<string, unknown>
}

describe('RenderPlanToHTML', () => {
  it('NoCrosstalk: each fork receives exactly its own prompt', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    e.planRenderProvider = 'p'

    await renderPlanToHTML(e, 'sessA', '# plan A', '/tmp/a.md', 1)
    await renderPlanToHTML(e, 'sessB', '# plan B', '/tmp/b.md', 1)

    const calls = a.getCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.prompt).toContain('plan A')
    expect(calls[1]!.prompt).toContain('plan B')
    expect(calls[0]!.prompt).not.toContain('plan B')
    // Prompt carries the RAW plan markdown + html_path tag — never the reply
    // sub-type's SimpleHTML fragment wrapper.
    expect(calls[0]!.prompt).toContain('<plan-markdown>')
    expect(calls[0]!.prompt).toContain('<html_path>')
    expect(calls[0]!.prompt).toContain('plan A')
    expect(calls[0]!.prompt).not.toContain('<plan-rendered-html>')
    expect(calls[0]!.systemPrompt).toBe(renderSessionPrompt(renderSkillBodyFixture()))
  })

  it('FailureSwallowed: a failing fork never propagates', async () => {
    const a = createRenderAgent({ err: new Error('boom') })
    const e = newRenderEngine(a, createStubMediaPlatform())
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1)
    expect(a.getCalls()).toHaveLength(1)
  })

  it('TimeoutHonored: an aborted signal cuts the fork short', async () => {
    const a = createRenderAgent({ delayMs: 300 })
    const e = newRenderEngine(a, createStubMediaPlatform())
    const ctl = new AbortController()
    setTimeout(() => { ctl.abort() }, 50)
    const start = Date.now()
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1, ctl.signal)
    expect(Date.now() - start).toBeLessThan(250)
  })

  it('PromptUsesAsciiTempPath: the write path is a cc-plan-render-* temp dir without the CJK title', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    const title = '提高 distill_add job 优先级，触发蒸馏重跑'
    const planFilePath = join(tempDir('plan-ascii-'), 'foo.md')
    await renderPlanToHTML(e, 'feishu_oc_abc123', `# ${title}`, planFilePath, 1)

    const calls = a.getCalls()
    expect(calls).toHaveLength(1)
    const hp = htmlPathFromPrompt(calls[0]!.prompt)
    expect(hp).not.toBe('')
    expect(hp.split('/').slice(-2)[0]).toContain('cc-plan-render-')
    expect(hp.includes(title)).toBe(false)
  })

  it('CopiesToSiblingArtifact: the assembled HTML lands next to the plan .md', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    const planDir = tempDir('plan-sibling-')
    const planFilePath = join(planDir, 'foo.md')
    const title = '修复告警'
    await renderPlanToHTML(e, 'feishu_oc_abc', `# ${title}`, planFilePath, 1)

    const sibling = join(planDir, `${slugifyTitle(title, '')}.html`)
    expect(existsSync(sibling)).toBe(true)
    expect(statSync(sibling).size).toBeGreaterThan(0)
  })

  it('DirOverrideWorkDir: the render fork runs in the chat\'s workDir', async () => {
    // The render fork must run in the chat's own directory context — the
    // /dir override when one exists, not the project base.
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    const store = new ProjectStateStore(join(tempDir('plan-dirstate-'), 'state.json'))
    store.setWorkspaceDirOverride(e.dirOverrideKey('feishu_oc_abc'), '/workspace/chat-override')
    e.setProjectStateStore(store)

    await renderPlanToHTML(e, 'feishu_oc_abc', '# plan', join(tempDir('plan-dir-'), 'foo.md'), 1)

    expect(a.getCalls()).toHaveLength(1)
    expect(a.getCalls()[0]!.workDir).toBe('/workspace/chat-override')
  })

  it('AgentNotRenderQuerier: an agent without renderQuery is a silent no-op', async () => {
    const e = new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
    e.planRenderProvider = 'p'
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1)
  })

  it('NoProviderSkips: an unresolved provider skips the fork entirely', async () => {
    const a = createRenderAgent()
    const e = new Engine('test', a, [createStubMediaPlatform()], '', 'en') // no provider configured
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1)
    expect(a.getCalls()).toHaveLength(0)
  })
})

describe('RenderForks_RequireRegisteredSkill', () => {
  it('rejects with registration guidance and never forks when the skill source is unwired', async () => {
    const a = createRenderAgent()
    const e = new Engine('test', a, [createStubMediaPlatform()], '', 'en')
    e.planRenderProvider = 'p'

    await expect(renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1)).rejects.toThrow(/feishu-bridge-render/)
    await expect(renderReplyToHTML(e, 'sess', 'reply body')).rejects.toThrow(/feishu-bridge-render/)
    expect(a.getCalls()).toHaveLength(0)
  })

  it('resolves the body through the engine skill source at fork time', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    let resolves = 0
    e.planRenderSkillSource = () => {
      resolves++
      return Promise.resolve(renderSkillBodyFixture())
    }

    await renderReplyToHTML(e, 'sess', 'reply body')

    expect(resolves).toBe(1)
    expect(a.getCalls()[0]!.systemPrompt).toContain(renderSkillBodyFixture())
  })
})

describe('RenderReplyToHTML', () => {
  it('UsesReplyPrompt: reply prompt, provider, SimpleHTML fragment', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())

    await renderReplyToHTML(e, 'sess', 'the agent reply body')

    const calls = a.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.systemPrompt).toBe(renderReplySummaryPrompt(renderSkillBodyFixture()))
    expect(calls[0]!.provider).toBe('p')
    expect(calls[0]!.prompt).toContain('reply body')
    expect(calls[0]!.prompt).toContain('<html_path>')
    expect(calls[0]!.prompt).toContain('<plan-rendered-html>')
    expect(calls[0]!.prompt).not.toContain('<plan-markdown>')
  })

  it('ReturnsPath: the returned path is a non-empty .html path', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    const hp = await renderReplyToHTML(e, 'sess', 'some reply')
    expect(hp.endsWith('.html')).toBe(true)
    expect(hp).not.toBe('')
  })

  it('FailureCleansTempDir: a failed fork removes its temp dir; success preserves it', async () => {
    const fail = createRenderAgent({ err: new Error('fork failed') })
    const eFail = newRenderEngine(fail, createStubMediaPlatform())
    const hpFail = await renderReplyToHTML(eFail, 'sess', 'some reply')
    expect(existsSync(hpFail.split('/').slice(0, -1).join('/'))).toBe(false)

    const ok = createRenderAgent()
    const eOk = newRenderEngine(ok, createStubMediaPlatform())
    const hpOk = await renderReplyToHTML(eOk, 'sess', 'some reply')
    expect(existsSync(hpOk.split('/').slice(0, -1).join('/'))).toBe(true)
  })

  it('LineageParentSession: a reply render records the originating chat as the render one-shot parent', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform())
    const key = 'test:chat:parentlink'
    e.sessions.getOrCreateActive(key).setAgentInfo('cc-hub-native-1', 'dsh', 'hub')

    await renderReplyToHTML(e, key, 'reply body')

    expect(agent.getCalls()).toHaveLength(1)
    expect(agent.getCalls()[0]?.parentSession).toBe('cc-hub-native-1')
  })

  it('LineageNoLiveSession: a render for a chat with no live session leaves parentSession unset', async () => {
    const agent = createRenderAgent()
    const e = newRenderEngine(agent, createStubMediaPlatform())

    await renderReplyToHTML(e, 'test:chat:orphan', 'reply body')

    expect(agent.getCalls()).toHaveLength(1)
    expect(agent.getCalls()[0]?.parentSession).toBeUndefined()
  })
})

describe('DeliverReplyHTML', () => {
  it('sends the html file with a title-derived filename and errors on a missing file', async () => {
    const tmp = tempDir('deliver-html-')
    const htmlPath = join(tmp, 'reply.html')
    const htmlBody = '<html><head><title>修复登录 bug</title></head><body>x</body></html>'
    writeFileSync(htmlPath, htmlBody, 'utf8')
    const p = createStubMediaPlatform()
    void new Engine('test', createStubAgent(), [p], '', 'en')

    await deliverReplyHTML(p, 'reply-ctx', htmlPath)
    expect(p.files).toHaveLength(1)
    expect(Buffer.from(p.files[0]!.data).toString('utf8')).toBe(htmlBody)
    expect(p.files[0]!.mimeType).toBe('text/html')
    expect(p.files[0]!.fileName).toBe('修复登录 bug.html')

    await expect(deliverReplyHTML(p, 'ctx', join(tmp, 'nope.html'))).rejects.toThrow()
  })
})

const longText = '足够长的回复内容。'.repeat(60)

describe('RenderAndDeliverReply', () => {
  it('ForksAndDelivers: auto-delivers the HTML and caches it for the export button', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'feishu:user1', longText, 'om_card1')

    await pollUntil(() => p.files.length > 0, 2000)
    expect(p.files).toHaveLength(1)
    expect(p.files[0]!.mimeType).toBe('text/html')
    await pollUntil(() => state.renderedReplyHTML?.get('om_card1') !== undefined, 2000)
    expect(state.renderedReplyHTML?.get('om_card1')).not.toBe('')
  })

  it('ReconstructsReplyCtxWhenNil: delivery rebuilds the replyCtx from the sessionKey', async () => {
    const a = createRenderAgent()
    const p = createReconstructFilePlatform()
    const e = newRenderEngine(a, p)

    const state = newRenderState(p)
    state.replyCtx = undefined // async delivery outlived the turn-end cleanup
    renderAndDeliverReply(e, state, 'feishu:user1', longText, 'om_card1')

    await pollUntil(() => p.reconstructCalls.length > 0 && p.files.length > 0, 2000)
    expect(p.reconstructCalls).toHaveLength(1)
    expect(p.files).toHaveLength(1)
  })

  it('SingleFlight: a second fork while one runs is skipped', async () => {
    const a = createRenderAgent({ delayMs: 30_000 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')
    await pollUntil(() => a.getCalls().length > 0, 2000)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_2')
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    expect(a.getCalls()).toHaveLength(1)
    cancelRendersFor(state)
  })

  it('RetriesOnTimeout: a blocked first attempt is retried and the second delivers', async () => {
    const a = createRenderAgent({ blockCount: 1 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 100 })

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    await pollUntil(() => p.files.length > 0, 3000)
    expect(p.files).toHaveLength(1)
    expect(a.getCalls()).toHaveLength(2)
  })

  it('RetriesOnStall: an ErrRenderStalled first attempt is retried', async () => {
    const a = createRenderAgent({ stallCount: 1 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    await pollUntil(() => p.files.length > 0, 3000)
    expect(p.files).toHaveLength(1)
    expect(a.getCalls()).toHaveLength(2)
  })

  it('StallPartialFileDeleted: a partial file from a stalled attempt is not delivered', async () => {
    const a = createRenderAgent({ stallCount: 1, stallPartial: true })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    await pollUntil(() => p.files.length > 0, 3000)
    expect(p.files).toHaveLength(1)
    expect(a.getCalls()).toHaveLength(2)
    expect(p.files[0]!.fileName).not.toBe('')
  })

  it('CancelStopsRetry: cancelling during the first attempt prevents the second', async () => {
    const a = createRenderAgent({ blockCount: 5 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 100 })

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')
    await pollUntil(() => a.getCalls().length > 0, 2000)
    expect(a.getCalls()).toHaveLength(1)

    cancelRendersFor(state)

    await pollUntil(() => !state.preRenderRunning, 2000)
    expect(a.getCalls()).toHaveLength(1)
    expect(p.files).toHaveLength(0)
  })

  it('AbortAfterCompletionRecordsCancelled: a new turn cancelling a just-finished fork settles as cancelled, not failed', async () => {
    // F4a's reply-path window: the fork already wrote its html and returned
    // ok when the user opens a new turn — the file passes the existence check
    // and the delivery aborts, which must read as a cancel, never a failure,
    // and must not leak the temp dir (the completed fork skipped the failure
    // cleanup).
    const a = createRenderAgent({ writeThenBlockOkCount: 5 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    // Wait until the fork wrote its html; a new turn then cancels the render,
    // and the fork's completion still lands after the cancel.
    await pollUntil(() => {
      const hp = htmlPathFromPrompt(a.getCalls()[0]?.prompt ?? '')
      return hp !== '' && existsSync(hp)
    }, 2000)
    const attemptDir = dirname(htmlPathFromPrompt(a.getCalls()[0]!.prompt))
    cancelRendersFor(state)

    await pollUntil(() => getRenderStatus(state, 'om_1')?.status !== undefined
      && getRenderStatus(state, 'om_1')?.status !== 'rendering' && !state.preRenderRunning
      && !existsSync(attemptDir), 3000)
    expect(getRenderStatus(state, 'om_1')?.status).toBe('cancelled')
    expect(p.files).toHaveLength(0)
  })

  it('CancelDuringDeliverRecordsCancelled: aborting while the png retries settles cancelled, not failed', async () => {
    // The fork already completed (html on disk), the png script keeps
    // failing, and the user cancels during the png retry backoff: the
    // aborted renderHTMLToPNG throws and deliverReplyHTML rethrows on its
    // abort check — the catch must read that as the user's cancel, never as
    // 渲染失败.
    const tmp = tempDir('reply-deliver-cancel-')
    const calls = join(tmp, 'calls')
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    e.planRenderPngScript = writeRenderTestScript(tmp, 'fail-png.sh', `#!/bin/sh\necho x >> "${calls}"\nexit 1\n`)

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    // The fork succeeded and the deliver stage ran its first png attempt.
    await pollUntil(() => existsSync(calls), 2000)
    cancelRendersFor(state)

    await pollUntil(() => getRenderStatus(state, 'om_1')?.status !== undefined
      && getRenderStatus(state, 'om_1')?.status !== 'rendering' && !state.preRenderRunning, 3000)
    expect(getRenderStatus(state, 'om_1')?.status).toBe('cancelled')
    expect(p.files).toHaveLength(0)
  })

  it('GivesUpAfterTwoFailures: two blocked attempts then no delivery', async () => {
    const a = createRenderAgent({ blockCount: 5 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 100 })

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    await pollUntil(() => !state.preRenderRunning && a.getCalls().length >= 2, 3000)
    expect(a.getCalls()).toHaveLength(2)
    expect(p.files).toHaveLength(0)
  })

  it('ProgressDrain: an in-flight tick PATCH lands before the terminal status PATCH', async () => {
    // #13: stopProgress only stops future ticks; a tick whose PATCH is still
    // on the wire must be drained BEFORE the terminal PATCH is issued, or the
    // card can end stuck on 渲染中 (the late tick overwrites the terminal
    // status). Held PATCH promises place the race at a deterministic point.
    //
    // The flow's inter-attempt temp cleanups are real fs I/O, which fake-clock
    // advancement cannot progress deterministically under load — a fixed
    // advance count made this test flaky (the terminal PATCH never arrived
    // within the budget). Every wait below is therefore condition-driven on a
    // real-clock budget, with the fake clock only driving the attempt
    // timeouts and the tick cadence.
    interface HeldPatch { text: string; release: () => void }
    const patches: HeldPatch[] = []
    // The stub carries no render-status method; Object.assign types the
    // dynamic override the ProgressDrain flow calls through RenderStatusUpdater.
    const heldPlatform = Object.assign(createStubMediaPlatform(), {
      updateRenderStatus: (_ctx: unknown, _key: string, text: string): Promise<void> => {
        const patch: HeldPatch = { text, release: (): void => {} }
        patches.push(patch)
        return new Promise<void>((resolve) => { patch.release = resolve })
      },
    })
    const a = createRenderAgent({ blockCount: 5 })
    const e = new Engine('test', a, [heldPlatform], '', 'en')
    e.planRenderEnabled = true
    e.planRenderProvider = 'p'
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
    e.planRenderTimeoutMs = 60_000
    const realNow = Date.now.bind(Date)

    const state = newRenderState(heldPlatform)
    vi.useFakeTimers()
    try {
      renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

      // Initial 'rendering' PATCH, then the 30s tick fires while attempt 1
      // (60s timeout) is still blocked.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(patches.length).toBeGreaterThanOrEqual(2)
      expect(patches.some(p => p.text.includes('30s')), 'the tick PATCH was issued').toBe(true)

      // Drive both attempt timeouts (60s, 120s) until the flow observably
      // reaches the failure exit: stopProgress clears the interval there, so
      // a full interval period advancing with no new PATCH means the exit
      // ran. The real yields inside each advance give the inter-attempt temp
      // cleanups time to land.
      let reachedExit = false
      const exitDeadline = realNow() + 1_500
      while (realNow() < exitDeadline) {
        const before = patches.length
        await vi.advanceTimersByTimeAsync(35_000)
        if (patches.length === before) {
          reachedExit = true
          break
        }
      }
      expect(reachedExit, 'the render flow reached its terminal exit within the budget').toBe(true)
      expect(a.cancelledCount()).toBe(2)

      // Red marker: the terminal PATCH must not be issued while a tick PATCH
      // is still in flight.
      expect(patches.some(p => p.text.includes('Render failed')), 'no terminal PATCH before the tick PATCHes settle').toBe(false)
      expect(getRenderStatus(state, 'om_1')?.status).toBe('rendering')
    } finally {
      vi.useRealTimers()
    }

    // Settle the held tick PATCHes; the drain then issues the terminal PATCH.
    // No fake timer remains on the flow's path once the exit ran (attempt
    // timers cleared in their finallys, the interval cleared at stopProgress),
    // so the final wait runs on the real clock.
    for (const patch of patches) patch.release()
    const terminalDeadline = realNow() + 1_500
    while (realNow() < terminalDeadline && !patches.some(p => p.text.includes('Render failed'))) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    }
    const terminalIdx = patches.findIndex(p => p.text.includes('Render failed'))
    expect(terminalIdx).toBeGreaterThan(-1)
    expect(patches.at(-1)?.text, 'the terminal PATCH is the last one issued').toContain('Render failed')
  })

  it('ProgressDrainInitialPatch: the initial rendering PATCH is drained before the terminal PATCH', async () => {
    // The initial 'rendering' PATCH is dispatched fire-and-forget with its
    // own transient-retry chain (~130s worst case). Unless it joins the
    // drain queue, a fast render issues the terminal PATCH while the initial
    // one is still on the wire, and its late landing flips the settled card
    // back to 渲染中. Held PATCH promises place the race at a deterministic
    // point; no fake clock is needed because the fork completes at once.
    interface HeldPatch { text: string; release: () => void }
    const patches: HeldPatch[] = []
    const heldPlatform = Object.assign(createStubMediaPlatform(), {
      updateRenderStatus: (_ctx: unknown, _key: string, text: string): Promise<void> => {
        const patch: HeldPatch = { text, release: (): void => {} }
        patches.push(patch)
        return new Promise<void>((resolve) => { patch.release = resolve })
      },
    })
    const a = createRenderAgent()
    const e = new Engine('test', a, [heldPlatform], '', 'en')
    e.planRenderEnabled = true
    e.planRenderProvider = 'p'
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())

    const state = newRenderState(heldPlatform)
    renderAndDeliverReply(e, state, 'k1', longText, 'om_1')

    // The render and delivery complete while the initial PATCH stays held.
    await pollUntil(() => heldPlatform.files.length > 0, 2000)
    expect(patches[0]?.text, 'the initial rendering PATCH was issued').toContain('Rendering')
    // Give the flow a beat to reach its terminal exit, then red marker: the
    // terminal PATCH must not be issued while the initial PATCH is in flight.
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    expect(patches.some(p => p.text.includes('✅ Sent')), 'no terminal PATCH before the initial PATCH settles').toBe(false)

    // Settle the held initial PATCH; the drain then issues the terminal one.
    for (const patch of patches) patch.release()
    await pollUntil(() => patches.some(p => p.text.includes('✅ Sent')), 2000)
    expect(patches.at(-1)?.text, 'the terminal PATCH is the last one issued').toContain('✅ Sent')
    for (const patch of patches) patch.release()
  })
})

function cancelRendersFor(state: InteractiveState): void {
  for (const h of state.renderCancels) h.cancel()
  state.renderCancels = []
}

describe('LaunchPlanRender', () => {
  it('MissingSkillFailsLoud: an unregistered render skill marks the render failed without forking', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    e.planRenderSkillSource = undefined // skill not registered

    const state = newRenderState(p)
    expect(shouldRenderPlan(state, '# 计划', 1)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', '# 计划', '', 1, 'plan:1')

    await pollUntil(() => getRenderStatus(state, 'plan:1')?.status === 'failed', 2000)
    expect(a.getCalls()).toHaveLength(0)
    // the throttle lock is released so a fixed deployment can render again
    expect(state.planRenderRunning).toBe(false)
  })

  it('ReplyPreRenderMissingSkill: the speculative reply render marks failed without delivering', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    e.planRenderSkillSource = undefined

    const state = newRenderState(p)
    renderAndDeliverReply(e, state, 'feishu:user1', longText, 'om_card1')

    await pollUntil(() => getRenderStatus(state, 'om_card1')?.status === 'failed', 2000)
    expect(a.getCalls()).toHaveLength(0)
    expect(p.files).toHaveLength(0)
    expect(state.preRenderRunning).toBe(false)
  })

  it('RetriesOnStall: the plan path retries once after a stall', async () => {
    const a = createRenderAgent({ stallCount: 1 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    expect(shouldRenderPlan(state, '# 计划\n\n步骤一：封装\n步骤二：接入', 1)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', '# 计划\n\n步骤一：封装\n步骤二：接入', '', 1, 'plan:1')

    await pollUntil(() => a.getCalls().length >= 2, 3000)
    expect(a.getCalls()).toHaveLength(2)
  })

  it('CancelStopsRetry: a cancelled plan render does not start a second attempt', async () => {
    const a = createRenderAgent({ blockCount: 5 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    expect(shouldRenderPlan(state, '# 计划', 1)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', '# 计划', '', 1, 'plan:1')

    await pollUntil(() => a.getCalls().length > 0, 2000)
    cancelRendersFor(state)
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    expect(a.getCalls()).toHaveLength(1)
  })

  it('AbortAfterWriteRecordsCancelled: approval aborting a written-out fork settles as cancelled, not failed', async () => {
    // F4a window: the fork already wrote its html when the user approves —
    // cancelPlanRenders aborts the fork, the file exists, but the status must
    // read cancelled (the user killed it), never failed.
    const a = createRenderAgent({ writeThenBlockCount: 5 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    expect(shouldRenderPlan(state, '# 计划', 1)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', '# 计划', '', 1, 'plan:1')

    // Wait until the fork wrote its html, then approve (cancelPlanRenders).
    await pollUntil(() => {
      const hp = htmlPathFromPrompt(a.getCalls()[0]?.prompt ?? '')
      return hp !== '' && existsSync(hp)
    }, 2000)
    cancelRendersFor(state)

    await pollUntil(() => getRenderStatus(state, 'plan:1')?.status !== undefined
      && getRenderStatus(state, 'plan:1')?.status !== 'rendering' && !state.planRenderRunning, 3000)
    expect(getRenderStatus(state, 'plan:1')?.status).toBe('cancelled')
    expect(p.files).toHaveLength(0)
  })

  it('CancelDuringDeliverRecordsCancelled: aborting while the png retries settles cancelled, not failed', async () => {
    // Plan-path sibling of the reply-path case: the fork completed, the png
    // keeps failing, and the user's cancel lands during the png retry
    // backoff — the deliver catch must settle cancelled, never failed.
    const tmp = tempDir('plan-deliver-cancel-')
    const calls = join(tmp, 'calls')
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    e.planRenderPngScript = writeRenderTestScript(tmp, 'fail-png.sh', `#!/bin/sh\necho x >> "${calls}"\nexit 1\n`)

    const state = newRenderState(p)
    expect(shouldRenderPlan(state, '# 计划', 1)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', '# 计划', '', 1, 'plan:1')

    // The fork succeeded and the deliver stage ran its first png attempt.
    await pollUntil(() => existsSync(calls), 2000)
    cancelRendersFor(state)

    await pollUntil(() => getRenderStatus(state, 'plan:1')?.status !== undefined
      && getRenderStatus(state, 'plan:1')?.status !== 'rendering' && !state.planRenderRunning, 3000)
    expect(getRenderStatus(state, 'plan:1')?.status).toBe('cancelled')
    expect(p.files).toHaveLength(0)
  })

  it('RetryCleansFailedAttemptDir: attempt-1\'s cc-plan-render-* dir is gone once attempt-2 takes over', async () => {
    // #12: each attempt derives a fresh mkdtemp dir; a failed attempt must
    // remove its own dir (reply-path symmetry) instead of leaking it when the
    // retry overwrites the single htmlPath variable.
    const a = createRenderAgent({ stallCount: 1 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })

    const state = newRenderState(p)
    expect(shouldRenderPlan(state, '# 计划', 1)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', '# 计划', '', 1, 'plan:1')

    await pollUntil(() => a.getCalls().length >= 2, 3000)
    const attempt1Dir = dirname(htmlPathFromPrompt(a.getCalls()[0]!.prompt))
    await pollUntil(() => getRenderStatus(state, 'plan:1')?.status === 'delivered' && !state.planRenderRunning, 3000)
    expect(existsSync(attempt1Dir)).toBe(false)
  })
})

describe('ShouldRenderPlan_RetryAfterFailure', () => {
  // F4b: the dedup hash is recorded only after the image is delivered — a
  // failed or cancelled render must not block a same-content retry (since
  // 3d6df58dcd the session revision is always ≥2 on re-presentation, so the
  // old "revision 1 always renders" fallback no longer masks this).
  it('a failed render allows the same content to render again; delivery dedupes it', async () => {
    const fail = createRenderAgent({ err: new Error('boom') })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(fail, p, { timeoutMs: 30_000 })
    const state = newRenderState(p)
    state.planRevisionCount = 2

    const content = '# 计划\n\n步骤一：封装'
    expect(shouldRenderPlan(state, content, 2)).toBe(true)
    launchPlanRender(e, state, 'feishu:user1', content, '', 2, 'plan:2')
    await pollUntil(() => getRenderStatus(state, 'plan:2')?.status === 'failed' && !state.planRenderRunning, 3000)

    // Same content re-presented (revision stays ≥2 within the session):
    // the failed render must not have poisoned the dedup hash.
    expect(shouldRenderPlan(state, content, 2)).toBe(true)
    expect(state.lastRenderedPlanHash).toBe('')

    // A delivered render is the only thing that dedupes.
    const ok = createRenderAgent()
    const eOk = newRenderEngine(ok, p)
    const stateOk = newRenderState(p)
    stateOk.planRevisionCount = 2
    expect(shouldRenderPlan(stateOk, content, 2)).toBe(true)
    launchPlanRender(eOk, stateOk, 'feishu:user1', content, '', 2, 'plan:2')
    await pollUntil(() => getRenderStatus(stateOk, 'plan:2')?.status === 'delivered' && !stateOk.planRenderRunning, 3000)
    expect(stateOk.lastRenderedPlanHash).not.toBe('')
    expect(shouldRenderPlan(stateOk, content, 2)).toBe(false)
  })
})

// ── event-loop integration (Go TestProcessInteractiveEvents_* render cases) ──

async function driveLoop(e: Engine, state: InteractiveState, sessionKey: string, events: Array<Record<string, unknown>>): Promise<void> {
  const session = e.sessions.getOrCreateActive(sessionKey)
  const agentSession = newControllableSession('s1')
  state.agentSession = agentSession
  e.interactiveStates.set(sessionKey, state)
  for (const ev of events) agentSession.channel.push(ev as never)
  await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
}

describe('processInteractiveEvents render integration', () => {
  it('PreRenderAutoDelivers: a long reply turn-end forks and delivers the HTML', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    const state = newRenderState(p)

    await driveLoop(e, state, 'feishu:user1', [
      { type: 'text', content: longText },
      { type: 'result', content: longText, done: true },
    ])

    await pollUntil(() => p.files.length > 0, 2000)
    expect(p.files).toHaveLength(1)
    expect(p.files[0]!.mimeType).toBe('text/html')
  })

  it('ExitPlanModeSkipsReplyPreRender: only the plan render fires, its prompt carries the plan body', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    const state = newRenderState(p)
    const sessionKey = 'feishu:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    state.agentSession = agentSession
    e.interactiveStates.set(sessionKey, state)

    const leadText = '我先分析一下方案。'.repeat(60) // ≥500 runes → would trigger the reply pre-detach
    const planBody = '# 计划\n\n步骤一：封装\n步骤二：接入'
    agentSession.channel.push({ type: 'text', content: leadText, done: false })

    const loopDone = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    // The plan-review ask arrives through the delegate while the loop runs.
    await pollUntil(() => state.textParts.length > 0, 2000)
    const decision = e.askUser(sessionKey, { kind: 'plan-review', heading: '# 计划', plan: planBody })
    await pollUntil(() => state.pendingAsk !== undefined, 2000)
    state.pendingAsk?.resolve({ outcome: 'allowed-once' })
    await decision
    agentSession.channel.push({ type: 'result', content: '', done: true })
    await loopDone

    // Only the plan render ran (prompt contains the plan body); the reply
    // pre-detach render did not fire.
    await pollUntil(() => a.getCalls().length > 0, 2000)
    expect(a.getCalls()).toHaveLength(1)
    expect(a.getCalls()[0]!.prompt).toContain(planBody)
    // The plan markdown card (fallback) was delivered as text by the plain
    // stub platform.
    expect(p.getSent().join('\n')).toContain(planBody)
  })

  it('PlanRenderUsesPlainLayer: a layered plan renders from the plain layer only', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    const state = newRenderState(p)
    const sessionKey = 'feishu:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    state.agentSession = agentSession
    e.interactiveStates.set(sessionKey, state)

    const plainLayer = '# 计划\n\n问题是什么、怎么改、改完什么效果'
    const detailsLayer = '1. **TDD Red** — packages/compaction/compaction-basic/tests/compaction-basic.spec.ts 断言逐字条款\n2. 机制:summarizer 指令 Rules 追加条目'
    const assembled = `${plainLayer}\n\n${detailsLayer}`
    const decision = e.askUser(sessionKey, {
      kind: 'plan-review',
      heading: '# 计划',
      plan: assembled,
      layers: { plain: plainLayer, details: detailsLayer },
    })
    await pollUntil(() => state.pendingAsk !== undefined, 2000)
    state.pendingAsk?.resolve({ outcome: 'allowed-once' })
    await decision
    agentSession.channel.push({ type: 'result', content: '', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    await pollUntil(() => a.getCalls().length > 0, 2000)
    expect(a.getCalls()).toHaveLength(1)
    // The render prompt carries the plain layer, never the details annex.
    expect(a.getCalls()[0]!.prompt).toContain(plainLayer)
    expect(a.getCalls()[0]!.prompt).not.toContain('TDD Red')
    expect(a.getCalls()[0]!.prompt).not.toContain('compaction-basic.spec.ts')
  })

  it('PlanRenderStallRetryThroughLoop: a stalled plan render retries and delivers', async () => {
    const a = createRenderAgent({ stallCount: 1 })
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p, { timeoutMs: 30_000 })
    const state = newRenderState(p)
    const sessionKey = 'feishu:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const agentSession = newControllableSession('s1')
    state.agentSession = agentSession
    e.interactiveStates.set(sessionKey, state)

    const planBody = '# 计划\n\n步骤一：封装\n步骤二：接入'
    const decision = e.askUser(sessionKey, { kind: 'plan-review', heading: '# 计划', plan: planBody })
    await pollUntil(() => state.pendingAsk !== undefined, 2000)
    state.pendingAsk?.resolve({ outcome: 'allowed-once' })
    await decision
    agentSession.channel.push({ type: 'result', content: '', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    await pollUntil(() => a.getCalls().length >= 2, 3000)
    expect(a.getCalls()).toHaveLength(2)
  })
})

describe('turn-end reply-render suppression', () => {
  /** Engine + render agent + platform with an auto-render-policy listener shaped like the chatroom package's production half. */
  function chatroomRoleEngine(): { a: ReturnType<typeof createRenderAgent>; e: Engine; p: ReturnType<typeof createStubMediaPlatform> } {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const ctx = new Context()
    contextsForDispose.push(ctx)
    ctx.on('feishuBridge/auto-render-policy', (payload: { session: Session }, next: () => boolean) =>
      next() || chatroomSection(payload.session).chatroomHubKey !== '')
    const e = newRenderEngine(a, p, { bridge: ctxBridgeDispatch(ctx) })
    return { a, e, p }
  }

  it('TurnEndSkipsChatroomRole: a chatroom role session does not fork the reply render', async () => {
    const { a, e, p } = chatroomRoleEngine()
    const state = newRenderState(p)
    const sessionKey = 'feishu:user1'
    chatroomSection(e.sessions.getOrCreateActive(sessionKey)).chatroomHubKey = 'feishu:hub:ou_user'

    await driveLoop(e, state, sessionKey, [
      { type: 'text', content: longText },
      { type: 'result', content: longText, done: true },
    ])
    await new Promise((r) => { setTimeout(r, 200) })

    expect(a.getCalls()).toHaveLength(0)
    expect(state.preRenderRunning).toBe(false)
  })

  it('TurnEndSkipsSubtaskChild: a subtask child session does not fork the reply render', async () => {
    const a = createRenderAgent()
    const p = createStubMediaPlatform()
    const e = newRenderEngine(a, p)
    const state = newRenderState(p)
    const sessionKey = 'feishu:user1'
    e.sessions.getOrCreateActive(sessionKey).setSubtaskDepth(1)

    await driveLoop(e, state, sessionKey, [
      { type: 'text', content: longText },
      { type: 'result', content: longText, done: true },
    ])
    await new Promise((r) => { setTimeout(r, 200) })

    expect(a.getCalls()).toHaveLength(0)
    expect(state.preRenderRunning).toBe(false)
  })

  it('TurnEndKeepsUserTakeover: a user-interjected chatroom role session still forks', async () => {
    const { a, e, p } = chatroomRoleEngine()
    const state = newRenderState(p)
    const sessionKey = 'feishu:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    chatroomSection(session).chatroomHubKey = 'feishu:hub:ou_user'
    session.setUserInterjected(true)

    await driveLoop(e, state, sessionKey, [
      { type: 'text', content: longText },
      { type: 'result', content: longText, done: true },
    ])

    await pollUntil(() => a.getCalls().length > 0, 2000)
    expect(a.getCalls()).toHaveLength(1)
  })
})
