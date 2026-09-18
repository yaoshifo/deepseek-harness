/**
 * Plan-card shadow review: a parked plan card spawns ONE sibling group whose
 * session forks the origin transcript under plan mode and receives the review
 * prompt, with both directions linked through the sessions' featureState. A
 * shadow group never spawns its own, and a session spawns at most one.
 *
 * Either side settles the other — approving its plan, or acting in it at all:
 * the cases below drive the platform ingress (`handleInbound`) for a user action
 * and the parked card's own settlement for an approval, then observe the peer's
 * terminal mark, avatar phase, stopped session, and the notice it was told.
 *
 * @module dsh-feishu-bridge/tests-engine-plan-shadow
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState, type QueuedMessage } from '../../src/engine/engine.ts'
import { closePlanShadowOnTurnEnd, defaultPlanShadowPrompt, launchPlanShadow } from '../../src/engine/plan-shadow.ts'
import { spawnPlaceholderName } from '../../src/engine/groupname.ts'
import { Msg } from '../../src/i18n/index.ts'
import {
  createStubAgentSession,
  createStubChatroomSpawner,
  createStubPlatform,
  createWorkDirAgent,
  newControllableSession,
  newQueuingSession,
} from '../stubs/engine-stubs.ts'
import { ForkSessionPrefix, type Agent, type AskDecision, type GroupSpawnOptions, type Message } from '../../src/core/types.ts'

/** The review prompt these cases pin; the production default is asserted separately. */
const reviewPrompt = 'review this plan for a better one'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'feishu:oc_parent:ou_u',
    platform: 'feishu',
    messageID: '',
    userID: 'ou_u',
    userName: '',
    chatName: 'parent',
    chatType: 'group',
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

type SpawnerPlatform = ReturnType<typeof createStubChatroomSpawner>
type RecordingAgent = Agent & { started: string[] }

/** A work-dir agent recording the session id each startSession was asked for. */
function recordingAgent(): RecordingAgent {
  const started: string[] = []
  return {
    ...createWorkDirAgent('/w/repo'),
    started,
    startSession: async (sessionID: string) => {
      started.push(sessionID)
      return createStubAgentSession()
    },
  }
}

/** Engine whose platform can spawn groups, with the feature switched on. */
function newShadowEngine(): { e: Engine; p: SpawnerPlatform; agent: RecordingAgent } {
  const p = createStubChatroomSpawner('feishu')
  const agent = recordingAgent()
  const e = new Engine('test', agent, [p], '', 'en')
  e.setPlanShadow(true, reviewPrompt)
  return { e, p, agent }
}

/**
 * Put an already-built stub spawner on the Ex path (the one carrying spawn
 * options to the platform) and record what each spawn asked for.
 * @param p - The stub spawner to extend in place.
 * @returns Options per spawn request, in call order.
 */
function recordSpawnOptions(p: SpawnerPlatform): GroupSpawnOptions[] {
  const calls: GroupSpawnOptions[] = []
  Object.assign(p, {
    spawnGroupWithOptions: async (msg: Message, groupName: string, firstMsg: string, opts: GroupSpawnOptions) => {
      calls.push(opts)
      return p.spawnGroup(msg, groupName, firstMsg)
    },
  })
  return calls
}

/** Replace the chat's interactive state with a pristine one (as a restart would). */
function armState(e: Engine, p: SpawnerPlatform, key: string): InteractiveState {
  const state = new InteractiveState()
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  return state
}

/** A forkable, user-attributed session parked on a plan-review ask. */
function parkPlan(e: Engine, p: SpawnerPlatform, key: string, nativeID = 'agent-sid-1'): Promise<AskDecision> {
  const s = e.sessions.getOrCreateActive(key)
  s.setAgentSessionID(nativeID, 'dsh')
  s.setSpawnUserID('ou_u')
  armState(e, p, key)
  return e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\n1. step one' })
}

/** Wait until the ask actually parks (its cards are delivered asynchronously). */
async function parked(e: Engine, key: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (e.interactiveStates.get(key)?.pendingAsk !== undefined) return
    await new Promise((r) => { setTimeout(r, 5) })
  }
  throw new Error(`ask never parked (${key})`)
}

/** Settle a parked ask the short way. */
async function deny(e: Engine, p: SpawnerPlatform, key: string, decision: Promise<AskDecision>): Promise<void> {
  await parked(e, key)
  e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:deny', isPermissionAction: true }), 'perm:deny')
  await expect(decision).resolves.toEqual({ outcome: 'rejected' })
}

/** Let the fire-and-forget shadow launch land (or provably not land). */
async function settleLaunch(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => { setTimeout(r, 5) })
}

/** The `planShadow` section persisted on a session record. */
function section(e: Engine, key: string): Record<string, unknown> {
  const raw = e.sessions.getOrCreateActive(key).featureState['planShadow']
  return (raw ?? {}) as Record<string, unknown>
}

