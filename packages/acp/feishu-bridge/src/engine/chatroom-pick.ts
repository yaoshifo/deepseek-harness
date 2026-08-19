/**
 * Chatroom interactive pickers ported from cc-connect core/engine_chatroom.go
 * (beginChatroomPick / RenderChatroomPickCard / executeChatroomPickAction in
 * engine_cmd_card.go): the #43 role picker and the #59 topic picker. Picker
 * state lives on the engine's InteractiveState (chatroomPick /
 * chatroomTopicPick), guarded by the single-threaded JS event loop.
 *
 * @module dsh-feishu-bridge/chatroom-pick
 */

import type { Engine } from './engine.js'
import { emptyMessage } from './engine.js'
import type { Message, Platform } from '../core/types.js'
import { asCardSender, asReplyContextReconstructor } from '../core/types.js'
import { newCard } from '../card.js'
import type { Card } from '../card.js'
import {
  MsgChatroomNoRolesConfigured,
  MsgChatroomPickCancel,
  MsgChatroomPickConfirm,
  MsgChatroomPickEmpty,
  MsgChatroomPickPicking,
  MsgChatroomPickRecommended,
  MsgChatroomPickSelect,
  MsgChatroomPickSelected,
  MsgChatroomPickSelectedCount,
  MsgChatroomPickTitle,
  MsgChatroomPickTooMany,
  MsgChatroomTopicLabel,
  MsgChatroomTopicPickCancel,
  MsgChatroomTopicPickConfirm,
  MsgChatroomTopicPickEmpty,
  MsgChatroomTopicPickNotSelected,
  MsgChatroomTopicPickPick,
  MsgChatroomTopicPickPicked,
  MsgChatroomTopicPickPickedHint,
  MsgChatroomTopicPickPicking,
  MsgChatroomTopicPickTitle,
  MsgChatroomTopicPickWatchdogHint,
} from '../i18n/keys.js'
import { listRoleNames } from './chatroom-roles.js'
import { buildChatroomPickPriming, buildChatroomTopicPickPriming } from './chatroom-priming.js'
import { clearChatroomResearchFlags, startChatroom } from './chatroom.js'
import { afterChatroomStarted, startChatroomDirectRole } from './chatroom-cmd.js'

/** How long beginChatroomPick waits for the moderator's pick call (Go chatroomPickWatchdogTimeout). */
export const chatroomPickWatchdogTimeout = 5 * 60 * 1000

/** One entry in the moderator's pick-roles recommendation (Go chatroomRolePick). */
export interface ChatroomRolePick {
  name: string
  recommended: boolean
  /** Reason (recommended) or one-line intro (others). */
  blurb: string
}

/** One candidate topic proposed by the moderator in the #59 flow (Go chatroomTopicPick). */
export interface ChatroomTopicPick {
  title: string
  recommended: boolean
  /** Why this topic is worth discussing. */
  blurb: string
}

/** The #43 role-picker state (Go chatroomPickState): phase 'picking' → 'select'. */
export interface ChatroomPickState {
  /** Captured at cmdChatroom time; reused on confirm. */
  topic: string
  phase: 'picking' | 'select'
  /** Snapshot of the roles dir at pick time. */
  rolesDir: string
  /** Valid role names (listRoleNames snapshot). */
  allNames: string[]
  /** Moderator recommendations (validated; recommended first). */
  recs: ChatroomRolePick[]
  /** Role name → selected (recommended pre-seeded). */
  selected: Map<string, boolean>
  hint: string
  /** Set once the user toggles any role on the rendered card. */
  userTouched: boolean
  /** Captured at cmdChatroom; passed to the moderator wake on confirm. */
  userID: string
  /** Captured at cmdChatroom; p2p-skip handled on rename. */
  chatType: string
}

/** The #59 topic-picker state (Go chatroomTopicPickState): single-select. */
export interface ChatroomTopicPickState {
  phase: 'picking' | 'select'
  rolesDir: string
  allNames: string[]
  recs: ChatroomTopicPick[]
  /** Single-select: the picked title ('' = none). */
  selected: string
  hint: string
  userTouched: boolean
  userID: string
  chatType: string
}

/**
 * Picker state storage: Go parks these fields on the interactiveState,
 * whose object survives agent-process swaps. The TS interactive state is
 * REPLACED on each new agent session (only the message queue is adopted),
 * so the pickers live in engine-keyed maps — same lifetime semantics,
 * independent of agent recycling.
 */
