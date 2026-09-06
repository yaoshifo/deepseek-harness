/**
 * The research-assistant stall supervisor: a level-triggered sweep that turns
 * a silently frozen hub↔steward relation into a visible decision point
 * (2026-09-06 oc_97be4a1c — the moderator ended its turn "waiting for the
 * steward", the steward's own wake chain died, and the room froze in
 * `discussing` forever). Freeze is silence plus no deadline: this module owns
 * the deadline side.
 *
 * Everything is derived from durable state on every tick — no armed timers to
 * clear on interrupt (the moderator flag going down is the stop), no
 * edge-triggered bookkeeping to lose across a restart. The decision is
 * three-layered so a mis-set deadline cannot make the supervisor itself a
 * nuisance:
 *
 * 1. Evidence gate — a declared wait (open turn on either side, a parked ask,
 *    pending background tasks, an armed barrier with its own timeout) is not
 *    a stall.
 * 2. Progress clock — only organic relation activity resets the episode; the
 *    moderator's replies to the supervisor's own wakes do not.
 * 3. Breaker — after {@link chatroomSupervisorMaxWakes} wakes with no organic
 *    progress, the sweep stops waking the moderator and posts one visible
 *    group notice per deadline period instead, handing the decision to the
 *    user.
 *
 * @module dsh-feishu-bridge-chatroom/chatroom-supervise
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Engine, Session } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { asReplyContextReconstructor } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { Msg } from '../i18n.ts'
import { chatroomState } from '../chatroom-state.ts'
import { chatroomConfig } from '../chatroom-config.ts'
import { assistantReportPending, chatroomStewardGroupName, findRoleKeyByName, wakeChatroomModerator } from './chatroom.ts'

/** Message-metadata flag marking the supervisor's own wakes for activity tracking. */
export const chatroomSupervisorWakeMetadata = 'chatroomSupervisorWake'

/** Wakes per stall episode before the breaker hands the room to the user. */
export const chatroomSupervisorMaxWakes = 3

/** Sweep cadence; well below the stall floor so deadlines resolve within one period of expiring. */
const chatroomSupervisorTickMs = 60_000

/** Excerpt cap for the steward's last reply in a wake message (UTF-16 chars). */
const supervisionExcerptChars = 200

/**
 * Record organic activity on the hub↔steward relation at turn start: a hub
 * turn (any origin — user message, role relay, steward report) or a steward
 * turn both prove the relation is alive. The supervisor's own tagged wakes are
 * excluded so answering a reminder cannot feed the loop it is meant to close.
 * @param e - Engine owning the session registry.
 * @param session - The session whose turn started.
 * @param metadata - The opened turn's message metadata, when present.
 */
export function touchChatroomSupervisionActivity(e: Engine, session: Session, metadata?: Record<string, unknown>): void {
  if (metadata?.[chatroomSupervisorWakeMetadata] === true) return
  const s = chatroomState(session)
  if (s.chatroomModerator && s.researchAssistantKey !== '') {
    s.supervisionActivityAt = Date.now()
    e.sessions.save()
    return
  }
  // A chatroom role's own turns are the organic activity of every serial
  // ask addressed to it: the stall clock below resets on this stamp.
  if (s.chatroomHubKey !== '' && !s.chatroomModerator) {
    s.roleActivityAt = Date.now()
    e.sessions.save()
    return
  }
  if (!s.researchAssistant) return
  for (const [, hub] of e.sessions.activeSessionEntries()) {
    const hs = chatroomState(hub)
    if (!hs.chatroomModerator || hs.researchAssistantKey === '') continue
    if (e.sessions.findActive(hs.researchAssistantKey) !== session) continue
    hs.supervisionActivityAt = Date.now()
    e.sessions.save()
    return
  }
}

/** Whether one side's declared wait makes the relation supervised-not-stalled. */
function declaredWait(e: Engine, hubKey: string, stewardKey: string): boolean {
  const hubState = e.interactiveStates.get(hubKey)
  if ((hubState?.activeTurns ?? 0) > 0) return true
  if (hubState?.pendingAsk !== undefined) return true
  if ((hubState?.backgroundTasksPending ?? 0) > 0) return true
  const stewardState = e.interactiveStates.get(stewardKey)
  if ((stewardState?.activeTurns ?? 0) > 0) return true
  return (stewardState?.backgroundTasksPending ?? 0) > 0
}

