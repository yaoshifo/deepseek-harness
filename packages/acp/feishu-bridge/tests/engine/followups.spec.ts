/**
 * Closing-card signature conversion tests: isFollowupsAsk recognizes the
 * prompt-mandated closing-card signature (single question whose header is the
 * reserved「后续处理」, or a single multi-select question carrying a
 * 「暂不处理」option) so askUser can convert it into a non-blocking followups
 * registration instead of parking the turn.
 *
 * @module dsh-feishu-bridge/tests-engine-followups
 */

import { describe, expect, it } from 'vitest'
import { FOLLOWUPS_ASK_HEADER, isFollowupsAsk } from '../../src/engine/ask.ts'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubCardPlatform, createStubMediaPlatform, createStubPlatform } from '../stubs/engine-stubs.ts'
import { createControllableAgent, newControllableSession, type ControllableAgentSession } from '../stubs/engine-stubs.ts'
import { newStreamPreview, type StreamPreview } from '../../src/streaming.ts'
import { createRenderAgent, pollUntil, renderSkillBodyFixture } from './plan-render-helpers.ts'
import type { Platform } from '../../src/core/types.ts'
import type { AskRequest, FileAttachment, ImageAttachment, Message, UserQuestion } from '../../src/core/types.ts'
import type { Card } from '../../src/card.ts'

function q(overrides: Partial<UserQuestion> = {}): UserQuestion {
  return {
    question: '后续处理哪些？',
    header: FOLLOWUPS_ASK_HEADER,
    options: [
      { label: '修复 A', description: 'src/a.ts:1 空指针' },
      { label: '暂不处理', description: '' },
    ],
    multiSelect: true,
    ...overrides,
  }
}

function questionsAsk(...questions: UserQuestion[]): AskRequest {
  return { kind: 'questions', questions }
}