export interface PickerStates {
  chatroomPick: Map<string, ChatroomPickState>
  chatroomTopicPick: Map<string, ChatroomTopicPickState>
}

const pickerMaps = new WeakMap<Engine, PickerStates>()

/** The armed role-picker state for a session key (undefined when none). */
export function getChatroomPickState(e: Engine, sessionKey: string): ChatroomPickState | undefined {
  return pickers(e).chatroomPick.get(sessionKey)
}

/** The armed topic-picker state for a session key (undefined when none). */
export function getChatroomTopicPickState(e: Engine, sessionKey: string): ChatroomTopicPickState | undefined {
  return pickers(e).chatroomTopicPick.get(sessionKey)
}

/** Drop the armed role-picker state (picker cleared / reset). */
export function clearChatroomPickState(e: Engine, sessionKey: string): void {
  pickers(e).chatroomPick.delete(sessionKey)
}

function pickers(e: Engine): PickerStates {
  let m = pickerMaps.get(e)
  if (m === undefined) {
    m = { chatroomPick: new Map(), chatroomTopicPick: new Map() }
    pickerMaps.set(e, m)
  }
  return m
}

/**
 * Whether the session is in a picker's "picking" phase (moderator awake,
 * user hasn't confirmed). Used to auto-approve the moderator's ExitPlanMode.
 */
export function chatroomPickActive(e: Engine, sessionKey: string): boolean {
  const m = pickers(e)
  if (m.chatroomPick.get(sessionKey)?.phase === 'picking') return true
  if (m.chatroomTopicPick.get(sessionKey)?.phase === 'picking') return true
  return false
}

/** Reconstruct a reply context for proactive card sends (Go reconstructReplyCtx). */
async function reconstructReplyCtx(_e: Engine, p: Platform, sessionKey: string): Promise<unknown> {
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return undefined
  try {
    return await r.reconstructReplyCtx(sessionKey)
  } catch (error) {
    console.warn(`chatroom: reconstruct reply ctx failed (${sessionKey}): ${String(error)}`)
    return undefined
  }
}

/** A simple titled markdown card (Go e.simpleCard). */
function simpleCard(title: string, color: string, content: string): Card {
  return newCard().title(title, color).markdown(content).build()
}

// ── #43 role picker ───────────────────────────────────────────────────────

/**
 * /chatroom <topic> with no roles named: wake the moderator to recommend
 * roles and arm the picker state. No roles are spawned here.
 */
export function beginChatroomPick(e: Engine, p: Platform, msg: Message, topic: string): void {
  const rolesDir = e.chatroomRolesDir()
  const all = listRoleNames(rolesDir)
  if (all.length === 0) {
    throw new Error(e.i18n.t(MsgChatroomNoRolesConfigured))
  }
  // Bind the moderator workdir so the moderator agent runs in the chatroom home.
  const home = e.chatroomModeratorDir()
  if (home.ok) {
    e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(msg.sessionKey), home.dir)
    e.projectState?.save()
  }
  pickers(e).chatroomPick.set(msg.sessionKey, {
    phase: 'picking',
    topic,
    rolesDir,
    allNames: all,
    recs: [],
    selected: new Map(),
    hint: '',
    userTouched: false,
    userID: msg.userID,
    chatType: msg.chatType,
  })

  const cs = asCardSender(p)
  if (cs !== undefined) {
    void cs.sendCard(msg.replyCtx, simpleCard(e.i18n.t(MsgChatroomPickTitle), 'purple', e.i18n.t(MsgChatroomPickPicking))).catch(() => {})
  }

  armChatroomPickWatchdog(e, p, msg.sessionKey)

  try {
    e.receiveMessage(p, {
      ...emptyMessage(),
      sessionKey: msg.sessionKey,
      platform: p.name(),
      userID: msg.userID,
      userName: '[聊天室]',
      content: buildChatroomPickPriming(topic, all, rolesDir),
      replyCtx: msg.replyCtx,
    })
  } catch (error) {
    console.error(`engine: receive-message failed (${msg.sessionKey}): ${String(error)}`)
  }
}

