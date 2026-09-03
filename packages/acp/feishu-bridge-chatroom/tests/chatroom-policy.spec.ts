/**
 * The chatroom policy listeners: the chatroom halves of the
 * `feishuBridge/*` events, exercised through the production registration on
 * a real Cordis context (moved from the bridge's bridge-service,
 * engine-groupname, and session specs when the chatroom moved to this
 * package).
 *
 * @module dsh-feishu-bridge-chatroom/tests-chatroom-policy
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Engine,
  Session,
  ctxBridgeDispatch,
  type BridgeDispatch,
  type PendingAsk,
  type SessionStartOptions,
} from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomState } from '../src/chatroom-state.ts'
import { applyChatroomEngineConfig } from '../src/chatroom-config.ts'
import { registerChatroomPolicyListeners } from '../src/engine/chatroom-policy.ts'
import { createStubAgent } from './stubs/engine-stubs.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A dispatch face with the production chatroom policy listeners registered. */
function policyFace(): BridgeDispatch {
  const ctx = new Context()
  contexts.push(ctx)
  registerChatroomPolicyListeners(ctx)
  return ctxBridgeDispatch(ctx)
}

describe('permission and mode policy', () => {
  it('the persona listener joins the built-in subtask base on the waterfall', () => {
    const face = policyFace()
    expect(face.waterfall(
      'feishuBridge/permission-policy',
      { options: { sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: true, forceMode: undefined } } },
      () => false,
    )).toBe(true)
    expect(face.waterfall('feishuBridge/permission-policy', { options: undefined }, () => false)).toBe(false)
  })

  it('a forced persona mode overrides an inherited plan default', () => {
    const face = policyFace()
    expect(face.waterfall(
      'feishuBridge/mode-policy',
      { options: { sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: false, forceMode: 'default' } }, mode: 'plan' },
      () => 'plan',
    )).toBe('default')
    // No persona or no forced mode: the adapter-computed mode wins.
    expect(face.waterfall('feishuBridge/mode-policy', { options: undefined, mode: 'plan' }, () => 'plan')).toBe('plan')
    expect(face.waterfall(
      'feishuBridge/mode-policy',
      { options: { sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: false, forceMode: undefined } }, mode: 'plan' },
      () => 'plan',
    )).toBe('plan')
  })
})

describe('rename-exemption policy', () => {
  it('exempts chatroom roles, research assistants, and direct roles only', () => {
    const face = policyFace()
    const exempt = (session: Session): boolean =>
      face.waterfall('feishuBridge/rename-exemption', { session }, () => false)

    const role = new Session()
    chatroomState(role).chatroomHubKey = 'test:hub-1'
    expect(exempt(role)).toBe(true)

    const assistant = new Session()
    chatroomState(assistant).researchAssistant = true
    expect(exempt(assistant)).toBe(true)

    const direct = new Session()
    chatroomState(direct).chatroomDirectRole = true
    expect(exempt(direct)).toBe(true)

    expect(exempt(new Session())).toBe(false)
  })
})

describe('auto-render and background-session policy', () => {
  it('suppresses auto-render for chatroom role sessions, re-enabled by user takeover', () => {
    const face = policyFace()
    const suppress = (session: Session): boolean =>
      face.waterfall('feishuBridge/auto-render-policy', { session }, () => session.getSubtaskDepth() > 0)
    const background = (session: Session): boolean =>
      face.waterfall('feishuBridge/background-session-policy', { session }, () => session.getSubtaskDepth() > 0)

    const role = new Session()
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    expect(suppress(role)).toBe(true)
    expect(background(role)).toBe(true)

    role.setUserInterjected(true)
    // The caller applies the user-interjection re-enable around the policy.
    expect(suppress(role) && !role.getUserInterjected()).toBe(false)

    expect(suppress(new Session())).toBe(false)
    expect(background(new Session())).toBe(false)
  })
})