describe('PlanShadowSpawn', () => {
  it('a parked plan card spawns one shadow group forked from the session under plan mode', async () => {
    const { e, p, agent } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    e.sessions.getOrCreateActive(key).setName('parent chat')

    const decision = parkPlan(e, p, key)
    await settleLaunch()

    expect(p.count).toBe(1)
    expect(p.firstMsgs).toEqual([reviewPrompt])
    expect(p.groupNames).toEqual([`parent chat${e.i18n.t(Msg.PlanShadowNameSuffix)}`])
    // The child's session was started as a fork of the origin's native
    // session, not fresh.
    expect(agent.started).toContain(`${ForkSessionPrefix}agent-sid-1`)
    expect(e.sessions.getOrCreateActive('test:role-1').getInheritedMode()).toBe('plan')
    expect(section(e, key)['shadowSessionKey']).toBe('test:role-1')
    expect(section(e, 'test:role-1')['shadowOf']).toBe(key)
    // Only the origin chat is told why the group exists, on its jump card: the
    // shadow chat itself carries no explanation message, its name suffix and
    // that card already saying what it is.
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginNotice))
    expect(p.sent).toEqual([])

    await deny(e, p, key, decision)
  })

  it('names the origin chat as the spawn\'s avatar source', async () => {
    // The shadow is born named, so no naming pass ever stamps its icon: the
    // only face it can wear is the origin chat's.
    const { e, p } = newShadowEngine()
    const spawns = recordSpawnOptions(p)
    const key = 'feishu:oc_parent:ou_u'
    e.sessions.getOrCreateActive(key).setName('parent chat')

    const decision = parkPlan(e, p, key)
    await settleLaunch()

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.avatarFrom).toBe(key)

    await deny(e, p, key, decision)
  })

  it('a chat with no recorded name falls back to the rename placeholder', async () => {
    // The label falls back to the session key, and a raw key in the chat list
    // is worse than the placeholder the first-message rename replaces.
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_unnamed:ou_u'

    const decision = parkPlan(e, p, key)
    await settleLaunch()

    expect(p.groupNames).toEqual([spawnPlaceholderName(e.name, true)])
    await deny(e, p, key, decision)
  })

  it('a later plan card in the same session spawns no further shadow', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'

    await deny(e, p, key, parkPlan(e, p, key))
    expect(p.count).toBe(1)

    // A restarted interactive state must not re-arm the launch.
    armState(e, p, key)
    const second = e.askUser(key, { kind: 'plan-review', heading: '# P2', plan: '# P2\nsecond pass' })
    await parked(e, key)
    await settleLaunch()

    expect(p.count).toBe(1)
    await deny(e, p, key, second)
  })

  it('a shadow group never spawns a shadow of its own', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'

    await deny(e, p, originKey, parkPlan(e, p, originKey))
    expect(p.count).toBe(1)
    await settleLaunch()

    // The shadow's own plan card: forkable native id, real user, but a shadow.
    const shadowKey = 'test:role-1'
    const decision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)
    await settleLaunch()

    expect(p.count).toBe(1)
    await deny(e, p, shadowKey, decision)
  })

  it('a switched-off feature spawns nothing', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    e.setPlanShadow(false, reviewPrompt)

    await deny(e, p, key, parkPlan(e, p, key))
    await settleLaunch()

    expect(p.count).toBe(0)
    expect(section(e, key)['shadowSessionKey']).toBeUndefined()
  })

  it('an unattended (cron) plan spawns nothing: its sender is no group member', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_cron'
    const decision = parkPlan(e, p, key, 'cron-native')
    e.sessions.getOrCreateActive(key).setSpawnUserID('cron')

    await parked(e, key)
    await settleLaunch()

    expect(p.count).toBe(0)
    expect(section(e, key)['shadowSessionKey']).toBeUndefined()
    await deny(e, p, key, decision)
  })

  it('a plan card with no plan text spawns nothing', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const s = e.sessions.getOrCreateActive(key)
    s.setAgentSessionID('agent-sid-1', 'dsh')
    s.setSpawnUserID('ou_u')
    armState(e, p, key)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '', plan: '' })
    await parked(e, key)
    await settleLaunch()

    expect(p.count).toBe(0)
    await deny(e, p, key, decision)
  })

  it('a platform that cannot spawn groups is skipped without a trace', async () => {
    const p = createStubPlatform('plain')
    const e = new Engine('test', recordingAgent(), [p], '', 'en')
    e.setPlanShadow(true, reviewPrompt)
    const key = 'feishu:oc_parent:ou_u'
    const s = e.sessions.getOrCreateActive(key)
    s.setAgentSessionID('agent-sid-1', 'dsh')
    s.setSpawnUserID('ou_u')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\n1. step one' })
    await parked(e, key)
    await settleLaunch()

    expect(p.getSent().join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowOriginNotice))
    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:deny', isPermissionAction: true }), 'perm:deny')
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
  })

  it('a launch request without plan text spawns nothing', async () => {
    // The exported entry point is the public seam: a caller that omits the
    // plan — abort and invalidate do — must not reach the group spawner.
    const { e, p } = newShadowEngine()
    launchPlanShadow(e, p, { sessionKey: 'feishu:oc_parent:ou_u', replyCtx: 'ctx' })
    await settleLaunch()

    expect(p.count).toBe(0)
  })

  it('a launch for a chat with no session record spawns nothing', async () => {
    const { e, p } = newShadowEngine()
    launchPlanShadow(e, p, { sessionKey: 'feishu:oc_unknown:ou_u', replyCtx: 'ctx', plan: '# P' })
    await settleLaunch()

    expect(p.count).toBe(0)
  })

  it('a chat whose session never started spawns nothing', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    // No agent session id: there is no transcript to fork the review from.
    const s = e.sessions.getOrCreateActive(key)
    s.setSpawnUserID('ou_u')
    armState(e, p, key)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\n1. step one' })
    await parked(e, key)
    await settleLaunch()

    expect(p.count).toBe(0)
    await deny(e, p, key, decision)
  })

  it('a chat that is itself a fork spawns nothing', async () => {
    // A `/fk` group — and the shadow group before its link is written —
    // carries a fork sentinel id, and forking a fork is not a second opinion.
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_forked:ou_u'
    const s = e.sessions.getOrCreateActive(key)
    s.setAgentSessionID(`${ForkSessionPrefix}agent-sid-1`, 'dsh')
    s.setSpawnUserID('ou_u')
    armState(e, p, key)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\n1. step one' })
    await parked(e, key)
    await settleLaunch()

    expect(p.count).toBe(0)
    await deny(e, p, key, decision)
  })

  it('a failed group spawn leaves the pair unlinked and does not double-report', async () => {
    const base = createStubChatroomSpawner('feishu')
    const p = Object.assign(base, {
      spawnGroup: async (): Promise<Message> => { throw new Error('boom') },
    })
    const e = new Engine('test', recordingAgent(), [p], '', 'en')
    e.setPlanShadow(true, reviewPrompt)
    const key = 'feishu:oc_parent:ou_u'
    const s = e.sessions.getOrCreateActive(key)
    s.setAgentSessionID('agent-sid-1', 'dsh')
    s.setSpawnUserID('ou_u')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'plan-review', heading: '# P', plan: '# P\n1. step one' })
    await parked(e, key)
    await settleLaunch()

    // The shared spawn skeleton already told the origin chat; the shadow path
    // adds only its own bookkeeping (nothing) and, with the pair unlinked,
    // never sends into the child chat either.
    const sent = p.getSent().join('\n')
    expect(sent).toContain('boom')
    expect(section(e, key)['shadowSessionKey']).toBeUndefined()
    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:deny', isPermissionAction: true }), 'perm:deny')
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
  })
})