/** Watchdog: render a fallback picker card (all roles, none recommended) if the moderator never calls pick-roles. */
function armChatroomPickWatchdog(e: Engine, p: Platform, hubKey: string): void {
  const timer = setTimeout(() => {
    const ps = pickers(e).chatroomPick.get(hubKey)
    if (ps === undefined || ps.phase !== 'picking') return
    ps.recs = ps.allNames.map(n => ({ name: n, recommended: false, blurb: '' }))
    ps.selected = new Map()
    ps.phase = 'select'
    ps.hint = '主持人未及时推荐，已列出全部角色供你自选。'
    const card = renderChatroomPickCard(e, ps)
    const cs = asCardSender(p)
    if (cs !== undefined) {
      void reconstructReplyCtx(e, p, hubKey).then((rctx) => {
        void cs.sendCard(rctx, card).catch(() => {})
      })
    }
  }, chatroomPickWatchdogTimeout)
  timer.unref()
}

/** Render the role picker card from the state (Go renderChatroomPickCard). */
export function renderChatroomPickCard(e: Engine, ps: ChatroomPickState): Card {
  const cb = newCard().title(e.i18n.t(MsgChatroomPickTitle), 'purple')
  cb.markdown(`### ${e.i18n.t(MsgChatroomTopicLabel)}\n${ps.topic}`)
  for (const r of ps.recs) {
    const sel = ps.selected.get(r.name) === true
    const marker = sel ? '☑' : '◻'
    let desc = `${marker} **${r.name}**`
    if (r.recommended) desc += `  「${e.i18n.t(MsgChatroomPickRecommended)}」`
    if (r.blurb !== '') desc += `\n${r.blurb}`
    const btnText = sel ? e.i18n.t(MsgChatroomPickSelected) : e.i18n.t(MsgChatroomPickSelect)
    const btnType = sel ? 'primary' : 'default'
    cb.listItemBtn(desc, btnText, btnType, `act:/chatroom-pick toggle ${r.name}`)
  }
  cb.taggedNote('chatroom-pick-count', e.i18n.tf(MsgChatroomPickSelectedCount, ps.selected.size))
  if (ps.hint !== '') cb.note(ps.hint)
  cb.buttons(
    { text: e.i18n.t(MsgChatroomPickConfirm), type: 'primary', value: 'act:/chatroom-pick confirm' },
    { text: e.i18n.t(MsgChatroomPickCancel), type: 'default', value: 'act:/chatroom-pick cancel' },
  )
  return cb.build()
}

/**
 * Validate the moderator's recommendations, flip to 'select', and push the
 * picker card to the hub group (Go RenderChatroomPickCard, the API entry).
 */
export function renderChatroomPickCardAndPush(e: Engine, hubKey: string, recs: ChatroomRolePick[]): void {
  const ps = pickers(e).chatroomPick.get(hubKey)
  // Accept 'select' too: the watchdog's fallback card must be overridable by
  // the moderator's late curated recommendations.
  if (ps === undefined) {
    throw new Error(`chatroom: picker not active for ${hubKey}`)
  }
  // Once the user has toggled any role on the rendered card, a late
  // pick-roles must NOT overwrite their selections or narrow recs.
  if (ps.userTouched) {
    console.info(`chatroom: ignoring late pick-roles; user already selecting (hub=${hubKey} selected=${ps.selected.size})`)
    return
  }
  const valid = new Set(ps.allNames)
  const kept: ChatroomRolePick[] = []
  for (const r of recs) {
    if (r.name === '' || !valid.has(r.name)) {
      console.warn(`chatroom: dropping hallucinated or empty role in pick-roles (role=${r.name} hub=${hubKey})`)
      continue
    }
    kept.push(r)
  }
  if (kept.length === 0) {
    throw new Error(`chatroom: pick-roles yielded no valid roles for ${hubKey}`)
  }
  ps.recs = kept
  ps.selected = new Map()
  // Cap preselection at the role limit so the user never lands on the picker
  // already over the max; extra recommended roles stay listed and selectable.
  const max = e.maxChatroomRoles()
  for (const r of kept) {
    if (r.recommended && ps.selected.size < max) ps.selected.set(r.name, true)
  }
  ps.phase = 'select'
  ps.hint = ''
  const card = renderChatroomPickCard(e, ps)

  const p = e.spawnCapablePlatform()
  if (p !== undefined) {
    const cs = asCardSender(p)
    if (cs !== undefined) {
      void reconstructReplyCtx(e, p, hubKey).then((rctx) => {
        void cs.sendCard(rctx, card).catch(() => {})
      })
    }
  }
}

/**
 * The picker state machine behind the /chatroom-pick card actions: toggle
 * selects/deselects a role; confirm dispatches to finalizeChatroomPick (1
 * role → direct mode, ≥2 → spawn + moderator); cancel clears the picker.
 */