/**
 * One supervision sweep over an engine's hub↔steward relations: wake stalled
 * moderators (facts + options), or post the breaker notice once the wake
 * budget is spent. Synchronous bookkeeping, fire-and-forget delivery.
 * @param e - The engine whose sessions to sweep.
 * @param nowMs - Wall clock in ms (injectable for tests).
 */
export function superviseChatroomAssistants(e: Engine, nowMs: number = Date.now()): void {
  const stallMs = chatroomConfig(e).assistantStallDuration()
  if (stallMs <= 0) return
  superviseSerialAsks(e, nowMs, stallMs)
  for (const [hubKey, hub] of e.sessions.activeSessionEntries()) {
    const hs = chatroomState(hub)
    if (!hs.chatroomModerator || hs.researchAssistantKey === '') continue
    const stewardKey = hs.researchAssistantKey
    const steward = e.sessions.findActive(stewardKey)
    if (steward === undefined) continue
    if (hs.pendingGather !== undefined || hs.pendingEndBarrier !== undefined) continue
    if (declaredWait(e, hubKey, stewardKey)) continue
    // Organic activity since the last wake reopens the wake budget.
    if (hs.supervisionLastWakeAt !== 0 && hs.supervisionActivityAt > hs.supervisionLastWakeAt && hs.supervisionWakeCount !== 0) {
      hs.supervisionWakeCount = 0
      e.sessions.save()
    }
    // An activity stamp of 0 is a room that predates the supervisor (or froze
    // before it deployed): treat it as stalled since forever, so the sweep
    // picks up legacy frozen rooms on its first tick.
    const quietMs = nowMs - hs.supervisionActivityAt
    if (quietMs < stallMs) continue
    if (hs.supervisionLastWakeAt !== 0 && nowMs - hs.supervisionLastWakeAt < stallMs) continue
    if (hs.supervisionWakeCount >= chatroomSupervisorMaxWakes) {
      hs.supervisionLastWakeAt = nowMs
      e.sessions.save()
      console.warn(`chatroom: supervisor breaker tripped (hub=${hubKey} wakes=${hs.supervisionWakeCount}) — handing the stalled relation to the user`)
      postSupervisionBreakerNotice(e, hubKey, hs.supervisionWakeCount)
      continue
    }
    hs.supervisionWakeCount += 1
    hs.supervisionLastWakeAt = nowMs
    e.sessions.save()
    const minutes = Math.floor(quietMs / 60_000)
    const excerpt = steward.lastResult.slice(0, supervisionExcerptChars)
    const content = e.i18n.tf(
      Msg.ChatroomSupervisorWake,
      chatroomStewardGroupName(),
      minutes,
      excerpt === '' ? '—' : excerpt,
    )
    console.info(`chatroom: supervisor woke stalled moderator (hub=${hubKey} quietSec=${Math.floor(quietMs / 1000)} wake=${hs.supervisionWakeCount}/${chatroomSupervisorMaxWakes})`)
    wakeChatroomModerator(e, hubKey, content, { [chatroomSupervisorWakeMetadata]: true })
  }
}

/** Whether a declared wait covers an outstanding serial ask (not a stall). */
function serialAskDeclaredWait(e: Engine, hubKey: string, roleKey: string): boolean {
  const hubState = e.interactiveStates.get(hubKey)
  if ((hubState?.activeTurns ?? 0) > 0) return true
  if (hubState?.pendingAsk !== undefined) return true
  if (roleKey === '') return false
  const roleState = e.interactiveStates.get(roleKey)
  if ((roleState?.activeTurns ?? 0) > 0) return true
  if ((roleState?.backgroundTasksPending ?? 0) > 0) return true
  const role = e.sessions.findActive(roleKey)
  if (role === undefined) return false
  // assistantReportPending reads an unprovisioned assistant as pending (the
  // relay defers conservatively); only a role actually awaiting its report
  // makes that a declared wait.
  return chatroomState(role).researchAwaitingAssistant && assistantReportPending(e, role)
}

/**
 * Sweep one pass of every hub's outstanding serial asks: a moderator
 * question whose role shows neither organic activity nor a declared wait
 * past the stall deadline becomes a visible decision point (facts +
 * follow-up/skip/wrap-up). Same three-layer noise discipline as the steward
 * relation: declared waits gate the clock, organic role activity reopens the
 * episode, and the breaker hands a spent ask to the user with one group
 * notice per stall window.
 */