describe('PlanShadowAbort', () => {
  it('approving the origin plan stops and voids the shadow group', async () => {
    const { e, p } = newShadowEngine()
    const teardown = withTeardownRecorder(p)
    const key = 'feishu:oc_parent:ou_u'

    const decision = parkPlan(e, p, key)
    await settleLaunch()
    expect(p.count).toBe(1)

    // The shadow group, busy on its own turn.
    const shadowKey = 'test:role-1'
    const shadowSession = newControllableSession('shadow-live')
    let cancelled = 0
    shadowSession.cancelTurn = () => { cancelled++ }
    const shadowState = armState(e, p, shadowKey)
    shadowState.agentSession = shadowSession
    shadowState.replyCtx = 'shadow-ctx'

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    // The terminal state is committed before the stop (late repaints must see
    // the done mark), then the shadow's turn is aborted and the group told.
    expect(teardown.calls.filter(c => c.includes(shadowKey)))
      .toEqual([`done:${shadowKey}`, `phase:${shadowKey}:done`])
    expect(cancelled).toBe(1)
    expect(shadowState.userStopped).toBe(true)
    expect(e.interactiveStates.has(shadowKey)).toBe(false)
    expect(p.sent.join('\n')).toContain(e.i18n.t(Msg.PlanShadowAborted))
  })

  it('an approval with no shadow launched settles on its own', async () => {
    const { e, p } = newShadowEngine()
    const teardown = withTeardownRecorder(p)
    const key = 'feishu:oc_parent:ou_u'
    e.setPlanShadow(false, reviewPrompt)

    const decision = parkPlan(e, p, key)
    await parked(e, key)
    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(teardown.calls).toEqual([`phase:${key}:plan-review`, `phase:${key}:approved`])
    expect(p.sent.join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowAborted))
  })

  it('aborting a shadow with no live state addresses it through reconstruction', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, key)
    await settleLaunch()
    const shadowKey = 'test:role-1'
    // The shadow's turn is gone (reaped, reset): only the platform can still
    // address its chat.
    e.interactiveStates.delete(shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(p.getSent().join('\n')).toContain(e.i18n.t(Msg.PlanShadowAborted))
  })

  it('a platform that cannot reconstruct reply contexts skips the void notice', async () => {
    const p = createStubChatroomSpawner('feishu')
    delete (p as { reconstructReplyCtx?: unknown }).reconstructReplyCtx
    const teardown = withTeardownRecorder(p)
    const e = new Engine('test', recordingAgent(), [p], '', 'en')
    e.setPlanShadow(true, reviewPrompt)
    const key = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, key)
    await settleLaunch()
    e.interactiveStates.delete('test:role-1')

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    // The void still lands on the chat; only its notice is undeliverable.
    expect(teardown.calls).toContain('done:test:role-1')
    expect(p.getSent().join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowAborted))
  })

  it('a throwing reply-context reconstruction skips the void notice', async () => {
    const p = createStubChatroomSpawner('feishu')
    p.reconstructReplyCtx = async (_sessionKey: string): Promise<string> => { throw new Error('ctx lookup down') }
    const teardown = withTeardownRecorder(p)
    const e = new Engine('test', recordingAgent(), [p], '', 'en')
    e.setPlanShadow(true, reviewPrompt)
    const key = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, key)
    await settleLaunch()
    e.interactiveStates.delete('test:role-1')

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    // A reconstruction that throws degrades the same way a missing one does:
    // the group settles, only the notice has nowhere to land.
    expect(teardown.calls).toContain('done:test:role-1')
    expect(p.getSent().join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowAborted))
  })

  it('a failing dim does not block the shadow teardown', async () => {
    const base = createStubChatroomSpawner('feishu')
    const p = Object.assign(base, {
      markSpawnedChatDone: async (): Promise<void> => { throw new Error('dim down') },
    })
    const e = new Engine('test', recordingAgent(), [p], '', 'en')
    e.setPlanShadow(true, reviewPrompt)
    const key = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, key)
    await settleLaunch()
    const shadowState = armState(e, p, 'test:role-1')

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(shadowState.userStopped).toBe(true)
    expect(p.getSent().join('\n')).toContain(e.i18n.t(Msg.PlanShadowAborted))
  })
})

