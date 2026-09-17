/**
 * Plan-card shadow review: a parked ExitPlanMode plan card ALSO spawns a
 * sibling group whose session forks the origin transcript, pinned to plan
 * mode, and receives one review prompt — an independent second pass can offer
 * a better plan while the origin card stays approvable. The two sides are
 * linked through their sessions' featureState and settle each other:
 * approving the origin aborts the shadow; approving the shadow's plan voids
 * the origin's parked card. A shadow never spawns a shadow of its own and a
 * session spawns at most one, so the review cannot recurse or fan out.
 *
 * @module dsh-feishu-bridge/plan-shadow
 */

import {
  asChatPhasePainter,
  asGroupSpawner,
  asReplyContextReconstructor,
  ContinueSession,
  ForkAtSessionPrefix,
  ForkSessionPrefix,
  type Message,
  type Platform,
} from '../core/types.ts'
import { Msg } from '../i18n/index.ts'
import { newCard } from '../card.ts'
import { spawnGroupCommon } from './commands.ts'
import { cronSenderUserID } from './cron.ts'
import { extractChannelID, type Engine } from './engine.ts'
import { spawnPlaceholderName, truncateGroupName } from './groupname.ts'
import { defaultSessionName, type Session, type SessionManager } from './session.ts'

/**
 * The featureState section this module owns. Both sides of the link ride the
 * same key: the origin record names its shadow, the shadow record names the
 * origin (and thereby marks itself a shadow). Codec-less, so the section
 * persists in the sessions snapshot but is NOT carried across a conversation
 * reset — the "one shadow per session" rule is scoped to the conversation.
 */
export interface PlanShadowSection {
  /** Session key of the shadow group; set on the ORIGIN record. */
  shadowSessionKey?: string
  /** Session key of the origin chat; set on the SHADOW record. */
  shadowOf?: string
}

/** The review prompt a shadow group receives when the config leaves it unset. */
export const defaultPlanShadowPrompt = [
  '对刚提交的方案做第二轮推敲：目标和范围都不变，只比做法本身——有没有更简单、更稳、更清晰的走法？',
  '有实质改进就重新提交一份计划；没有就直说「原方案已是最优」并给一句理由。不要为了改而改，也不要顺手扩大范围。',
].join('\n')

/** The parked plan card a shadow review is launched from, or the chat that settles one. */
export interface PlanShadowRequest {
  /** Session key of the chat in question. */
  sessionKey: string
  /** Reply context of that chat, for notices. */
  replyCtx: unknown
  /** The plan text the card carries; omitted by the abort/invalidate calls. */
  plan?: string
}

/** Read a session's plan-shadow section (absent/invalid reads as empty). */
function sectionOf(session: Session | undefined): PlanShadowSection {
  const raw = session?.featureState['planShadow']
  if (raw === null || typeof raw !== 'object') return {}
  return raw
}

/** Merge one patch into a session's plan-shadow section and persist. */
function markShadow(sessions: SessionManager, sessionKey: string, patch: PlanShadowSection): void {
  const session = sessions.getOrCreateActive(sessionKey)
  session.featureState['planShadow'] = { ...sectionOf(session), ...patch }
  sessions.save()
}

/**
 * Whether a plan card in this session may spawn a shadow: the feature must be
 * on, the plan must carry text, the session must be forkable (a started,
 * non-fork native id), attributed to a real user (the shadow group's only
 * member), not itself a shadow, and not one that already spawned one.
 *
 * @param e - The engine holding the feature switch and session records.
 * @param p - The platform that would create the group.
 * @param req - The parked plan card.
 * @returns True when the launch should proceed.
 */
function canLaunch(e: Engine, p: Platform, req: PlanShadowRequest): boolean {
  if (!e.planShadowEnabled || (req.plan ?? '').trim() === '') return false
  if (asGroupSpawner(p) === undefined) return false
  const session = e.sessions.findActive(req.sessionKey)
  if (session === undefined) return false
  const section = sectionOf(session)
  if (section.shadowOf !== undefined || section.shadowSessionKey !== undefined) return false
  // The shadow group's only member is this user: an unattended (cron) turn
  // carries a synthetic sender, and a group invited around it would be one
  // nobody can open, let alone approve.
  const userID = session.getSpawnUserID().trim()
  if (userID === '' || userID === cronSenderUserID) return false
  const nativeID = session.getAgentSessionID()
  if (nativeID === '' || nativeID === ContinueSession) return false
  return !nativeID.startsWith(ForkSessionPrefix) && !nativeID.startsWith(ForkAtSessionPrefix)
}