export function executeChatroomPickAction(e: Engine, sessionKey: string, args: string): void {
  const ps = pickers(e).chatroomPick.get(sessionKey)
  if (ps === undefined) return
  const fields = args.split(/\s+/).filter(f => f !== '')
  if (fields.length === 0) return
  if (ps.phase !== 'select') return
  switch (fields[0]) {
    case 'toggle': {
      if (fields.length < 2) return
      const name = fields.slice(1).join(' ') // tolerate multi-word role names
      if (!ps.recs.some(r => r.name === name)) return
      // A valid toggle means the user has taken control of the picker.
      ps.userTouched = true
      if (ps.selected.get(name) === true) ps.selected.delete(name)
      else ps.selected.set(name, true)
      ps.hint = ''
      return
    }
    case 'confirm': {
      if (ps.selected.size === 0) {
        ps.hint = e.i18n.t(MsgChatroomPickEmpty)
        return
      }
      const max = e.maxChatroomRoles()
      if (ps.selected.size > max) {
        ps.hint = e.i18n.tf(MsgChatroomPickTooMany, ps.selected.size, max)
        return
      }
      const names = [...ps.selected.keys()].sort()
      const { topic, userID, chatType } = ps
      pickers(e).chatroomPick.delete(sessionKey) // clear before async dispatch
      void finalizeChatroomPick(e, sessionKey, names, topic, userID, chatType)
      return
    }
    case 'cancel':
      pickers(e).chatroomPick.delete(sessionKey)
      return
    default:
      return
  }
}

// ── #59 topic picker ──────────────────────────────────────────────────────

/**
 * /chatroom with no topic: the moderator scans the role directory and recent
 * notes, proposes candidate topics; the user picks one, then the #43 role
 * picker takes over (Go beginChatroomTopicPick).
 */
export function beginChatroomTopicPick(e: Engine, p: Platform, msg: Message): void {
  const rolesDir = e.chatroomRolesDir()
  const all = listRoleNames(rolesDir)
  if (all.length === 0) {
    throw new Error(e.i18n.t(MsgChatroomNoRolesConfigured))
  }
  const home = e.chatroomModeratorDir()
  if (home.ok) {
    e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(msg.sessionKey), home.dir)
    e.projectState?.save()
  }
  pickers(e).chatroomTopicPick.set(msg.sessionKey, {
    phase: 'picking',
    rolesDir,
    allNames: all,
    recs: [],
    selected: '',
    hint: '',
    userTouched: false,
    userID: msg.userID,
    chatType: msg.chatType,
  })

  const cs = asCardSender(p)
  if (cs !== undefined) {
    void cs.sendCard(msg.replyCtx, simpleCard(e.i18n.t(MsgChatroomTopicPickTitle), 'purple', e.i18n.t(MsgChatroomTopicPickPicking))).catch(() => {})
  }

  armChatroomTopicPickWatchdog(e, p, msg.sessionKey)

  try {
    e.receiveMessage(p, {
      ...emptyMessage(),
      sessionKey: msg.sessionKey,
      platform: p.name(),
      userID: msg.userID,
      userName: '[聊天室]',
      content: buildChatroomTopicPickPriming(all, rolesDir, home.dir),
      replyCtx: msg.replyCtx,
    })
  } catch (error) {
    console.error(`engine: receive-message failed (${msg.sessionKey}): ${String(error)}`)
  }
}

/** Watchdog: surface a hint card when the moderator never calls pick-topic (no enumerated fallback exists). */
function armChatroomTopicPickWatchdog(e: Engine, p: Platform, hubKey: string): void {
  const timer = setTimeout(() => {
    const ps = pickers(e).chatroomTopicPick.get(hubKey)
    if (ps === undefined || ps.phase !== 'picking') return
    ps.phase = 'select'
    ps.hint = e.i18n.t(MsgChatroomTopicPickWatchdogHint)
    const card = renderChatroomTopicPickCard(e, ps)
    const cs = asCardSender(p)
    if (cs !== undefined) {
      void reconstructReplyCtx(e, p, hubKey).then((rctx) => {
        void cs.sendCard(rctx, card).catch(() => {})
      })
    }
  }, chatroomPickWatchdogTimeout)
  timer.unref()
}

