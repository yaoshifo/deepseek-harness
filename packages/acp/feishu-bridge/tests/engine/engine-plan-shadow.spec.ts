/**
 * Plan-card shadow review: a parked plan card spawns ONE sibling group whose
 * session forks the origin transcript under plan mode and receives the review
 * prompt, with both directions linked through the sessions' featureState. A
 * shadow group never spawns its own, and a session spawns at most one.
 *
 * @module dsh-feishu-bridge/tests-engine-plan-shadow
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { defaultPlanShadowPrompt } from '../../src/engine/plan-shadow.ts'
import { spawnPlaceholderName } from '../../src/engine/groupname.ts'
import { Msg } from '../../src/i18n/index.ts'
import {
  createStubAgentSession,
  createStubChatroomSpawner,
  createStubPlatform,
  createWorkDirAgent,
  newControllableSession,
} from '../stubs/engine-stubs.ts'
import { ForkSessionPrefix, type Agent, type AskDecision, type Message } from '../../src/core/types.ts'

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

  it('an origin busy with other work is told, not closed', async () => {
    const { e, p } = newShadowEngine()
    const originKey = 'feishu:oc_parent:ou_u'
    const teardown = withCloseRecorder(p)
    await deny(e, p, originKey, parkPlan(e, p, originKey))
    await settleLaunch()

    // The origin went back to work on something else: a live turn, no plan
    // card parked. Killing it to close the group would destroy that work.
    const originState = armState(e, p, originKey)
    originState.activeTurns = 1

    const shadowKey = 'test:role-1'
    const shadowDecision = parkPlan(e, p, shadowKey, 'shadow-native')
    await parked(e, shadowKey)

    e.routeAskResponse(p, msg({ sessionKey: shadowKey, content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(shadowDecision).resolves.toEqual({ outcome: 'allowed-once' })
    await settleLaunch()

    expect(teardown.calls).not.toContain(`done:${originKey}`)
    expect(teardown.calls).not.toContain(`phase:${originKey}:done`)
    expect(originState.userStopped).toBe(false)
    expect(cardTexts(p)).toContain(e.i18n.t(Msg.PlanShadowOriginSuperseded))
    expect(cardTexts(p)).not.toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
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
    // the user may have woken since, so the settlement only voids the card.
    await expect(originSecond).resolves.toEqual({ outcome: 'cancelled' })
    expect(originState.userStopped).toBe(true)
    expect(teardown.calls).not.toContain(`done:${originKey}`)
    expect(teardown.calls).not.toContain(`phase:${originKey}:done`)
    expect(cardTexts(p)).not.toContain(e.i18n.t(Msg.PlanShadowOriginClosed))
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
