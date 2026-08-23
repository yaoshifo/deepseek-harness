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

import { describe, expect, it } from 'vitest'
import { existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { Engine, InteractiveState } from '../../src/engine/engine.js'
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
} from '../../src/engine/plan-render.js'
import {
  createStubAgent,
  createStubMediaPlatform,
  createStubPlatform,
  newControllableSession,
} from '../stubs/engine-stubs.js'
import {
  createReconstructFilePlatform,
  createRenderAgent,
  htmlPathFromPrompt,
  newRenderEngine,
  newRenderState,
  pollUntil,
  renderSkillBodyFixture,
  tempDir,
} from './plan-render-helpers.js'

function renderEnvHas(env: string[], kv: string): boolean {
  return env.includes(kv)
}

describe('RenderPlanToHTML', () => {
  it('NoCrosstalk: each fork receives exactly the sessionEnv passed in', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    e.planRenderProvider = 'p'

    const envA = ['CC_PROJECT=test', 'CC_SESSION_KEY=keyA']
    const envB = ['CC_PROJECT=test', 'CC_SESSION_KEY=keyB']
    await renderPlanToHTML(e, 'sessA', '# plan A', '/tmp/a.md', 1, envA)
    await renderPlanToHTML(e, 'sessB', '# plan B', '/tmp/b.md', 1, envB)

    const calls = a.getCalls()
    expect(calls).toHaveLength(2)
    expect(renderEnvHas(calls[0]!.sessionEnv, 'CC_SESSION_KEY=keyA')).toBe(true)
    expect(renderEnvHas(calls[1]!.sessionEnv, 'CC_SESSION_KEY=keyB')).toBe(true)
    expect(renderEnvHas(calls[0]!.sessionEnv, 'CC_SESSION_KEY=keyB')).toBe(false)
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
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1, ['CC_SESSION_KEY=k'])
    expect(a.getCalls()).toHaveLength(1)
  })

  it('TimeoutHonored: an aborted signal cuts the fork short', async () => {
    const a = createRenderAgent({ delayMs: 300 })
    const e = newRenderEngine(a, createStubMediaPlatform())
    const ctl = new AbortController()
    setTimeout(() => { ctl.abort() }, 50)
    const start = Date.now()
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1, ['CC_SESSION_KEY=k'], ctl.signal)
    expect(Date.now() - start).toBeLessThan(250)
  })

  it('PromptUsesAsciiTempPath: the write path is a cc-plan-render-* temp dir without the CJK title', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    const title = '提高 distill_add job 优先级，触发蒸馏重跑'
    const planFilePath = join(tempDir('plan-ascii-'), 'foo.md')
    await renderPlanToHTML(e, 'feishu_oc_abc123', `# ${title}`, planFilePath, 1, ['CC_SESSION_KEY=k'])

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
    await renderPlanToHTML(e, 'feishu_oc_abc', `# ${title}`, planFilePath, 1, ['CC_SESSION_KEY=k'])

    const sibling = join(planDir, `${slugifyTitle(title, '')}.html`)
    expect(existsSync(sibling)).toBe(true)
    expect(statSync(sibling).size).toBeGreaterThan(0)
  })

  it('AgentNotRenderQuerier: an agent without renderQuery is a silent no-op', async () => {
    const e = new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
    e.planRenderProvider = 'p'
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1, [])
  })

  it('NoProviderSkips: an unresolved provider skips the fork entirely', async () => {
    const a = createRenderAgent()
    const e = new Engine('test', a, [createStubMediaPlatform()], '', 'en') // no provider configured
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
    await renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1, [])
    expect(a.getCalls()).toHaveLength(0)
  })
})

describe('RenderForks_RequireRegisteredSkill', () => {
  it('rejects with registration guidance and never forks when the skill source is unwired', async () => {
    const a = createRenderAgent()
    const e = new Engine('test', a, [createStubMediaPlatform()], '', 'en')
    e.planRenderProvider = 'p'

    await expect(renderPlanToHTML(e, 'sess', '# plan', '/tmp/x.md', 1, [])).rejects.toThrow(/feishu-bridge-render/)
    await expect(renderReplyToHTML(e, 'sess', 'reply body', [])).rejects.toThrow(/feishu-bridge-render/)
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

    await renderReplyToHTML(e, 'sess', 'reply body', [])

    expect(resolves).toBe(1)
    expect(a.getCalls()[0]!.systemPrompt).toContain(renderSkillBodyFixture())
  })
})