describe('PlanShadowOriginInvalidation', () => {
  it('approving the shadow plan closes the origin group and voids its parked card', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    // The origin parks a second card (no second shadow), the shadow parks its own.
    const originState = armState(e, p, originKey)
    const originSecond = e.askUser(originKey, { kind: 'plan-review', heading: '# P2', plan: '# P2\norigin second' })
    await parked(e, originKey)
    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    // The origin's parked card is voided with its turn, not merely un-parked:
    // a cancelled exit_plan_mode alone would let the origin plan again.
    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(originState.userStopped).toBe(true)
    expect(originState.pendingAsk).toBeUndefined()

    // The superseded origin group is closed the way /done closes one: the grey
    // mark commits before the stop, so the origin's own stopped ask cannot
    // repaint the avatar back to a baseline phase afterwards.
    expect(teardown.calls).toContain(`done:${originKey}`)
    expect(teardown.calls.indexOf(`done:${originKey}`))
      .toBeLessThan(teardown.calls.indexOf(`phase:${originKey}:done`))
    const afterClose = teardown.calls.slice(teardown.calls.indexOf(`phase:${originKey}:done`) + 1)
    expect(afterClose.filter(c => c.startsWith(`phase:${originKey}:`))).toEqual([])

    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginSuperseded))
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
    expect(jumpButtonURLs(p)).toContain('https://applink.feishu.cn/client/chat/open?openChatId=role-1')
  })

  it('closes a busy origin too: whichever side acts wins outright', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    // The origin went back to work on something else: a live turn, no plan
    // card parked. The settlement owns the pair, so that turn dies with it.
    const originState = armState(e, p, originKey)
    originState.activeTurns = 1

    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(teardown.calls).toContain(`done:${originKey}`)
    expect(teardown.calls).toContain(`phase:${originKey}:done`)
    expect(originState.userStopped).toBe(true)
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginSuperseded))
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
  })

  it('closes an origin parked on another ask, voiding that ask with its turn', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    // The origin is idle but for a question of its own: parked work is still
    // work, and the whole session goes with the close.
    const originState = armState(e, p, originKey)
    void e.askUser(originKey, {
      kind: 'questions',
      questions: [{ question: '继续吗？', header: '问', options: [], multiSelect: false }],
    })
    await parked(e, originKey)

    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)
    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(teardown.calls).toContain(`done:${originKey}`)
    expect(originState.userStopped).toBe(true)
    expect(originState.pendingAsk).toBeUndefined()
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginSuperseded))
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
  })

  it('an origin the platform does not track is voided without a close', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p, 'untracked')
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    const originState = armState(e, p, originKey)
    const originSecond = e.askUser(originKey, { kind: 'plan-review', heading: '# P2', plan: '# P2\norigin second' })
    await parked(e, originKey)
    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    // A main group or a p2p chat has no avatar axis to grey: its parked card
    // still voids with its turn, and the notice claims nothing beyond that.
    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(originState.userStopped).toBe(true)
    expect(teardown.calls).not.toContain(`done:${originKey}`)
    expect(teardown.calls).not.toContain(`phase:${originKey}:done`)
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginSuperseded))
    expect(cardTexts(p)).not.toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
  })

  it('an origin already closed is not closed again', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p, 'closed')
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    const originState = armState(e, p, originKey)
    const originSecond = e.askUser(originKey, { kind: 'plan-review', heading: '# P2', plan: '# P2\norigin second' })
    await parked(e, originKey)
    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    // The group already carries its done mark: re-closing would grey a group
    // the user may have woken since, and a second notice would only repeat
    // what the first settlement said, so the card voids on its own.
    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(originState.userStopped).toBe(true)
    expect(teardown.calls).not.toContain(`done:${originKey}`)
    expect(teardown.calls).not.toContain(`phase:${originKey}:done`)
    expect(cardTexts(p)).not.toContain(e.i18n.t(Msg.PlanShadowOriginSuperseded))
    expect(cardTexts(p)).not.toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
  })

  it('a settlement notice that cannot be sent does not undo the close', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    const originState = armState(e, p, originKey)
    const originSecond = e.askUser(originKey, { kind: 'plan-review', heading: '# P2', plan: '# P2\norigin second' })
    await parked(e, originKey)
    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)
    // The notice's jump link cannot be built: the failure stays inside the
    // fire-and-forget settlement, which must leave the close it already
    // committed in place and reach nobody's error handler.
    Object.assign(p, { chatJumpURL: (): string => { throw new Error('no link') } })

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(teardown.calls).toContain(`done:${originKey}`)
    expect(originState.userStopped).toBe(true)
  })

  it('closing the origin leaves its own child groups alone', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    // A child subtask group of the origin, with live state and a worktree: the
    // close is /done-shaped but owns no subtree, so neither may be touched.
    const childKey = 'feishu:oc_child:ou_u'
    const childSession = e.sessions.getOrCreateActive(childKey)
    childSession.setParentSessionKey(originKey)
    childSession.setWorktreeInfo('/w/child', 'cc/child', 'dev', '/w/repo', 'dev')
    const childState = armState(e, p, childKey)

    const originState = armState(e, p, originKey)
    const originSecond = e.askUser(originKey, { kind: 'plan-review', heading: '# P2', plan: '# P2\norigin second' })
    await parked(e, originKey)
    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(teardown.calls).toContain(`done:${originKey}`)
    expect(teardown.calls.filter(c => c.includes(childKey))).toEqual([])
    expect(childState.userStopped).toBe(false)
    expect(childSession.getWorktreeInfo()[0]).toBe('/w/child')
    // The origin itself is the one that settles.
    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(originState.userStopped).toBe(true)
  })
})