/** Render the single-select topic picker card (Go renderChatroomTopicPickCard). */
export function renderChatroomTopicPickCard(e: Engine, ps: ChatroomTopicPickState): Card {
  const cb = newCard().title(e.i18n.t(MsgChatroomTopicPickTitle), 'purple')
  for (const t of ps.recs) {
    const sel = ps.selected === t.title
    const marker = sel ? '◉' : '○'
    let desc = `${marker} **${t.title}**`
    if (t.recommended) desc += `  「${e.i18n.t(MsgChatroomPickRecommended)}」`
    if (t.blurb !== '') desc += `\n${t.blurb}`
    const btnText = sel ? e.i18n.t(MsgChatroomTopicPickPicked) : e.i18n.t(MsgChatroomTopicPickPick)
    const btnType = sel ? 'primary' : 'default'
    cb.listItemBtn(desc, btnText, btnType, `act:/chatroom-topic-pick toggle ${t.title}`)
  }
  if (ps.selected === '') {
    cb.taggedNote('chatroom-topic-pick-status', e.i18n.t(MsgChatroomTopicPickNotSelected))
  } else {
    cb.taggedNote('chatroom-topic-pick-status', e.i18n.tf(MsgChatroomTopicPickPickedHint, ps.selected))
  }
  if (ps.hint !== '') cb.note(ps.hint)
  cb.buttons(
    { text: e.i18n.t(MsgChatroomTopicPickConfirm), type: 'primary', value: 'act:/chatroom-topic-pick confirm' },
    { text: e.i18n.t(MsgChatroomTopicPickCancel), type: 'default', value: 'act:/chatroom-topic-pick cancel' },
  )
  return cb.build()
}

/** The #59 API entry: validate topics, flip to 'select', push the card (Go RenderChatroomTopicPickCard). */
export function renderChatroomTopicPickCardAndPush(e: Engine, hubKey: string, topics: ChatroomTopicPick[]): void {
  const ps = pickers(e).chatroomTopicPick.get(hubKey)
  if (ps === undefined) {
    throw new Error(`chatroom: topic-picker not active for ${hubKey}`)
  }
  // User has taken control; a late pick-topic must not overwrite.
  if (ps.userTouched) {
    console.info(`chatroom: ignoring late pick-topic; user already selecting (hub=${hubKey} selected=${ps.selected})`)
    return
  }
  // No whitelist (topics are free-form); just drop empties.
  const kept = topics.filter(t => t.title.trim() !== '')
  if (kept.length === 0) {
    throw new Error(`chatroom: pick-topic yielded no topics for ${hubKey}`)
  }
  ps.recs = kept
  // Single-select: pre-pick the first recommended topic (if any).
  ps.selected = ''
  for (const t of kept) {
    if (t.recommended) {
      ps.selected = t.title
      break
    }
  }
  ps.phase = 'select'
  ps.hint = ''
  const card = renderChatroomTopicPickCard(e, ps)

  const p = e.spawnCapablePlatform()
  if (p !== undefined) {
    const cs = asCardSender(p)
    if (cs !== undefined) {
      void reconstructReplyCtx(e, p, hubKey).then((rctx) => {
        void cs.sendCard(rctx, card).catch(() => {})
      })
    }
  }
}

/** The #59 single-select state machine behind the card actions (radio semantics). */
export function executeChatroomTopicPickAction(e: Engine, sessionKey: string, args: string): void {
  const ps = pickers(e).chatroomTopicPick.get(sessionKey)
  if (ps === undefined) return
  const fields = args.split(/\s+/).filter(f => f !== '')
  if (fields.length === 0) return
  if (ps.phase !== 'select') return
  switch (fields[0]) {
    case 'toggle': {
      if (fields.length < 2) return
      const title = fields.slice(1).join(' ') // tolerate multi-word topics
      if (!ps.recs.some(t => t.title === title)) return
      ps.userTouched = true
      if (ps.selected === title) ps.selected = '' // allow deselect
      else ps.selected = title // radio: overwrite any previous pick
      ps.hint = ''
      return
    }
    case 'confirm': {
      if (ps.selected === '') {
        ps.hint = e.i18n.t(MsgChatroomTopicPickEmpty)
        return
      }
      const { selected: topic, userID, chatType } = ps
      pickers(e).chatroomTopicPick.delete(sessionKey) // clear before async dispatch
      void finalizeChatroomTopicPick(e, sessionKey, topic, userID, chatType)
      return
    }
    case 'cancel':
      pickers(e).chatroomTopicPick.delete(sessionKey)
      return
    default:
      return
  }
}

// ── card-action entry (Go handleCardNav's chatroom-pick branches) ─────────

/**
 * Run one picker card action and build the replacement card: the state
 * machine executes first (Go executeCardAction), then the reply card renders
 * (cancelled / re-rendered picker with hint / transitional starting card).
 * Returns undefined when there is nothing to swap in (unknown toggle).
 */