describe('RenderReplyToHTML', () => {
  it('UsesReplyPrompt: reply prompt, provider, SimpleHTML fragment, env passthrough', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())

    await renderReplyToHTML(e, 'sess', 'the agent reply body', ['CC_SESSION_KEY=k'])

    const calls = a.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.systemPrompt).toBe(renderReplySummaryPrompt(renderSkillBodyFixture()))
    expect(calls[0]!.provider).toBe('p')
    expect(calls[0]!.prompt).toContain('reply body')
    expect(calls[0]!.prompt).toContain('<html_path>')
    expect(calls[0]!.prompt).toContain('<plan-rendered-html>')
    expect(calls[0]!.prompt).not.toContain('<plan-markdown>')
    expect(renderEnvHas(calls[0]!.sessionEnv, 'CC_SESSION_KEY=k')).toBe(true)
  })

  it('ReturnsPath: the returned path is a non-empty .html path', async () => {
    const a = createRenderAgent()
    const e = newRenderEngine(a, createStubMediaPlatform())
    const hp = await renderReplyToHTML(e, 'sess', 'some reply', ['CC_SESSION_KEY=k'])
    expect(hp.endsWith('.html')).toBe(true)
    expect(hp).not.toBe('')
  })

  it('FailureCleansTempDir: a failed fork removes its temp dir; success preserves it', async () => {
    const fail = createRenderAgent({ err: new Error('fork failed') })
    const eFail = newRenderEngine(fail, createStubMediaPlatform())
    const hpFail = await renderReplyToHTML(eFail, 'sess', 'some reply', ['CC_SESSION_KEY=k'])
    expect(existsSync(hpFail.split('/').slice(0, -1).join('/'))).toBe(false)

    const ok = createRenderAgent()
    const eOk = newRenderEngine(ok, createStubMediaPlatform())
    const hpOk = await renderReplyToHTML(eOk, 'sess', 'some reply', ['CC_SESSION_KEY=k'])
    expect(existsSync(hpOk.split('/').slice(0, -1).join('/'))).toBe(true)
  })
})

describe('DeliverReplyHTML', () => {
  it('sends the html file with a title-derived filename and errors on a missing file', async () => {
    const tmp = tempDir('deliver-html-')
    const htmlPath = join(tmp, 'reply.html')
    const htmlBody = '<html><head><title>修复登录 bug</title></head><body>x</body></html>'
    writeFileSync(htmlPath, htmlBody, 'utf8')
    const p = createStubMediaPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')

    await deliverReplyHTML(e, p, 'reply-ctx', htmlPath)
    expect(p.files).toHaveLength(1)
    expect(Buffer.from(p.files[0]!.data).toString('utf8')).toBe(htmlBody)
    expect(p.files[0]!.mimeType).toBe('text/html')
    expect(p.files[0]!.fileName).toBe('修复登录 bug.html')

    await expect(deliverReplyHTML(e, p, 'ctx', join(tmp, 'nope.html'))).rejects.toThrow()
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
    agentSession.channel.push({ type: 'permission_request', content: '', toolName: 'ExitPlanMode', toolInputRaw: { plan: planBody }, requestID: 'r1', done: false })

    const loopDone = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    // Resolve the pending permission once it is parked.
    await pollUntil(() => state.pending !== undefined, 2000)
    state.pending?.resolve()
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
    agentSession.channel.push({ type: 'permission_request', content: '', toolName: 'ExitPlanMode', toolInputRaw: { plan: planBody }, requestID: 'r1', done: false })

    const loopDone = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await pollUntil(() => state.pending !== undefined, 2000)
    state.pending?.resolve()
    agentSession.channel.push({ type: 'result', content: '', done: true })
    await loopDone

    await pollUntil(() => a.getCalls().length >= 2, 3000)
    expect(a.getCalls()).toHaveLength(2)
  })
})