describe('PlanShadowPeerInput', () => {
  it('a message in the origin closes the shadow group on the spot', async () => {
    const { e, p } = newShadowEngine()
    const teardown = withTeardownRecorder(p)
    const key = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, key)
    await settleLaunch()
    expect(p.count).toBe(1)

    // The shadow group, busy on its own review turn.
    const shadowKey = 'test:role-1'
    const shadowSession = newControllableSession('shadow-live')
    let cancelled = 0
    shadowSession.cancelTurn = () => { cancelled++ }
    const shadowState = armState(e, p, shadowKey)
    shadowState.agentSession = shadowSession
    shadowState.replyCtx = 'shadow-ctx'

    e.handleInbound(p, msg({ sessionKey: key, content: '先别推了，我改主意了' }))
    await settleLaunch()

    // Closing the review group the /done way: the grey mark commits before the
    // stop, and the review turn running in there dies with it.
    expect(teardown.calls.filter(c => c.includes(shadowKey)))
      .toEqual([`done:${shadowKey}`, `phase:${shadowKey}:done`])
    expect(cancelled).toBe(1)
    expect(shadowState.userStopped).toBe(true)
    expect(p.sent.join('\n')).toContain(e.i18n.t(Msg.PlanShadowAbortedOnInput))
    // The side the user typed in keeps its own parked plan card.
    expect(e.interactiveStates.get(key)?.pendingAsk).toBeDefined()

    await deny(e, p, key, decision)
  })

  it('a message in the review group voids the origin card and closes the origin', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    // A second origin card stays parked while the review group is talked to.
    const originState = armState(e, p, originKey)
    const originSecond = e.askUser(originKey, { kind: 'plan-review', heading: '# P2', plan: '# P2\norigin second' })
    await parked(e, originKey)

    e.handleInbound(p, msg({ sessionKey: 'test:role-1', content: '改成方案 B 吧' }))
    await settleLaunch()

    // The parked card voids with its turn — a cancelled exit_plan_mode alone
    // would let the origin plan again — and the group is greyed the /done way.
    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(originState.userStopped).toBe(true)
    expect(teardown.calls).toContain(`done:${originKey}`)
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginSupersededOnInput))
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
    expect(jumpButtonURLs(p)).toContain('https://applink.feishu.cn/client/chat/open?openChatId=role-1')
  })

  it('a slash command or a query button is housekeeping, not an action on the pair', async () => {
    // Checking on a chat must not spend the other side's work.
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const teardown = withTeardownRecorder(p)
    const decision = parkPlan(e, p, key)
    await settleLaunch()

    e.handleInbound(p, msg({ sessionKey: key, content: '/status' }))
    e.handleInbound(p, msg({ sessionKey: key, content: '', isCardAction: true, extraContent: 'act:list:2' }))
    await settleLaunch()

    expect(reviewGroupCalls(teardown)).toEqual([])
    expect(p.sent.join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowAbortedOnInput))
    await deny(e, p, key, decision)
  })

  it('the review prompt\'s own injected first message never settles the pair', async () => {
    // The spawn feeds the prompt through receiveMessage, not the platform
    // surface: reading it as user input would close the origin the moment the
    // review group is born.
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const teardown = withTeardownRecorder(p)
    const decision = parkPlan(e, p, key)
    await settleLaunch()
    expect(p.count).toBe(1)

    e.receiveMessage(p, msg({ sessionKey: 'test:role-1', content: e.planShadowPrompt, isSpawnedGroup: true }))
    await settleLaunch()

    expect(reviewGroupCalls(teardown)).toEqual([])
    await deny(e, p, key, decision)
  })

  it('a machine wake is not the user acting', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const teardown = withTeardownRecorder(p)
    const decision = parkPlan(e, p, key)
    await settleLaunch()

    // A subtask report or a gather wake arrives as a synthetic injection. It
    // replaces the parked ask's whole interactive state on its way in (a wake
    // into a plan-parked group orphans that card — unrelated to this pair), so
    // the case pins the settlement only: no close, and no notice either way.
    e.deliverMachineMessage(p, msg({ sessionKey: key, content: '子任务完成', machine: true }))
    await settleLaunch()

    expect(reviewGroupCalls(teardown)).toEqual([])
    expect(p.sent.join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowAbortedOnInput))
    void decision
  })

  it('settles once per pair: later messages never re-close or re-tell', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const teardown = withTeardownRecorder(p)
    const decision = parkPlan(e, p, key)
    await settleLaunch()

    e.handleInbound(p, msg({ sessionKey: key, content: '先别推了' }))
    await settleLaunch()
    const notice = e.i18n.t(Msg.PlanShadowAbortedOnInput)
    const shadowCalls = (): string[] => teardown.calls.filter(c => c.includes('test:role-1'))
    expect(shadowCalls()).toHaveLength(2)
    expect(countOf(p.sent.join('\n'), notice)).toBe(1)

    // Talking on in the origin, and waking the review group, change nothing.
    e.handleInbound(p, msg({ sessionKey: key, content: '再说一句' }))
    e.handleInbound(p, msg({ sessionKey: 'test:role-1', content: '你好' }))
    await settleLaunch()

    expect(shadowCalls()).toHaveLength(2)
    expect(countOf(p.sent.join('\n'), notice)).toBe(1)
    await deny(e, p, key, decision)
  })

  it('a review group born after the origin settled is closed on arrival', async () => {
    // Group creation takes a moment; the user can answer the plan card in that
    // window, and the pair settlement then finds no peer to close yet — which
    // would leave the review group alive for a decision already made.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const base = createStubChatroomSpawner('feishu')
    const slowSpawn = base.spawnGroup.bind(base)
    const p = Object.assign(base, {
      spawnGroup: async (m: Message, name: string, first: string) => {
        await gate
        return slowSpawn(m, name, first)
      },
    })
    const teardown = withTeardownRecorder(p)
    const e = new Engine('test', recordingAgent(), [p], '', 'en')
    e.setPlanShadow(true, reviewPrompt)
    const key = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, key)
    await parked(e, key)

    e.routeAskResponse(p, msg({ sessionKey: key, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()
    // No link was written yet, so the approval settled nothing.
    expect(section(e, key)['shadowSessionKey']).toBeUndefined()

    release()
    await settleLaunch()

    expect(reviewGroupCalls(teardown)).toEqual(['done:test:role-1', 'phase:test:role-1:done'])
    expect(p.sent.join('\n')).toContain(e.i18n.t(Msg.PlanShadowAbortedOnInput))
  })

  it('a review group already closed is left alone when the origin acts', async () => {
    const { e, p } = newShadowEngine()
    const key = 'feishu:oc_parent:ou_u'
    const teardown = withTeardownRecorder(p)
    const decision = parkPlan(e, p, key)
    await settleLaunch()

    // The review group already carries its terminal mark — a `/done` by hand,
    // or an earlier settlement — and may have been woken since.
    Object.assign(p, {
      isSpawnedChatDone: (sessionKey: string) => sessionKey === 'test:role-1',
      isSpawnedChatActive: () => false,
    })

    e.handleInbound(p, msg({ sessionKey: key, content: '先别推了' }))
    await settleLaunch()

    expect(reviewGroupCalls(teardown)).toEqual([])
    expect(p.sent.join('\n')).not.toContain(e.i18n.t(Msg.PlanShadowAbortedOnInput))
    await deny(e, p, key, decision)
  })
})

