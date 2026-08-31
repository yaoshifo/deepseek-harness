/**
 * M3→B2 plan tests: sendPlanContent truncation variants (unchanged), the
 * plan-review ask card ordering (plan card awaited before the permission
 * card), and the plan-file preference over inline plan markdown. The
 * effectiveMode/approveAll assertions retired with B2: native plan mode owns
 * mode transitions, and allow-all is a native standing grant.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-plan
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubPlatform,
  newControllableSession,
} from '../stubs/engine-stubs.ts'
import { statusOf } from '../stubs/preview-content.ts'
import { newStreamPreview, ProgressEntry } from '../../src/streaming.ts'
import type { Message, ProgressContent } from '../../src/core/types.ts'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function newTestEngine(): Engine {
  return new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'feishu:oc_plan:u1',
    platform: 'test',
    messageID: '',
    userID: 'user1',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
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
    ...overrides,
  }
}

describe('PlanMaxLen', () => {
  it('NoTruncation: plan under limit sent intact', async () => {
    const p = createStubCardPlatform('feishu')
    const e = newTestEngine()
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const planContent = '# Plan\n\n1. Do X\n2. Do Y\n3. Verify'
    const tmpFile = join(tmpDir, 'test-plan.md')
    writeFileSync(tmpFile, planContent, 'utf8')

    const result = await e.sendPlanContent(p, 'replyCtx', undefined, tmpFile, 1, '')
    expect(result).not.toBe('')

    const card = p.sentCards[0] as { elements: Array<{ kind: string; content?: string }> }
    const body = card.elements.map(el => el.content ?? '').join('\n')
    expect(body).toContain('Do X')
    expect(body).toContain('Verify')
    expect(body).not.toContain('...')
  })

  it('TruncationWhenExceeded: long plan truncated with ...', async () => {
    const p = createStubCardPlatform('feishu')
    const e = newTestEngine()
    e.display.planMaxLen = 100
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const tmpFile = join(tmpDir, 'long-plan.md')
    writeFileSync(tmpFile, 'x'.repeat(200), 'utf8')

    await e.sendPlanContent(p, 'replyCtx', undefined, tmpFile, 1, '')

    const card = p.sentCards[0] as { elements: Array<{ kind: string; content?: string }> }
    expect(card.elements.map(el => el.content ?? '').join('\n')).toContain('...')
  })

  it('ZeroNoTruncation: PlanMaxLen=0 sends full content', async () => {
    const p = createStubCardPlatform('feishu')
    const e = newTestEngine()
    e.display.planMaxLen = 0
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const tmpFile = join(tmpDir, 'huge-plan.md')
    writeFileSync(tmpFile, 'A'.repeat(50000), 'utf8')

    const result = await e.sendPlanContent(p, 'replyCtx', undefined, tmpFile, 1, '')
    expect(result).toHaveLength(50000)
  })
})

describe('PlanCardBeforePermissionCard', () => {
  it('the permission card is sent only after the plan card send completes', async () => {
    // The plan-card send must be awaited so the chat always shows plan →
    // approval; a fire-and-forget send lets the small permission card beat
    // the large plan card to Feishu.
    const p = createStubCardPlatform('feishu') as ReturnType<typeof createStubCardPlatform> & {
      sendCard: (rc: unknown, card: unknown) => Promise<void>
    }
    const order: string[] = []
    let releasePlan!: () => void
    const gate = new Promise<void>((resolve) => { releasePlan = resolve })
    const sendCard = p.sendCard.bind(p)
    p.sendCard = async (rc, card) => {
      const c = card as { elements: Array<{ kind: string; content?: string }> }
      const isPlan = c.elements.some(el => el.content?.includes('step one'))
      order.push(isPlan ? 'plan:start' : 'perm:start')
      if (isPlan) await gate
      order.push(isPlan ? 'plan:done' : 'perm:done')
      await sendCard(rc, card)
    }

    const engine = newTestEngine()
    const key = 'feishu:oc_plan:u1'
    engine.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    engine.interactiveStates.set(key, state)

    const decision = engine.askUser(key, {
      kind: 'plan-review',
      heading: '# P',
      plan: '# P\n1. step one',
    })
    await new Promise((r) => { setTimeout(r, 30) })

    // While the plan-card send is still gated, the permission card must not
    // have started.
    expect(order).toEqual(['plan:start'])

    releasePlan()
    await new Promise((r) => { setTimeout(r, 30) })
    expect(order).toEqual(['plan:start', 'plan:done', 'perm:start', 'perm:done'])

    engine.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })
})

describe('PlanFilePreference', () => {
  it('a plan file written this round wins over the inline plan markdown', async () => {
    const p = createStubCardPlatform('feishu')
    const e = newTestEngine()
    const key = 'feishu:oc_plan:u2'
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const planFile = join(tmpDir, 'plan-from-file.md')
    writeFileSync(planFile, '# From file\n\nfile content wins', 'utf8')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    state.planFilePath = planFile
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# Inline', plan: '# Inline\ninline body' })
    await new Promise((r) => { setTimeout(r, 30) })

    const planCard = p.sentCards[0] as { elements: Array<{ kind: string; content?: string }> }
    const body = planCard.elements.map(el => el.content ?? '').join('\n')
    expect(body).toContain('file content wins')

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:deny', isPermissionAction: true }), 'perm:deny')
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
  })
})

describe('PlanTextDedup', () => {
  it('plan text already streamed is stripped from the reply source', async () => {
    const p = createStubCardPlatform('feishu')
    const e = newTestEngine()
    const key = 'feishu:oc_plan:u3'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    state.textParts = ['intro\n# Plan\n1. Do X\n2. Do Y\ntrailing']
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# Plan', plan: '# Plan\n1. Do X\n2. Do Y' })
    await new Promise((r) => { setTimeout(r, 30) })

    expect(state.textParts.join('\n')).not.toContain('1. Do X')
    expect(state.textParts.join('\n')).toContain('trailing')

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await decision
  })
})

describe('PlanRenderIntegration', () => {
  it('an ExitPlanMode ask parks the ask and renders both cards', async () => {
    const p = createStubCardPlatform('feishu')
    const e = newTestEngine()
    const key = 'feishu:oc_plan:u4'
    e.sessions.getOrCreateActive(key)
    const sess = newControllableSession('plan-live')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# Fix spinner', plan: '# Fix spinner\n\n1. resolve asset path' })
    await new Promise((r) => { setTimeout(r, 30) })

    expect(state.pendingAsk).toBeDefined()
    expect(p.sentCards.length).toBeGreaterThanOrEqual(2)

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    expect(state.pendingAsk).toBeUndefined()
  })
})

describe('PlanReviewParkedCardSettle', () => {
  // 2026-08-28 oc_b20512: approving the plan left the pre-plan progress card
  // at 等待中 forever. The ask's settlement must PATCH the parked card's
  // header to the outcome and still restart execution on a fresh card.
  interface PreviewRecorderPlatform extends ReturnType<typeof createStubCardPlatform> {
    /** Every preview call in order: which handle, and what content. */
    calls: Array<{ handle: string; content: ProgressContent }>
    sendPreviewStart(rc: unknown, content: ProgressContent): Promise<string>
    updateMessage(handle: unknown, content: ProgressContent): Promise<void>
  }

  function createPreviewRecorderPlatform(): PreviewRecorderPlatform {
    const base = createStubCardPlatform('feishu')
    const calls: Array<{ handle: string; content: ProgressContent }> = []
    let next = 0
    return Object.assign(base, {
      calls,
      async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<string> {
        next++
        calls.push({ handle: `handle-${next}`, content })
        return `handle-${next}`
      },
      async updateMessage(handle: unknown, content: ProgressContent): Promise<void> {
        calls.push({ handle: String(handle), content })
      },
    })
  }

  /** Engine + state with a live progress card on the recorder platform. */
  async function armedPreviewState(e: Engine, p: PreviewRecorderPlatform, key: string): Promise<InteractiveState> {
    const state = new InteractiveState()
    state.agentSession = newControllableSession('plan-settle')
    state.platform = p
    state.replyCtx = 'ctx'
    const sp = newStreamPreview(
      { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 5000 }, p, 'ctx', undefined, undefined, key)
    await sp.appendProgress(new ProgressEntry({ isTool: true, header: '**00:00:01**', body: 'ls', lang: 'bash', toolID: 't1' }))
    state.preview = sp
    e.interactiveStates.set(key, state)
    return state
  }

  it('approval settles the parked card header and restarts on a fresh card', async () => {
    const p = createPreviewRecorderPlatform()
    const e = newTestEngine()
    e.display.toolProgress = true
    const key = 'feishu:oc_plan:u5'
    await armedPreviewState(e, p, key)
    e.sessions.getOrCreateActive(key)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\nbody' })
    await new Promise((r) => { setTimeout(r, 30) })
    const first = p.calls[0]
    if (first === undefined) throw new Error('no initial preview recorded')
    expect(statusOf(first.content)?.state).toBe('running')

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    // The restart's placeholder start is fire-and-forget — let it land.
    await new Promise((r) => { setTimeout(r, 20) })

    // The parked card (handle-1) was PATCHed from waiting to approved.
    const states = p.calls.filter(c => c.handle === 'handle-1').map(c => statusOf(c.content)?.state)
    expect(states).toEqual(['running', 'waiting', 'approved'])
    // The restart opened a fresh placeholder card after the settle (its
    // placeholder content carries no status — the card renders the running
    // default).
    const restart = p.calls.find(c => c.handle === 'handle-2')
    expect(restart).toBeDefined()
    expect(restart?.content.kind).toBe('text')
  })

  it('rejection settles the parked card header as rejected', async () => {
    const p = createPreviewRecorderPlatform()
    const e = newTestEngine()
    e.display.toolProgress = true
    const key = 'feishu:oc_plan:u6'
    await armedPreviewState(e, p, key)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\nbody' })
    await new Promise((r) => { setTimeout(r, 30) })

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:deny', isPermissionAction: true }), 'perm:deny')
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })

    const states = p.calls.filter(c => c.handle === 'handle-1').map(c => statusOf(c.content)?.state)
    expect(states).toEqual(['running', 'waiting', 'rejected'])
  })
})