describe('chatroom seam events', () => {
  /** A parked questions ask stub the auto-default timer arms on. */
  function parkedAsk(): PendingAsk {
    return { request: { kind: 'questions', questions: [] }, answers: new Map(), resolve: () => {} }
  }

  it('ask-parked arms the research-manual timer only on a manual research moderator hub', () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')

    const hub = e.sessions.getOrCreateActive('test:hub:user-1')
    chatroomState(hub).chatroomModerator = true
    chatroomState(hub).chatroomResearch = true
    chatroomState(hub).chatroomResearchMode = 'manual'
    const armed = parkedAsk()
    face.emit('feishuBridge/ask-parked', { engine: e, platform: undefined as never, sessionKey: 'test:hub:user-1', replyCtx: 'ctx', pending: armed })
    expect(armed.autoTimer).toBeDefined()
    if (armed.autoTimer !== undefined) clearTimeout(armed.autoTimer)

    // Not a research-manual hub: nothing arms.
    const plain = parkedAsk()
    face.emit('feishuBridge/ask-parked', { engine: e, platform: undefined as never, sessionKey: 'test:plain:user-1', replyCtx: 'ctx', pending: plain })
    expect(plain.autoTimer).toBeUndefined()
  })

  it('subtask-dispatched marks an awaiting research role, and only that', () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')

    const role = e.sessions.getOrCreateActive('test:role:user-1')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    chatroomState(role).researchAwaitingAssistant = true
    face.emit('feishuBridge/subtask-dispatched', { engine: e, parentSessionKey: 'test:role:user-1' })
    expect(chatroomState(role).researchDispatched).toBe(true)

    // No awaiting assistant: the dispatch is not recorded.
    const idle = e.sessions.getOrCreateActive('test:idle:user-1')
    chatroomState(idle).chatroomHubKey = 'test:hub:user-1'
    face.emit('feishuBridge/subtask-dispatched', { engine: e, parentSessionKey: 'test:idle:user-1' })
    expect(chatroomState(idle).researchDispatched).toBe(false)
  })

  it('resolve-child-alias answers the assistant sentinel from the session, failing loud when unprovisioned', () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')

    const role = e.sessions.getOrCreateActive('test:role:user-1')
    chatroomState(role).researchAssistantKey = 'test:assistant-1'
    expect(face.waterfall(
      'feishuBridge/resolve-child-alias',
      { engine: e, callerSessionKey: 'test:role:user-1', alias: 'assistant' },
      () => '',
    )).toBe('test:assistant-1')

    expect(() => face.waterfall(
      'feishuBridge/resolve-child-alias',
      { engine: e, callerSessionKey: 'test:plain:user-1', alias: 'assistant' },
      () => '',
    )).toThrow('no pre-provisioned assistant')

    // Other aliases fall through to the base.
    expect(face.waterfall(
      'feishuBridge/resolve-child-alias',
      { engine: e, callerSessionKey: 'test:role:user-1', alias: 'other' },
      () => '',
    )).toBe('')
  })

  it('turn-start stamps the gather-round metadata only on chatroom-bound sessions', async () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')

    const role = e.sessions.getOrCreateActive('test:role:user-1')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    await face.serial('feishuBridge/turn-start', {
      engine: e,
      session: role,
      metadata: { chatroomAskSeq: 3, chatroomAwaitAssistant: true },
    })
    expect(chatroomState(role).chatroomAskSeq).toBe(3)
    expect(chatroomState(role).researchAwaitingAssistant).toBe(true)

    // A non-chatroom session is untouched.
    const plain = e.sessions.getOrCreateActive('test:plain:user-1')
    await face.serial('feishuBridge/turn-start', {
      engine: e,
      session: plain,
      metadata: { chatroomAskSeq: 3, chatroomAwaitAssistant: true },
    })
    expect(chatroomState(plain).chatroomAskSeq).toBe(0)
    expect(chatroomState(plain).researchAwaitingAssistant).toBe(false)
  })

  it('ask-approval auto-approves the plan review only inside the pick window', async () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')
    const request = { kind: 'plan-review', heading: '# P', plan: '# P' } as never

    // No picker armed: falls through to the base.
    expect(await face.waterfall(
      'feishuBridge/ask-approval',
      { engine: e, sessionKey: 'test:hub:user-1', request, signal: undefined },
      async () => undefined,
    )).toBeUndefined()
  })
})