describe('PlanShadowTurnEnd', () => {
  it('the review group\'s own finished turn closes it, leaving the origin\'s card approvable', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    expect(p.count).toBe(1)
    const shadowKey = 'test:role-1'
    // Attached after the spawn: this ledger holds only what the review turn's
    // own end does.
    const teardown = withCloseRecorder(p)

    // The review concluded without submitting another plan: a real turn whose
    // result event arrives after the prompt.
    const reviewSession = newQueuingSession('shadow-review')
    const shadowState = armState(e, p, shadowKey)
    shadowState.agentSession = reviewSession
    reviewSession.channel.push({ type: 'result', content: '原方案已是最优', done: true })
    await e.processInteractiveEvents(
      shadowState, e.sessions.getOrCreateActive(shadowKey), e.sessions, shadowKey, 'm1', undefined, shadowState.replyCtx,
    )
    await settleLaunch()

    // The review concluded where it stood: greyed the /done way (the mark
    // before the stop), and its session stopped.
    expect(teardown.calls).toEqual([
      `phase:${shadowKey}:discussing`,
      `done:${shadowKey}`,
      `phase:${shadowKey}:done`,
    ])
    expect(shadowState.userStopped).toBe(true)
    expect(e.interactiveStates.has(shadowKey)).toBe(false)

    // The origin is a different chat that decided nothing: untouched state,
    // and its parked plan card still decides.
    const originState = e.interactiveStates.get(originKey)
    expect(originState?.userStopped).toBe(false)
    expect(originState?.pendingAsk).toBeDefined()
    e.routeAskResponse(p, msg({ sessionKey: originKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })

  it('a settled pair is not closed by a turn end either', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    const shadowKey = 'test:role-1'
    // A ledger without the spawned-chat signals: this case pins the settled
    // guard, not the done-mark one.
    const teardown = withTeardownRecorder(p)

    // The user acted in the origin: the pair is settled and the review group
    // already closed by that settlement.
    e.handleInbound(p, msg({ sessionKey: originKey, content: '先别推了' }))
    await settleLaunch()
    expect(section(e, shadowKey)['settled']).toBe(true)
    teardown.calls.length = 0

    // The user wakes the closed group and its review turn ends: the pair's
    // decision is spent, so this turn end closes nothing.
    const shadowState = armState(e, p, shadowKey)
    closePlanShadowOnTurnEnd(e, p, shadowKey, { errored: false, background: false, queued: false })
    await settleLaunch()

    expect(teardown.calls).toEqual([])
    expect(shadowState.userStopped).toBe(false)
    await deny(e, p, originKey, decision)
  })

  it('an errored review turn closes nothing', async () => {
    // A failed turn needs the user's eyes on the group, not a close.
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    const shadowKey = 'test:role-1'
    expect(section(e, shadowKey)['shadowOf']).toBe(originKey)
    const teardown = withCloseRecorder(p)
    const shadowState = armState(e, p, shadowKey)

    closePlanShadowOnTurnEnd(e, p, shadowKey, { errored: true, background: false, queued: false })
    await settleLaunch()

    expect(teardown.calls).toEqual([])
    expect(shadowState.userStopped).toBe(false)
    await deny(e, p, originKey, decision)
  })

  it('a reader-woken background turn closes nothing', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    const shadowKey = 'test:role-1'
    expect(section(e, shadowKey)['shadowOf']).toBe(originKey)
    const teardown = withCloseRecorder(p)
    const shadowState = armState(e, p, shadowKey)

    closePlanShadowOnTurnEnd(e, p, shadowKey, { errored: false, background: true, queued: false })
    await settleLaunch()

    expect(teardown.calls).toEqual([])
    expect(shadowState.userStopped).toBe(false)
    await deny(e, p, originKey, decision)
  })

  it('a turn that handed over to a queued message closes nothing, and the queue takes over', async () => {
    const { e, p } = newShadowEngine()
    // The merge window would only slow the takeover down; the case is about
    // the queued turn, not about merging.
    e.setDebounceInterval(0)
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    const shadowKey = 'test:role-1'
    expect(section(e, shadowKey)['shadowOf']).toBe(originKey)
    const teardown = withCloseRecorder(p)

    const reviewSession = newQueuingSession('shadow-review')
    const shadowState = armState(e, p, shadowKey)
    shadowState.agentSession = reviewSession
    shadowState.pendingMessages = [queuedShadowMsg(p, shadowKey, '排队再说一句')]
    reviewSession.channel.push({ type: 'result', content: '原方案已是最优', done: true })

    const loop = e.processInteractiveEvents(
      shadowState, e.sessions.getOrCreateActive(shadowKey), e.sessions, shadowKey, 'm1', undefined, shadowState.replyCtx,
    )
    // The queued message drained into a live turn — the group is still
    // working, so this turn end closed nothing. Waiting for the queued prompt
    // to reach the session also proves the drain ran, so the channel is free
    // for the queued turn's own result.
    await waitUntil(() => reviewSession.sendCalls.some(text => text.includes('排队再说一句')))
    expect(teardown.calls.some(call => call.startsWith('done:'))).toBe(false)
    expect(shadowState.userStopped).toBe(false)

    // The queued turn's own end is a turn end like any other: the group closes.
    reviewSession.channel.push({ type: 'result', content: '排队轮也完成', done: true })
    await loop
    expect(teardown.calls.slice(-2)).toEqual([`done:${shadowKey}`, `phase:${shadowKey}:done`])
    await deny(e, p, originKey, decision)
  })

  it('a review group already carrying its terminal mark is left alone', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    const shadowKey = 'test:role-1'
    const teardown = withCloseRecorder(p)
    const shadowState = armState(e, p, shadowKey)
    // A `/done` by hand, or an earlier settlement, committed the mark; the
    // user may have woken the greyed group since, and greying it again is
    // exactly what the mark's freeze exists to prevent.
    await e.markSpawnedChatDone(p, shadowKey)
    const before = [...teardown.calls]

    closePlanShadowOnTurnEnd(e, p, shadowKey, { errored: false, background: false, queued: false })
    await settleLaunch()

    expect(teardown.calls).toEqual(before)
    expect(shadowState.userStopped).toBe(false)
    await deny(e, p, originKey, decision)
  })

  it('a turn ending in a chat outside a pair closes nothing', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const decision = parkPlan(e, p, originKey)
    await settleLaunch()
    const teardown = withCloseRecorder(p)

    // The pair's origin side: its record names the review group instead of
    // being one, so it is never the chat this trigger closes.
    const childKey = 'feishu:oc_child:ou_u'
    const mainKey = 'feishu:oc_main:ou_u'
    const absentKey = 'feishu:oc_absent:ou_u'
    e.sessions.getOrCreateActive(childKey).setParentSessionKey(originKey)
    for (const key of [childKey, mainKey]) {
      e.sessions.getOrCreateActive(key)
      armState(e, p, key)
      closePlanShadowOnTurnEnd(e, p, key, { errored: false, background: false, queued: false })
    }
    closePlanShadowOnTurnEnd(e, p, originKey, { errored: false, background: false, queued: false })
    // A chat with no session record at all cannot be in a pair either.
    closePlanShadowOnTurnEnd(e, p, absentKey, { errored: false, background: false, queued: false })
    await settleLaunch()

    expect(teardown.calls).toEqual([])
    for (const key of [childKey, mainKey, originKey]) {
      expect(e.interactiveStates.get(key)?.userStopped).toBe(false)
    }
    expect(e.interactiveStates.get(originKey)?.pendingAsk).toBeDefined()
    await deny(e, p, originKey, decision)
  })
})

