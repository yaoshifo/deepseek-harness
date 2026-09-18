/**
 * Plan-card shadow review: a parked ExitPlanMode plan card ALSO spawns a
 * sibling group whose session forks the origin transcript, pinned to plan
 * mode, and receives one review prompt — an independent second pass can offer
 * a better plan while the origin card stays approvable. The two sides are
 * linked through their sessions' featureState, and whichever side the user
 * engages with settles the other: a user action there — text, an attachment, a
 * card button — closes the peer the /done way (grey avatar, session stopped)
 * and voids the peer's parked plan card, so the pair never stays half-alive
 * waiting for a verdict that no longer decides anything. An approval is the one
 * action the parked card's own settlement owns, and its notice names the
 * approval rather than "the other side moved".
 *
 * Housekeeping does not settle a pair — slash commands and query buttons are
 * how the user checks on a chat, not how they act on it — and neither do the
 * engine's synthetic injections (a spawn's first message, machine wakes): only
 * what a platform delivered for a human reaches the settlement. A pair settles
 * once; later messages, and a group woken after its close, settle nothing and
 * repeat nothing.
 *
 * A group the platform does not track (a main group, a p2p chat) owns no avatar
 * axis: it loses its parked card with its turn and is told without any close
 * claimed. Neither settlement touches a group's own child groups or worktree,
 * and a shadow never spawns a shadow of its own; a session spawns at most one,
 * so the review cannot recurse or fan out.
 *
 * @module dsh-feishu-bridge/plan-shadow
 */