/**
 * The origin chat's own name, as far as it is known: the session label when it
 * is a real one, else the name recorded from the chat's messages. '' when the
 * chat never had one. Deliberately NOT `sessionDisplayName`, whose remaining
 * fallbacks (the generic session placeholder, then the raw session key) name
 * the /list and /status rows — neither belongs in a chat-list entry this
 * feature creates.
 *
 * @param sessions - The manager holding the chat's records.
 * @param session - The origin chat's session record.
 * @param sessionKey - The origin chat's session key.
 * @returns The chat's name, or '' when it has none.
 */
function chatNameOf(sessions: SessionManager, session: Session, sessionKey: string): string {
  const own = session.getName().trim()
  if (own !== '' && own !== defaultSessionName) return own
  return sessions.getUserMeta(sessionKey)?.chatName.trim() ?? ''
}

/**
 * The synthetic message the shared group-spawn skeleton reads: the origin
 * chat's key, name, and user, so the child inherits working directory,
 * provider route, breadcrumb, and membership.
 *
 * @param e - The engine owning session records.
 * @param p - The platform carrying the request.
 * @param req - The parked plan card.
 * @returns The message to hand `spawnGroupCommon`.
 */
function originMessage(e: Engine, p: Platform, req: PlanShadowRequest): Message {
  const session = e.sessions.findActive(req.sessionKey)
  const name = session === undefined ? '' : chatNameOf(e.sessions, session, req.sessionKey)
  return {
    sessionKey: req.sessionKey,
    platform: p.name(),
    messageID: '',
    userID: session?.getSpawnUserID().trim() ?? '',
    userName: '',
    // The breadcrumb is the one place a raw key still beats an empty label.
    chatName: name !== '' ? name : req.sessionKey,
    chatType: 'group',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: req.replyCtx,
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
  }
}

/**
 * Launch the shadow review for a parked plan card: fire-and-forget, so the
 * ask's park and the user's approval window are never blocked by group
 * creation. Every skip is silent — the guards describe states where no shadow
 * belongs, not failures the user must hear about.
 *
 * @param e - The engine owning the parked ask.
 * @param p - The platform carrying the request.
 * @param req - The parked plan card.
 */
export function launchPlanShadow(e: Engine, p: Platform, req: PlanShadowRequest): void {
  void runLaunch(e, p, req).catch((error: unknown) => {
    console.warn(`plan-shadow: launch failed (${req.sessionKey}): ${String(error)}`)
  })
}

/** The launch body behind {@link launchPlanShadow}. */
async function runLaunch(e: Engine, p: Platform, req: PlanShadowRequest): Promise<void> {
  if (!canLaunch(e, p, req)) return
  const session = e.sessions.findActive(req.sessionKey)
  if (session === undefined) return
  const nativeID = session.getAgentSessionID()
  const name = chatNameOf(e.sessions, session, req.sessionKey)
  // No name to build on: take the /fork placeholder instead, whose
  // first-message rename names the shadow from the review prompt.
  const groupName = name === ''
    ? spawnPlaceholderName(e.name, true)
    : truncateGroupName(`${name}${e.i18n.t(Msg.PlanShadowNameSuffix)}`)
  const child = await spawnGroupCommon(
    e, p, originMessage(e, p, req),
    groupName,
    e.planShadowPrompt,
    {
      dirArg: '',
      flagWT: false,
      spawnOpts: { topicGroup: false, workDir: '' },
      threadFlag: false,
      forkSentinelID: `${ForkSessionPrefix}${nativeID}`,
      // The shadow reviews a plan; it must not start executing one.
      modeArg: 'plan',
      readyTitleKey: Msg.ForkGroupReady,
      parentNotice: e.i18n.t(Msg.PlanShadowOriginNotice),
    },
  )
  // A failed spawn already reported itself in the origin chat (spawn error,
  // RAM guard) — only the attribution to this feature would be new, and that
  // is what the notice on the origin's jump card carried.
  if (child === undefined) {
    console.warn(`plan-shadow: group spawn failed (${req.sessionKey})`)
    return
  }
  markShadow(e.sessions, req.sessionKey, { shadowSessionKey: child.sessionKey })
  markShadow(e.sessions, child.sessionKey, { shadowOf: req.sessionKey })
  const replyCtx = await replyCtxFor(e, p, child.sessionKey, child.replyCtx)
  if (replyCtx !== undefined) await e.reply(p, replyCtx, e.i18n.t(Msg.PlanShadowChildNotice))
}