/** The teardown calls that landed on the review group (the origin paints its own plan-review phase). */
function reviewGroupCalls(rec: { calls: string[] }): string[] {
  return rec.calls.filter(c => c.includes('test:role-1'))
}

/** How many times `needle` occurs in `haystack` (notice-repetition checks). */
function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** Every card content string recorded by the platform, joined. */
function cardTexts(p: SpawnerPlatform): string {
  const parts: string[] = []
  for (const card of p.sentCards as Array<{ elements: Array<{ kind: string; content?: string }> }>) {
    for (const el of card.elements) if (typeof el.content === 'string') parts.push(el.content)
  }
  return parts.join('\n')
}

/** Order recorder for the shadow teardown calls. */
function withTeardownRecorder(p: SpawnerPlatform): SpawnerPlatform & { calls: string[] } {
  const calls: string[] = []
  return Object.assign(p, {
    calls,
    markSpawnedChatDone: async (sessionKey: string) => { calls.push(`done:${sessionKey}`) },
    setChatPhase: async (sessionKey: string, phase: string) => { calls.push(`phase:${sessionKey}:${phase}`) },
  })
}

/**
 * Teardown recorder plus the spawned-chat signals a close reads, modelling the
 * platform store: a chat stays active until a done mark lands on it, and the
 * marks are per chat. `untracked` is a chat the platform does not track (a main
 * group, a p2p chat); `closed` is one already carrying its done mark.
 */