export function executeChatroomCardAction(e: Engine, sessionKey: string, cmd: string, args: string): Card | undefined {

  if (cmd === '/chatroom-pick') {
    executeChatroomPickAction(e, sessionKey, args)
    if (args.startsWith('cancel')) {
      return simpleCard(e.i18n.t(MsgChatroomPickTitle), 'grey', e.i18n.t('chatroom_pick_cancelled'))
    }
    if (args.startsWith('confirm')) {
      // executeChatroomPickAction may have refused to confirm (empty or
      // over-max) and left the picker alive; re-render it with its hint.
      const ps = pickers(e).chatroomPick.get(sessionKey)
      if (ps !== undefined && ps.phase === 'select') return renderChatroomPickCard(e, ps)
      return simpleCard(e.i18n.t(MsgChatroomPickTitle), 'purple', e.i18n.t('chatroom_pick_starting'))
    }
    // toggle: re-render the picker from current state.
    const ps = pickers(e).chatroomPick.get(sessionKey)
    if (ps === undefined || ps.phase !== 'select') return undefined
    return renderChatroomPickCard(e, ps)
  }
  if (cmd === '/chatroom-topic-pick') {
    executeChatroomTopicPickAction(e, sessionKey, args)
    if (args.startsWith('cancel')) {
      return simpleCard(e.i18n.t(MsgChatroomTopicPickTitle), 'grey', e.i18n.t('chatroom_topic_pick_cancelled'))
    }
    if (args.startsWith('confirm')) {
      // The state machine already cleared state + armed the async finalize;
      // show a transitional card in place of the picker.
      return simpleCard(e.i18n.t(MsgChatroomTopicPickTitle), 'purple', e.i18n.t('chatroom_topic_pick_starting'))
    }
    const ps = pickers(e).chatroomTopicPick.get(sessionKey)
    if (ps === undefined || ps.phase !== 'select') return undefined
    return renderChatroomTopicPickCard(e, ps)
  }
  return undefined
}

// ── finalize dispatch ─────────────────────────────────────────────────────

/** Picker confirm dispatch: 1 selected role → direct mode; ≥2 → spawn + wake moderator. */
async function finalizeChatroomPick(
  e: Engine, hubKey: string, names: string[], topic: string, userID: string, chatType: string,
): Promise<void> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) {
    console.warn(`chatroom: pick finalize: no spawn-capable platform (hub=${hubKey})`)
    return
  }
  const rctx = await reconstructReplyCtx(e, p, hubKey)
  if (names.length === 1) {
    // A single confirmed role becomes a 1:1 direct chat — reject a stashed
    // --research flag instead of silently dropping it.
    const hub = e.sessions.getOrCreateActive(hubKey)
    if (hub.getChatroomResearch()) {
      void e.reply(p, rctx, e.i18n.t('chatroom_research_single_role'))
      clearChatroomResearchFlags(hub)
      e.sessions.save()
      return
    }
    const msg: Message = { ...emptyMessage(), sessionKey: hubKey, platform: p.name(), replyCtx: rctx, chatType }
    await startChatroomDirectRole(e, p, msg, names[0] ?? '', topic)
    return
  }
  let started
  try {
    started = await startChatroom(e, hubKey, names, topic)
  } catch (error) {
    console.warn(`chatroom: pick finalize StartChatroom failed (hub=${hubKey}): ${String(error)}`)
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t('chatroom_ready'), color: 'red' })
    return
  }
  await afterChatroomStarted(e, p, hubKey, userID, chatType, rctx, started, topic)
}

/** Topic-pick confirm: hand off to the #43 role picker (Go finalizeChatroomTopicPick). */
async function finalizeChatroomTopicPick(
  e: Engine, hubKey: string, topic: string, userID: string, chatType: string,
): Promise<void> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) {
    console.warn(`chatroom: topic-pick finalize: no spawn-capable platform (hub=${hubKey})`)
    return
  }
  const rctx = await reconstructReplyCtx(e, p, hubKey)
  const msg: Message = {
    ...emptyMessage(),
    sessionKey: hubKey,
    platform: p.name(),
    userID,
    userName: '[聊天室]',
    replyCtx: rctx,
    chatType,
  }
  try {
    beginChatroomPick(e, p, msg, topic)
  } catch (error) {
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(MsgChatroomTopicPickTitle), color: 'red' })
  }
}