/**
 * Abort the shadow a session launched, because the origin plan card settled
 * as approved: the shadow's work is moot. Mirrors the /done teardown order —
 * commit the terminal state before stopping, so late repaints observe the
 * done mark — then posts the void notice in the shadow chat.
 *
 * @param e - The engine owning both sessions.
 * @param p - The platform carrying the request.
 * @param req - The origin chat's key and reply context.
 */
export function abortPlanShadow(e: Engine, p: Platform, req: PlanShadowRequest): void {
  void runAbort(e, p, req).catch((error: unknown) => {
    console.warn(`plan-shadow: abort failed (${req.sessionKey}): ${String(error)}`)
  })
}

/** The abort body behind {@link abortPlanShadow}. */
async function runAbort(e: Engine, p: Platform, req: PlanShadowRequest): Promise<void> {
  const shadowKey = sectionOf(e.sessions.findActive(req.sessionKey)).shadowSessionKey
  if (shadowKey === undefined) return
  const replyCtx = await replyCtxFor(e, p, shadowKey, undefined)
  try {
    await e.markSpawnedChatDone(p, shadowKey)
    await asChatPhasePainter(p)?.setChatPhase(shadowKey, 'done')
  } catch (error) {
    console.warn(`plan-shadow: dim shadow chat failed (${shadowKey}): ${String(error)}`)
  }
  e.stopInteractiveSession(shadowKey)
  if (replyCtx !== undefined) await e.reply(p, replyCtx, e.i18n.t(Msg.PlanShadowAborted))
}

/**
 * Void the origin chat's parked plan card, because the shadow's plan was
 * approved instead. The origin turn is stopped with the ask, not merely
 * un-parked: a cancelled `exit_plan_mode` would otherwise let the origin
 * agent plan again and park a competing card.
 *
 * @param e - The engine owning both sessions.
 * @param p - The platform carrying the request.
 * @param req - The SHADOW chat's key and reply context.
 */
export function invalidateOriginPlan(e: Engine, p: Platform, req: PlanShadowRequest): void {
  void runInvalidate(e, p, req).catch((error: unknown) => {
    console.warn(`plan-shadow: invalidate failed (${req.sessionKey}): ${String(error)}`)
  })
}

/** The invalidate body behind {@link invalidateOriginPlan}. */
async function runInvalidate(e: Engine, p: Platform, req: PlanShadowRequest): Promise<void> {
  const originKey = sectionOf(e.sessions.findActive(req.sessionKey)).shadowOf
  if (originKey === undefined) return
  const originState = e.interactiveStates.get(originKey)
  const parkedPlan = originState?.pendingAsk?.request.kind === 'plan-review'
  const replyCtx = await replyCtxFor(e, p, originKey, undefined)
  if (parkedPlan) e.stopInteractiveSession(originKey)
  if (replyCtx === undefined) return
  const url = e.chatJumpURL(p, extractChannelID(req.sessionKey))
  const card = newCard().markdown(e.i18n.t(Msg.PlanShadowOriginSuperseded))
  if (url !== '') {
    card.buttons({ text: e.i18n.t(Msg.SpawnJumpBtn), type: 'primary', value: '', url })
  }
  await e.replyWithCard(p, replyCtx, card.build())
}

/**
 * A platform reply context for a chat that is not the caller's: the live
 * interactive state's when present, else the platform's reconstruction.
 *
 * @param e - The engine owning the interactive states.
 * @param p - The platform to reconstruct through.
 * @param sessionKey - The chat to address.
 * @param fallback - Reply context used when neither source yields one.
 * @returns The reply context, or undefined when the chat cannot be addressed.
 */
async function replyCtxFor(e: Engine, p: Platform, sessionKey: string, fallback: unknown): Promise<unknown> {
  const live = e.interactiveStates.get(sessionKey)?.replyCtx
  if (live !== undefined && live !== null) return live
  const reconstructor = asReplyContextReconstructor(p)
  if (reconstructor === undefined) return fallback
  try {
    return await reconstructor.reconstructReplyCtx(sessionKey)
  } catch (error) {
    console.warn(`plan-shadow: reconstruct reply ctx failed (${sessionKey}): ${String(error)}`)
    return fallback
  }
}