function withCloseRecorder(
  p: SpawnerPlatform,
  state: 'live' | 'closed' | 'untracked' = 'live',
): SpawnerPlatform & { calls: string[] } {
  const rec = withTeardownRecorder(p)
  const isDone = (sessionKey: string): boolean => state === 'closed' || rec.calls.includes(`done:${sessionKey}`)
  return Object.assign(rec, {
    chatBasePhase: () => 'discussing',
    isSpawnedChatActive: (sessionKey: string) => state === 'live' && !isDone(sessionKey),
    isSpawnedChatDone: isDone,
  })
}

/** One queued message for a chat, shaped as the platform ingress queues it. */
function queuedShadowMsg(p: SpawnerPlatform, sessionKey: string, content: string): QueuedMessage {
  return {
    platform: p,
    replyCtx: 'ctx',
    messageID: '',
    content,
    images: [],
    files: [],
    fromVoice: false,
    isSpawnedGroup: false,
    userID: 'ou_u',
    userName: '',
    msgPlatform: 'feishu',
    msgSessionKey: sessionKey,
    metadata: undefined,
  }
}

/** Wait until `cond` holds; throws instead of hanging the case on a stalled turn. */
async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return
    await new Promise((r) => { setTimeout(r, 5) })
  }
  throw new Error('condition never held')
}

/** Every button URL recorded across the platform's cards. */
function jumpButtonURLs(p: SpawnerPlatform): string[] {
  const urls: string[] = []
  for (const card of p.sentCards as Array<{ elements: Array<{ kind: string; buttons?: Array<{ url?: string }> }> }>) {
    for (const el of card.elements) {
      if (el.kind !== 'actions') continue
      for (const b of el.buttons ?? []) if (b.url !== undefined) urls.push(b.url)
    }
  }
  return urls
}

describe('PlanShadowPrompt', () => {
  it('ships the approved review prompt verbatim as the default', () => {
    // Model-visible text: pinned word for word, so a later "small wording
    // tweak" here is a deliberate change rather than a silent drift.
    expect(defaultPlanShadowPrompt).toBe(
      '对刚提交的方案做第二轮推敲：目标和范围都不变，只比做法本身——有没有更简单、更稳、更清晰的走法？\n'
      + '有实质改进就重新提交一份计划；没有就直说「原方案已是最优」并给一句理由。不要为了改而改，也不要顺手扩大范围。',
    )
    const p = createStubChatroomSpawner('feishu')
    expect(new Engine('test', recordingAgent(), [p], '', 'en').planShadowPrompt).toBe(defaultPlanShadowPrompt)
  })
})