function superviseSerialAsks(e: Engine, nowMs: number, stallMs: number): void {
  for (const [hubKey, hub] of e.sessions.activeSessionEntries()) {
    const hs = chatroomState(hub)
    if (!hs.chatroomModerator || hs.pendingSerialAsks.size === 0) continue
    if (hs.pendingGather !== undefined || hs.pendingEndBarrier !== undefined) continue
    if (hs.pendingHumanQuestionRole !== '') continue
    for (const [roleName, entry] of [...hs.pendingSerialAsks.entries()]) {
      const roleKey = findRoleKeyByName(e, hubKey, roleName)
      if (serialAskDeclaredWait(e, hubKey, roleKey)) continue
      const role = roleKey !== '' ? e.sessions.findActive(roleKey) : undefined
      const quietMs = nowMs - Math.max(entry.armedAt, role !== undefined ? chatroomState(role).roleActivityAt : 0)
      if (quietMs < stallMs) continue
      if (entry.lastWakeAt !== 0 && nowMs - entry.lastWakeAt < stallMs) continue
      if (entry.wakeCount >= chatroomSupervisorMaxWakes) {
        entry.lastWakeAt = nowMs
        e.sessions.save()
        console.warn(`chatroom: supervisor breaker tripped (hub=${hubKey} role=${roleName} wakes=${entry.wakeCount}) — handing the stalled ask to the user`)
        postSupervisionBreakerNotice(e, hubKey, entry.wakeCount)
        continue
      }
      entry.wakeCount += 1
      entry.lastWakeAt = nowMs
      e.sessions.save()
      const minutes = Math.floor(quietMs / 60_000)
      const excerpt = role?.lastResult.slice(0, supervisionExcerptChars) ?? ''
      const content = e.i18n.tf(
        Msg.ChatroomRoleSupervisorWake,
        roleName,
        minutes,
        excerpt === '' ? '—' : excerpt,
      )
      console.info(`chatroom: supervisor woke stalled moderator about serial ask (hub=${hubKey} role=${roleName} quietSec=${Math.floor(quietMs / 1000)} wake=${entry.wakeCount}/${chatroomSupervisorMaxWakes})`)
      wakeChatroomModerator(e, hubKey, content, { [chatroomSupervisorWakeMetadata]: true })
    }
  }
}

/**
 * Post the breaker's visible group notice (fire-and-forget, fails loud on
 * send errors without failing the sweep).
 * @param e - Engine addressing the hub group.
 * @param hubKey - Session key of the stalled hub.
 * @param wakes - Wakes already spent on the episode.
 */
function postSupervisionBreakerNotice(e: Engine, hubKey: string, wakes: number): void {
  const p = e.spawnCapablePlatform()
  if (p === undefined) return
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  void r.reconstructReplyCtx(hubKey).then(
    (hubRctx) => {
      void e.sendAsCard(p, hubRctx, e.i18n.tf(Msg.ChatroomSupervisorBreakerBody, wakes), {
        title: e.i18n.t(Msg.ChatroomSupervisorBreakerTitle),
        color: 'orange',
      }).catch((error: unknown) => {
        console.warn(`chatroom: supervisor breaker notice failed (hub=${hubKey}): ${String(error)}`)
      })
    },
    (error: unknown) => {
      console.warn(`chatroom: reconstruct hub ctx for breaker notice failed (hub=${hubKey}): ${String(error)}`)
    },
  )
}

/**
 * Register the supervisor on a plugin context: the periodic sweep over every
 * live project engine and the turn-start activity touch.
 * @param ctx - The chatroom plugin's context (effects own both registrations).
 * @param projects - Live project entries whose engines to sweep.
 * @returns disposer stopping the sweep and listener.
 */
export function registerChatroomSupervisor(ctx: Context, projects: () => ReadonlyArray<{ engine: Engine }>): () => void {
  const disposeListener = ctx.on('feishuBridge/turn-start', (payload) => {
    touchChatroomSupervisionActivity(payload.engine, payload.session, payload.metadata)
  })
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    for (const { engine } of projects()) {
      try {
        superviseChatroomAssistants(engine)
      } catch (error: unknown) {
        console.warn(`chatroom: supervisor sweep failed (engine=${engine.name}): ${String(error)}`)
      }
    }
  }, chatroomSupervisorTickMs)
  timer.unref()
  return () => {
    clearInterval(timer)
    disposeListener()
  }
}