describe('session-start-options decoration', () => {
  it('fills the research-assistant flag on the subtask section', () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')
    const assistant = e.sessions.getOrCreateActive('test:assistant-1')
    chatroomState(assistant).researchAssistant = true
    const options: SessionStartOptions = { sessionKey: 'test:assistant-1', subtask: { attended: false, noReport: false } }
    face.waterfall('feishuBridge/session-start-options', { engine: e, session: assistant, options }, () => {})
    expect(options.subtask?.researchAssistant).toBe(true)

    // A plain session's options pass through untouched.
    const plainOptions: SessionStartOptions = { sessionKey: 'test:plain', subtask: { attended: false, noReport: false } }
    face.waterfall('feishuBridge/session-start-options', { engine: e, session: e.sessions.getOrCreateActive('test:plain'), options: plainOptions }, () => {})
    expect(plainOptions.subtask?.researchAssistant).toBeUndefined()
  })

  it('injects the configured user background into role and moderator personas, not into research assistants', async () => {
    const face = policyFace()
    const dir = await mkdtemp(join(tmpdir(), 'fb-policy-profile-'))
    const profilePath = join(dir, 'user-profile.md')
    await writeFile(profilePath, '用户偏好数据先行。\n', 'utf8')

    const e = new Engine('test', createStubAgent(), [], '', 'en')
    applyChatroomEngineConfig(e, { userProfile: profilePath }, undefined)

    // Moderator hub: the direct/moderator branch builds its persona.
    const hub = e.sessions.getOrCreateActive('test:hub:user-1')
    chatroomState(hub).chatroomModerator = true
    const moderatorOptions: SessionStartOptions = { sessionKey: 'test:hub:user-1' }
    face.waterfall('feishuBridge/session-start-options', { engine: e, session: hub, options: moderatorOptions }, () => {})
    expect(moderatorOptions.persona?.prompt).toContain('## 用户背景')
    expect(moderatorOptions.persona?.prompt).toContain('用户偏好数据先行。')

    // Role: the hub branch builds its persona.
    const role = e.sessions.getOrCreateActive('test:role:user-1')
    chatroomState(role).chatroomHubKey = 'test:hub:user-1'
    const roleOptions: SessionStartOptions = { sessionKey: 'test:role:user-1' }
    face.waterfall('feishuBridge/session-start-options', { engine: e, session: role, options: roleOptions }, () => {})
    expect(roleOptions.persona?.prompt).toContain('用户偏好数据先行。')

    // Research assistant: the subtask section carries the flag, no persona.
    const assistant = e.sessions.getOrCreateActive('test:assistant-1')
    chatroomState(assistant).researchAssistant = true
    const assistantOptions: SessionStartOptions = { sessionKey: 'test:assistant-1', subtask: { attended: false, noReport: false } }
    face.waterfall('feishuBridge/session-start-options', { engine: e, session: assistant, options: assistantOptions }, () => {})
    expect(assistantOptions.persona).toBeUndefined()
    expect(assistantOptions.subtask?.researchAssistant).toBe(true)
  })
})

describe('hard-cap exemption', () => {
  it('answers research assistants and research-hub roles', () => {
    const face = policyFace()
    const e = new Engine('test', createStubAgent(), [], '', 'en')
    const role = e.sessions.getOrCreateActive('test:role')
    expect(face.waterfall('feishuBridge/hard-cap-exemption', { engine: e, session: role }, () => false)).toBe(false)
    const hub = e.sessions.getOrCreateActive('test:hub')
    chatroomState(hub).chatroomResearch = true
    chatroomState(role).chatroomHubKey = 'test:hub'
    expect(face.waterfall('feishuBridge/hard-cap-exemption', { engine: e, session: role }, () => false)).toBe(true)
    const assistant = e.sessions.getOrCreateActive('test:assistant')
    chatroomState(assistant).researchAssistant = true
    expect(face.waterfall('feishuBridge/hard-cap-exemption', { engine: e, session: assistant }, () => false)).toBe(true)
  })
})