/** Engine + state armed on the standard test session key (zh copy face). */
function armedState(): { e: Engine; state: InteractiveState; p: ReturnType<typeof createStubCardPlatform> } {
  const p = createStubCardPlatform('feishu')
  const e = new Engine('test', createStubAgent(), [p], '', 'zh')
  const state = new InteractiveState()
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set('test:chat:user1', state)
  return { e, state, p }
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:chat:user1',
    platform: 'feishu',
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

describe('isFollowupsAsk', () => {
  it('matches the reserved closing-card header on a single question', () => {
    expect(isFollowupsAsk(questionsAsk(q()))).toBe(true)
  })

  it('matches the fallback signature: single multi-select question with a 暂不处理 option', () => {
    expect(isFollowupsAsk(questionsAsk(q({ header: '清理' })))).toBe(true)
  })

  it('does not match a genuine single-select question', () => {
    expect(isFollowupsAsk(questionsAsk(q({
      header: 'Setup',
      multiSelect: false,
      options: [{ label: 'PostgreSQL', description: '' }],
    })))).toBe(false)
  })

  it('does not match a multi-select question without the reserved header or decline option', () => {
    expect(isFollowupsAsk(questionsAsk(q({
      header: '范围',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    })))).toBe(false)
  })

  it('does not match multi-question asks even with the reserved header', () => {
    expect(isFollowupsAsk(questionsAsk(q(), q({ header: '其他' })))).toBe(false)
  })

  it('does not match permission asks', () => {
    expect(isFollowupsAsk({ kind: 'permission', toolName: 'write', preview: '/tmp/x' })).toBe(false)
  })
})

describe('askUser followups conversion', () => {
  it('converts a closing-card ask into an immediate deferred decision without parking', async () => {
    const { e, state, p } = armedState()

    const decision = await e.askUser('test:chat:user1', questionsAsk(q()))

    // The tool result defers: no selection, a notice naming the new-message flow.
    expect(decision.answers).toHaveLength(1)
    expect(decision.answers?.[0]?.selected).toEqual([])
    expect(decision.answers?.[0]?.id).toBe('后续处理哪些？')
    expect(decision.answers?.[0]?.custom).toContain('新消息')
    // The notice must also tell the model not to restate it: the suggestion
    // card already explains the flow to the user, so a restating reply
    // delivers the same information twice.
    expect(decision.answers?.[0]?.custom).toContain('复述')
    // No card at ask time — the suggestion card rides the turn-end emission.
    expect(p.sentCards).toHaveLength(0)
    // The turn is not parked.
    expect(state.pendingAsk).toBeUndefined()
    expect(state.capParkStart).toBe(0)
    // The followups are registered for turn-end emission.
    expect(state.pendingFollowups).toEqual(q())
  })

  it('still parks a genuine multi-select question ask', async () => {
    const { e, state, p } = armedState()
    const request = questionsAsk(q({
      header: '范围',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    }))

    const decision = e.askUser('test:chat:user1', request)
    await new Promise((r) => { setTimeout(r, 10) })

    expect(state.pendingAsk).toBeDefined()
    expect(p.sentCards).toHaveLength(1)
    expect(state.pendingFollowups).toBeUndefined()

    // Settle the parked ask so the dangling promise resolves.
    const handled = e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')
    expect(handled).toBe(true)
    await expect(decision).resolves.toBeDefined()
  })
})

describe('askUser followups conversion: pre-ask reply segment render', () => {
  /** A started streaming preview whose handle carries an export key (recall.spec pattern). */
  function startedPreview(p: Platform): StreamPreview {
    const cfg = { enabled: true, intervalMs: 0, minDeltaChars: 0, maxChars: 500 }
    const starter = Object.assign(p, {
      async sendPreviewStart(): Promise<unknown> {
        return { messageID: 'om_card1', exportKey: () => 'om_card1' }
      },
      async updateMessage(): Promise<void> {},
      async deletePreviewMessage(): Promise<void> {},
    })
    return newStreamPreview(cfg, starter, 'ctx', undefined, undefined, 'test:chat:user1')
  }

  /** Engine + state with plan render armed and a preview showing `analysis`. */
  async function renderArmedState(
    analysis: string,
  ): Promise<{ e: Engine; state: InteractiveState; p: ReturnType<typeof createStubMediaPlatform> }> {
    const p = createStubMediaPlatform('feishu')
    const e = new Engine('test', createRenderAgent(), [p], '', 'zh')
    e.planRenderEnabled = true
    e.planRenderProvider = 'p'
    e.planRenderSkillSource = () => Promise.resolve(renderSkillBodyFixture())
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    const sp = startedPreview(p)
    await sp.showPlaceholder('处理中')
    if (analysis !== '') await sp.appendAnalysisText(analysis)
    state.preview = sp
    e.interactiveStates.set('test:chat:user1', state)
    return { e, state, p }
  }

  it('renders and delivers the pre-ask reply segment like the parked path', async () => {
    const summary = `收尾总结：全部完成。${'详细内容。'.repeat(100)}`
    const { e, state, p } = await renderArmedState(summary)

    const decision = await e.askUser('test:chat:user1', questionsAsk(q()))

    // The conversion itself is unchanged: deferred decision, no park.
    expect(decision.answers?.[0]?.selected).toEqual([])
    expect(state.pendingAsk).toBeUndefined()
    // The pre-ask reply segment renders and delivers (the trailing-segment
    // replacement after the ask would otherwise swallow it).
    await pollUntil(() => p.files.length > 0, 2000)
    expect(p.files).toHaveLength(1)
    // The capture also registered the segment under the card's export key.
    expect(state.exportContent?.get('om_card1')).toContain('收尾总结')
  })

  it('does not render below the speculative-render length threshold', async () => {
    const { e, state, p } = await renderArmedState('简短收尾。')

    await e.askUser('test:chat:user1', questionsAsk(q()))

    await new Promise((r) => { setTimeout(r, 300) })
    expect(p.files).toHaveLength(0)
    expect(state.preRenderRunning).toBe(false)
  })

  it('does not render when plan render is disabled', async () => {
    const summary = `收尾总结：全部完成。${'详细内容。'.repeat(100)}`
    const { e, p } = await renderArmedState(summary)
    e.planRenderEnabled = false

    await e.askUser('test:chat:user1', questionsAsk(q()))

    await new Promise((r) => { setTimeout(r, 300) })
    expect(p.files).toHaveLength(0)
  })

  it('returns the deferred decision without a live preview', async () => {
    const { e, state, p } = await renderArmedState('')
    state.preview = undefined

    const decision = await e.askUser('test:chat:user1', questionsAsk(q()))

    expect(decision.answers?.[0]?.selected).toEqual([])
    expect(state.pendingFollowups).toEqual(q())
    expect(p.files).toHaveLength(0)
  })
})

describe('sendFollowupsCard', () => {
  it('sends the blue suggestion card with the fw_multi checker form and clears the registry', async () => {
    const { e, state, p } = armedState()
    state.pendingFollowups = q({
      options: [
        { label: '修复 A', description: 'src/a.ts:1 空指针', recommended: true },
        { label: '暂不处理', description: '' },
      ],
    })

    await e.sendFollowupsCard(state, p, 'ctx', 'test:chat:user1')

    expect(p.sentCards).toHaveLength(1)
    const card = p.sentCards[0] as Card
    expect(card.header?.color).toBe('blue')
    expect(card.header?.title).toContain('后续处理')
    const check = card.elements.find(el => el.kind === 'checkOptions') as {
      kind: 'checkOptions'
      action?: string
      options: Array<{ label: string; description?: string; value?: string; checked?: boolean }>
    }
    expect(check).toBeDefined()
    expect(check.action).toBe('fw_multi:0')
    expect(check.options.map(o => o.label)).toEqual(['修复 A', '暂不处理'])
    // recommended options render pre-checked.
    expect(check.options[0]?.checked).toBe(true)
    expect(state.pendingFollowups).toBeUndefined()
  })

  it('no-ops when nothing is registered', async () => {
    const { e, state, p } = armedState()

    await e.sendFollowupsCard(state, p, 'ctx', 'test:chat:user1')

    expect(p.sentCards).toHaveLength(0)
  })

  it('drops the registry on card-less platforms without sending', async () => {
    const e = new Engine('test', createStubAgent(), [createStubPlatform('telegram')], '', 'zh')
    const state = new InteractiveState()
    state.pendingFollowups = q()
    const plain = createStubPlatform('telegram')

    await e.sendFollowupsCard(state, plain, 'ctx', 'telegram:u1')

    expect(state.pendingFollowups).toBeUndefined()
  })
})

/** Poll a predicate until it holds or the deadline passes (pump timing). */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 10) })
  }
}