import {
  asChatPhasePainter,
  asGroupSpawner,
  asReplyContextReconstructor,
  asSpawnedChatActiveChecker,
  ContinueSession,
  ForkAtSessionPrefix,
  ForkSessionPrefix,
  type Message,
  type Platform,
} from '../core/types.ts'
import { Msg, type MsgKey } from '../i18n/index.ts'
import { parsePermissionVerdict } from './ask.ts'
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
  /**
   * Set on BOTH records by the first settlement: one pair settles once. A chat
   * the user keeps talking in afterwards — or wakes again — never re-closes its
   * peer and never repeats the explanation.
   */
  settled?: boolean
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
 * The session a shadow review may be launched for, or undefined: the feature
 * must be on, the plan must carry text, the platform must be able to create
 * groups, the session must exist (a started, non-fork native id), it must be
 * attributed to a real user (the shadow group's only member), it must not be a
 * shadow itself, and it must not have launched one already.
 *
 * @param e - The engine holding the feature switch and session records.
 * @param p - The platform that would create the group.
 * @param req - The parked plan card.
 * @returns The origin session when the launch should proceed.
 */
function launchableSession(e: Engine, p: Platform, req: PlanShadowRequest): Session | undefined {
  if (!e.planShadowEnabled || (req.plan ?? '').trim() === '') return undefined
  if (asGroupSpawner(p) === undefined) return undefined
  const session = e.sessions.findActive(req.sessionKey)
  if (session === undefined) return undefined
  const section = sectionOf(session)
  if (section.shadowOf !== undefined || section.shadowSessionKey !== undefined) return undefined
  // The shadow group's only member is this user: an unattended (cron) turn
  // carries a synthetic sender, and a group invited around it would be one
  // nobody can open, let alone approve.
  const userID = session.getSpawnUserID().trim()
  if (userID === '' || userID === cronSenderUserID) return undefined
  const nativeID = session.getAgentSessionID()
  if (nativeID === '' || nativeID === ContinueSession) return undefined
  if (nativeID.startsWith(ForkSessionPrefix) || nativeID.startsWith(ForkAtSessionPrefix)) return undefined
  return session
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
 * @param session - The origin chat's session record, already resolved by the launch guard.
 * @returns The message to hand `spawnGroupCommon`.
 */
function originMessage(e: Engine, p: Platform, req: PlanShadowRequest, session: Session): Message {
  const name = chatNameOf(e.sessions, session, req.sessionKey)
  return {
    sessionKey: req.sessionKey,
    platform: p.name(),
    messageID: '',
    userID: session.getSpawnUserID().trim(),
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
 * Run one settlement step detached, logging its failure and nothing else. Every
 * entry point below is reached from a parked ask, whose approval window must
 * not be blocked by — or die with — work that runs after the card landed.
 *
 * @param label - What failed, for the log line.
 * @param sessionKey - The chat the step belongs to.
 * @param run - The step's body.
 */
function fireAndForget(label: string, sessionKey: string, run: () => Promise<void>): void {
  void run().catch((error: unknown) => {
    console.warn(`plan-shadow: ${label} (${sessionKey}): ${String(error)}`)
  })
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
  fireAndForget('launch failed', req.sessionKey, () => runLaunch(e, p, req))
}

/** The launch body behind {@link launchPlanShadow}. */
async function runLaunch(e: Engine, p: Platform, req: PlanShadowRequest): Promise<void> {
  const session = launchableSession(e, p, req)
  if (session === undefined) return
  const nativeID = session.getAgentSessionID()
  const name = chatNameOf(e.sessions, session, req.sessionKey)
  // No name to build on: take the /fork placeholder instead, whose
  // first-message rename names the shadow from the review prompt.
  const groupName = name === ''
    ? spawnPlaceholderName(e.name, true)
    : truncateGroupName(`${name}${e.i18n.t(Msg.PlanShadowNameSuffix)}`)
  const child = await spawnGroupCommon(
    e, p, originMessage(e, p, req, session),
    groupName,
    e.planShadowPrompt,
    {
      dirArg: '',
      flagWT: false,
      // Born named, so no naming pass will ever stamp this group's own icon:
      // its face comes from the origin chat instead.
      spawnOpts: { topicGroup: false, workDir: '', avatarFrom: req.sessionKey },
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
  // Creating the group takes a moment, and the origin's card can be answered in
  // that window — while the link above did not exist yet, so that settlement
  // found no peer to close. A group born after the decision would review a plan
  // nobody is waiting for, so it is settled on arrival.
  if (e.interactiveStates.get(req.sessionKey)?.pendingAsk?.request.kind !== 'plan-review') {
    settlePlanShadowPeer(e, p, { sessionKey: req.sessionKey, trigger: 'input' })
  }
}

/** The side of a pair a chat is on, and the peer that side settles. */
interface ClaimedPeer {
  /** Session key of the chat to settle. */
  peerKey: string
  /** `origin` when the claiming chat is the origin chat, `shadow` when it is the review group. */
  side: 'origin' | 'shadow'
}

/**
 * Claim the peer of the pair `sessionKey` belongs to, or undefined when the
 * chat is in no pair or the pair already settled. The claim commits on BOTH
 * records before returning, so two settlements landing in the same tick cannot
 * both pass the guard: "one settlement per pair" has a single decision point.
 *
 * @param e - The engine owning session records.
 * @param sessionKey - The chat that acted (or whose card was approved).
 * @returns The peer to settle, when this claim owns the settlement.
 */
function claimPeer(e: Engine, sessionKey: string): ClaimedPeer | undefined {
  const section = sectionOf(e.sessions.findActive(sessionKey))
  if (section.settled === true) return undefined
  const shadowKey = section.shadowSessionKey
  const originKey = section.shadowOf
  const peerKey = shadowKey ?? originKey
  if (peerKey === undefined) return undefined
  markShadow(e.sessions, sessionKey, { settled: true })
  markShadow(e.sessions, peerKey, { settled: true })
  return { peerKey, side: shadowKey !== undefined ? 'origin' : 'shadow' }
}

/**
 * Close the review group of a pair and tell it why: the /done way
 * ({@link closeChat}), then a notice card. A group already carrying its
 * terminal mark is left completely alone — an earlier settlement, or a `/done`
 * by hand, closed it, and the user may have woken it since: greying it again
 * and repeating the notice is exactly what the mark's freeze exists to prevent.
 *
 * @param e - The engine owning both sessions.
 * @param p - The platform carrying the group.
 * @param shadowKey - Session key of the review group.
 * @param noticeKey - Message key of the notice explaining the close.
 */
async function closeShadowPeer(e: Engine, p: Platform, shadowKey: string, noticeKey: MsgKey): Promise<void> {
  if (asSpawnedChatActiveChecker(p)?.isSpawnedChatDone(shadowKey) === true) return
  // Addressed before the close: closing drops the chat's interactive state, and
  // the platform's reconstruction is the only remaining source.
  const replyCtx = await replyCtxFor(e, p, shadowKey)
  await closeChat(e, p, shadowKey)
  if (replyCtx !== undefined) await e.reply(p, replyCtx, e.i18n.t(noticeKey))
}

/**
 * Close the origin chat of a pair and void its parked plan card, because the
 * review group acted. The origin turn is stopped with the ask, not merely
 * un-parked: a cancelled `exit_plan_mode` would otherwise let the origin agent
 * plan again and park a competing card. Only a live spawned group is greyed
 * ({@link closeChat}); a main group or a p2p chat owns no avatar axis, so it
 * loses the card with its turn and is told without any close claimed. An origin
 * already carrying its terminal mark voids its card silently — a later
 * settlement in the review group would otherwise leave a card clickable that
 * can never be honoured, and the user has been told once already. Either way
 * the close reaches no further than the origin: its own child groups and its
 * worktree are untouched, and `/done`'s pre-done broadcast never fires.
 *
 * @param e - The engine owning both sessions.
 * @param p - The platform carrying the request.
 * @param originKey - Session key of the origin chat.
 * @param survivorKey - Session key of the review group the notice points at.
 * @param supersededKey - Message key of the void notice.
 */
async function closeOriginPeer(
  e: Engine, p: Platform, originKey: string, survivorKey: string, supersededKey: MsgKey,
): Promise<void> {
  // Read before the close: closing flips both signals.
  const checker = asSpawnedChatActiveChecker(p)
  const tracked = checker?.isSpawnedChatActive(originKey) === true
  const announced = checker?.isSpawnedChatDone(originKey) !== true
  // Addressed before the close: closing the origin drops its interactive state,
  // and the platform's reconstruction is the only remaining source.
  const replyCtx = announced ? await replyCtxFor(e, p, originKey) : undefined
  if (tracked) await closeChat(e, p, originKey)
  else e.stopInteractiveSession(originKey)
  if (replyCtx === undefined) return
  const url = e.chatJumpURL(p, extractChannelID(survivorKey))
  const superseded = e.i18n.t(supersededKey)
  const text = tracked ? `${superseded}\n${e.i18n.t(Msg.PlanShadowOriginClosed)}` : superseded
  const card = newCard().markdown(text)
  if (url !== '') {
    card.buttons({ text: e.i18n.t(Msg.SpawnJumpBtn), type: 'primary', value: '', url })
  }
  await e.replyWithCard(p, replyCtx, card.build())
}

/**
 * Why a pair is being settled, which picks the words the peer is told: an
 * approval names the approval; every other action only says the other side
 * moved.
 */
export type PlanShadowTrigger = 'approved' | 'input'

/** The action that settles a pair, and the chat it happened in. */
export interface PlanShadowSettlement {
  /** Session key of the chat that acted (or whose card was approved). */
  sessionKey: string
  /** What that chat did. */
  trigger: PlanShadowTrigger
}

/** The notice the settled peer gets, by its own side and by trigger. */
const settlementNoticeKeys: Record<PlanShadowTrigger, { shadow: MsgKey; origin: MsgKey }> = {
  approved: { shadow: Msg.PlanShadowAborted, origin: Msg.PlanShadowOriginSuperseded },
  input: { shadow: Msg.PlanShadowAbortedOnInput, origin: Msg.PlanShadowOriginSupersededOnInput },
}

/**
 * Settle the OTHER side of the pair `sessionKey` acted in: whichever group the
 * user engages with wins, so the peer is closed on the spot instead of waiting
 * for a plan verdict that no longer decides anything. One entry for both
 * triggers — the acting chat's own record says which side it is — so a
 * settlement has exactly one claim site and one place to pick its notice.
 *
 * @param e - The engine owning both sessions.
 * @param p - The platform carrying the request.
 * @param req - The acting chat and what it did.
 */
export function settlePlanShadowPeer(e: Engine, p: Platform, req: PlanShadowSettlement): void {
  const claimed = claimPeer(e, req.sessionKey)
  if (claimed === undefined) return
  const notices = settlementNoticeKeys[req.trigger]
  fireAndForget(`${req.trigger} settlement failed`, req.sessionKey, () => claimed.side === 'origin'
    ? closeShadowPeer(e, p, claimed.peerKey, notices.shadow)
    : closeOriginPeer(e, p, claimed.peerKey, req.sessionKey, notices.origin))
}

/**
 * Whether this message is the user acting in the chat — the only surface pair
 * settlement reads. Query buttons (`/list` pagination, a `/status` refresh) and
 * slash commands are housekeeping: checking on a chat must not spend the other
 * side's work. Everything that pushes the conversation counts — text,
 * attachments, permission/ask/follow-ups buttons, command-shortcut buttons.
 *
 * @param msg - The inbound message.
 * @returns True when the message acts on the pair.
 */
function isUserAction(msg: Message): boolean {
  if (msg.isCardAction) return false
  if (msg.images.length === 0 && msg.files.length === 0 && msg.content.trim().startsWith('/')) return false
  return true
}

/**
 * Whether this input IS the approval its own parked plan card is waiting for.
 * That settlement owns the pair for this action: its notice names the approval
 * rather than "the origin acted", and it also covers approvals that never
 * arrive as a platform message — so exactly one of the two paths may run.
 *
 * @param e - The engine owning the parked ask.
 * @param msg - The message the platform delivered for this chat.
 * @returns True when the parked plan-card settlement handles this input.
 */
function isPlanCardApproval(e: Engine, msg: Message): boolean {
  if (e.interactiveStates.get(msg.sessionKey)?.pendingAsk?.request.kind !== 'plan-review') return false
  const verdict = parsePermissionVerdict(msg.content)
  return verdict?.verdict === 'allow' || verdict?.verdict === 'allow-all'
}

/**
 * Settle the peer of the pair, because the user acted in this chat. Called for
 * every message a platform delivered ({@link Engine.handleInbound}); a chat in
 * no pair, a pair that already settled, and everything {@link isUserAction} or
 * {@link isPlanCardApproval} excludes returns silently.
 *
 * @param e - The engine owning both sessions.
 * @param p - The platform carrying the request.
 * @param msg - The message the platform delivered for this chat.
 */
export function settlePlanShadowPeerOnInput(e: Engine, p: Platform, msg: Message): void {
  if (!isUserAction(msg) || isPlanCardApproval(e, msg)) return
  settlePlanShadowPeer(e, p, { sessionKey: msg.sessionKey, trigger: 'input' })
}

/**
 * Close a chat the way /done closes one, and nothing more: commit the terminal
 * mark, grey the avatar, then stop the session. Deliberately NOT the /done call
 * path (`cmdDone`/`cleanupOneChat`), which also tears down every descendant
 * subtask group and acts on the chat's worktree; a superseded plan has no
 * business destroying either.
 *
 * The order is load-bearing: the done mark commits before the stop, so the
 * chat's own stopped ask repaints nothing (applyChatPhase's
 * `isSpawnedChatDone` freeze) and late repaints observe the grey.
 *
 * @param e - The engine owning the chat's session and interactive state.
 * @param p - The platform owning the chat's avatar axis.
 * @param sessionKey - Session key of the chat to close.
 */
async function closeChat(e: Engine, p: Platform, sessionKey: string): Promise<void> {
  try {
    await e.markSpawnedChatDone(p, sessionKey)
    await asChatPhasePainter(p)?.setChatPhase(sessionKey, 'done')
  } catch (error) {
    console.warn(`plan-shadow: close chat failed (${sessionKey}): ${String(error)}`)
  }
  e.stopInteractiveSession(sessionKey)
}

/**
 * A platform reply context for a chat that is not the caller's: the live
 * interactive state's when present, else the platform's reconstruction.
 *
 * @param e - The engine owning the interactive states.
 * @param p - The platform to reconstruct through.
 * @param sessionKey - The chat to address.
 * @returns The reply context, or undefined when the chat cannot be addressed.
 */
async function replyCtxFor(e: Engine, p: Platform, sessionKey: string): Promise<unknown> {
  const live = e.interactiveStates.get(sessionKey)?.replyCtx
  if (live !== undefined && live !== null) return live
  const reconstructor = asReplyContextReconstructor(p)
  if (reconstructor === undefined) return undefined
  try {
    return await reconstructor.reconstructReplyCtx(sessionKey)
  } catch (error) {
    console.warn(`plan-shadow: reconstruct reply ctx failed (${sessionKey}): ${String(error)}`)
    return undefined
  }
}