describe('followups submission routing', () => {
  it('routeAskResponse never claims a followup submission, even with a parked ask', async () => {
    const { e, state, p } = armedState()
    const request = questionsAsk(q({
      header: '范围',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    }))
    const decision = e.askUser('test:chat:user1', request)
    await new Promise((r) => { setTimeout(r, 10) })
    expect(state.pendingAsk).toBeDefined()

    const fw = msg({ content: '[后续处理] 用户提交了选择：\n✅ A', isFollowupAction: true })
    expect(e.routeAskResponse(p, fw, fw.content)).toBe(false)
    expect(state.pendingAsk).toBeDefined()

    // Cleanup: settle the parked ask.
    e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')
    await expect(decision).resolves.toBeDefined()
  })

  it('a followup submission starts a fresh turn instead of answering the parked ask', async () => {
    const sess: ControllableAgentSession = newControllableSession('s1')
    sess.send = async (prompt: string, _images: ImageAttachment[], _files: FileAttachment[]) => {
      sess.sendCalls.push(prompt)
      sess.channel.push({ type: 'result', content: '处理完成', done: true })
    }
    const agent = createControllableAgent(sess)
    const p = createStubCardPlatform('feishu')
    const e = new Engine('test', agent, [p], '', 'zh')
    const key = 'test:chat:user1'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    // A parked ask implies a live turn: the state carries the agent session
    // the new turn reuses, and the session record knows its id (else the
    // turn-start recycles the state as a mismatch).
    state.agentSession = sess
    e.interactiveStates.set(key, state)
    e.sessions.getOrCreateActive(key).setAgentSessionID('s1', 'stub')

    // Park a genuine mid-turn question.
    const decision = e.askUser(key, questionsAsk(q({
      header: '范围',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    })))
    await new Promise((r) => { setTimeout(r, 10) })
    expect(state.pendingAsk).toBeDefined()

    const fw = msg({
      content: '[后续处理] 用户提交了选择：\n✅ 修复 A（src/a.ts:1 空指针）\n◻️ 暂不处理\n✍️ 附言',
      isFollowupAction: true,
    })
    e.receiveMessage(p, fw)

    await waitFor(() => sess.sendCalls.length === 1)
    expect(sess.sendCalls[0]).toContain('✅ 修复 A')
    expect(sess.sendCalls[0]).toContain('✍️ 附言')
    // The parked ask survived untouched — the submission answered nothing.
    expect(state.pendingAsk).toBeDefined()

    await waitFor(() => e.sessions.findActive(key)?.lastResult === '处理完成')
    void sess.close()

    // Cleanup: settle the parked ask.
    e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')
    await expect(decision).resolves.toBeDefined()
  })
})

describe('agent conventions prompt (followups contract)', () => {
  it('mandates the reserved header and the deferred-selection semantics', async () => {
    const { agentConventionsPrompt } = await import('../../src/engine/agent-conventions.ts')
    const prompt = agentConventionsPrompt()
    // The reserved header is the engine-side matcher's primary key: the
    // prompt must keep mandating it verbatim.
    expect(prompt).toContain(FOLLOWUPS_ASK_HEADER)
    // The deferred semantics: end the turn after registering; the selection
    // arrives as a new message and counts as authorization.
    expect(prompt).toContain('正常结束')
    expect(prompt).toContain('不要等待')
    expect(prompt).toContain('[后续处理]')
  })
})
