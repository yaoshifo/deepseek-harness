/**
 * Chatroom interactive pickers ported from cc-connect core/engine_chatroom.go
 * (beginChatroomPick / RenderChatroomPickCard / executeChatroomPickAction in
 * engine_cmd_card.go): the #43 role picker and the #59 topic picker, plus the
 * guided start picker (new discussion vs continue a past chatroom) and the
 * guided mode picker (plain / research-auto / research-manual) that replace
 * unstated --continue / --research / --mode flags with one-tap cards. Picker
 * state lives on engine-keyed maps, guarded by the single-threaded JS event
 * loop.
 *
 * @module dsh-feishu-bridge/chatroom-pick
 */

import type { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { emptyMessage } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Message, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { asCardSender, asReplyContextReconstructor } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { newCard } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Card } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { Msg } from '../i18n.ts'
import { chatroomState } from '../chatroom-state.ts'
import { chatroomConfig } from '../chatroom-config.ts'
import type { ChatroomHistoryEntry } from './chatroom-ledger.ts'
import { readChatroomLedgerHeader } from './chatroom-ledger.ts'
import { listRoleNames } from './chatroom-roles.ts'
import { buildChatroomPickPriming, buildChatroomTopicPickPriming } from './chatroom-priming.ts'
import { chatroomResearchWorkspace, clearChatroomResearchFlags, ensureResearchPythonEnv, startChatroom } from './chatroom.ts'
import type { ChatroomInheritTarget } from './chatroom.ts'
import { afterChatroomStarted, startChatroomDirectRole, stashChatroomResearchFlags } from './chatroom-cmd.ts'

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
 * The guided start-picker state: the new-vs-continue choice offered when a
 * bare /chatroom finds recorded chatrooms. No picking phase — the card is
 * rendered from the ledger snapshot without waking the moderator.
 */
export interface ChatroomStartPickState {
  /** Ledger snapshot, newest first (bounded by the caller). */
  history: ChatroomHistoryEntry[]
  userID: string
  chatType: string
}

/**
 * The guided mode-picker state: the plain / research-auto / research-manual
 * choice offered before any multi-role start whose mode the user did not
 * state explicitly. Armed with the topic, cast, and (when continuing) the
 * resolved prior; the buttons start the chatroom directly.
 */
export interface ChatroomModePickState {
  topic: string
  roles: string[]
  /** Resolved prior when the flow continues a past chatroom. */
  prior?: ChatroomInheritTarget
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
  chatroomStartPick: Map<string, ChatroomStartPickState>
  chatroomModePick: Map<string, ChatroomModePickState>
}

const pickerMaps = new WeakMap<Engine, PickerStates>()

/** The armed role-picker state for a session key (undefined when none).
 *
 * @param e - Engine owning the picker maps.
 * @param sessionKey - Hub session key.
 * @returns the armed role-picker state, or undefined when none.
 */
export function getChatroomPickState(e: Engine, sessionKey: string): ChatroomPickState | undefined {
  return pickers(e).chatroomPick.get(sessionKey)
}

/** The armed topic-picker state for a session key (undefined when none).
 *
 * @param e - Engine owning the picker maps.
 * @param sessionKey - Hub session key.
 * @returns the armed topic-picker state, or undefined when none.
 */
export function getChatroomTopicPickState(e: Engine, sessionKey: string): ChatroomTopicPickState | undefined {
  return pickers(e).chatroomTopicPick.get(sessionKey)
}

/** The armed guided start-picker state for a session key (undefined when none).
 *
 * @param e - Engine owning the picker maps.
 * @param sessionKey - Hub session key.
 * @returns the armed start-picker state, or undefined when none.
 */
export function getChatroomStartPickState(e: Engine, sessionKey: string): ChatroomStartPickState | undefined {
  return pickers(e).chatroomStartPick.get(sessionKey)
}

/** The armed guided mode-picker state for a session key (undefined when none).
 *
 * @param e - Engine owning the picker maps.
 * @param sessionKey - Hub session key.
 * @returns the armed mode-picker state, or undefined when none.
 */
export function getChatroomModePickState(e: Engine, sessionKey: string): ChatroomModePickState | undefined {
  return pickers(e).chatroomModePick.get(sessionKey)
}

/** Drop the armed role-picker state (picker cleared / reset).
 *
 * @param e - Engine owning the picker maps.
 * @param sessionKey - Hub session key whose picker state is dropped.
 */
export function clearChatroomPickState(e: Engine, sessionKey: string): void {
  pickers(e).chatroomPick.delete(sessionKey)
}

function pickers(e: Engine): PickerStates {
  let m = pickerMaps.get(e)
  if (m === undefined) {
    m = { chatroomPick: new Map(), chatroomTopicPick: new Map(), chatroomStartPick: new Map(), chatroomModePick: new Map() }
    pickerMaps.set(e, m)
  }
  return m
}

/**
 * Whether the session is in a picker's "picking" phase (moderator awake,
 * user hasn't confirmed). Used to auto-approve the moderator's ExitPlanMode.
 *
 * @param e - Engine owning the picker maps.
 * @param sessionKey - Hub session key.
 * @returns true when either picker is in its picking phase.
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
 *
 * @param e - Engine whose moderator agent is woken.
 * @param p - Platform used for the picking notice card and the wake message.
 * @param msg - Triggering message; its session key becomes the hub.
 * @param topic - Topic the moderator recommends roles for.
 */
export function beginChatroomPick(e: Engine, p: Platform, msg: Message, topic: string): void {
  const rolesDir = chatroomConfig(e).rolesDir()
  const all = listRoleNames(rolesDir)
  if (all.length === 0) {
    throw new Error(e.i18n.t(Msg.ChatroomNoRolesConfigured))
  }
  // Bind the moderator workdir so the moderator agent runs in the chatroom home.
  const home = chatroomConfig(e).moderatorDir()
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
    void cs.sendCard(msg.replyCtx, simpleCard(e.i18n.t(Msg.ChatroomPickTitle), 'purple', e.i18n.t(Msg.ChatroomPickPicking))).catch(() => {
      // Best-effort picking notice; the moderator wake right below carries the real signal.
    })
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
      // One-shot mode override: the pick turn must not run the plan-mode
      // dance (a live hub agent process bypasses this; the engine's pick
      // auto-approve remains the backstop there).
      modeOverride: 'default',
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
    ps.hint = e.i18n.t(Msg.ChatroomRolePickWatchdogHint)
    const card = renderChatroomPickCard(e, ps)
    const cs = asCardSender(p)
    if (cs !== undefined) {
      void reconstructReplyCtx(e, p, hubKey).then((rctx) => {
        void cs.sendCard(rctx, card).catch(() => {
          // Best-effort watchdog fallback card; the hint is advisory — the user can re-run /chatroom.
        })
      })
    }
  }, chatroomPickWatchdogTimeout)
  timer.unref()
}

/** Render the role picker card from the state (Go renderChatroomPickCard).
 *
 * @param e - Engine providing i18n strings.
 * @param ps - Role-picker state to render.
 * @returns the role picker card.
 */
export function renderChatroomPickCard(e: Engine, ps: ChatroomPickState): Card {
  const cb = newCard().title(e.i18n.t(Msg.ChatroomPickTitle), 'purple')
  cb.markdown(`### ${e.i18n.t(Msg.ChatroomTopicLabel)}\n${ps.topic}`)
  for (const r of ps.recs) {
    const sel = ps.selected.get(r.name) === true
    const marker = sel ? '☑' : '◻'
    let desc = `${marker} **${r.name}**`
    if (r.recommended) desc += `  「${e.i18n.t(Msg.ChatroomPickRecommended)}」`
    if (r.blurb !== '') desc += `\n${r.blurb}`
    const btnText = sel ? e.i18n.t(Msg.ChatroomPickSelected) : e.i18n.t(Msg.ChatroomPickSelect)
    const btnType = sel ? 'primary' : 'default'
    cb.listItemBtn(desc, btnText, btnType, `act:/chatroom-pick toggle ${r.name}`)
  }
  cb.taggedNote('chatroom-pick-count', e.i18n.tf(Msg.ChatroomPickSelectedCount, ps.selected.size))
  if (ps.hint !== '') cb.note(ps.hint)
  cb.buttons(
    { text: e.i18n.t(Msg.ChatroomPickConfirm), type: 'primary', value: 'act:/chatroom-pick confirm' },
    { text: e.i18n.t(Msg.ChatroomPickCancel), type: 'default', value: 'act:/chatroom-pick cancel' },
  )
  return cb.build()
}

/**
 * Validate the moderator's recommendations, flip to 'select', and push the
 * picker card to the hub group (Go RenderChatroomPickCard, the API entry).
 *
 * @param e - Engine owning the picker state.
 * @param hubKey - Hub session key the picker is armed on.
 * @param recs - Moderator recommendations to validate and preselect from.
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
  const max = chatroomConfig(e).maxRoles()
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
        void cs.sendCard(rctx, card).catch(() => {
          // Best-effort pick-card push; the moderator turn already ended, so a
          // failed card leaves the user to re-run /chatroom.
        })
      })
    }
  }
}

/**
 * The picker state machine behind the /chatroom-pick card actions: toggle
 * selects/deselects a role; confirm dispatches to finalizeChatroomPick (1
 * role → direct mode, ≥2 → spawn + moderator); cancel clears the picker.
 *
 * @param e - Engine owning the picker state.
 * @param sessionKey - Hub session key the card action targets.
 * @param args - Space-separated action words: 'toggle <name>', 'confirm', or 'cancel'.
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
        ps.hint = e.i18n.t(Msg.ChatroomPickEmpty)
        return
      }
      const max = chatroomConfig(e).maxRoles()
      if (ps.selected.size > max) {
        ps.hint = e.i18n.tf(Msg.ChatroomPickTooMany, ps.selected.size, max)
        return
      }
      const names = [...ps.selected.keys()].sort()
      const { topic, userID, chatType } = ps
      pickers(e).chatroomPick.delete(sessionKey) // clear before async dispatch
      // A multi-role cast whose mode the user did not state explicitly goes
      // through the mode picker — the confirm card swaps into it in place.
      // Single-role casts start the direct chat; an explicitly-stashed
      // --research skips the card (the decision is already made).
      if (names.length >= 2 && !chatroomState(e.sessions.getOrCreateActive(sessionKey)).chatroomResearch) {
        pickers(e).chatroomModePick.set(sessionKey, { topic, roles: names, userID, chatType })
        return
      }
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

// ── guided start picker ────────────────────────────────────────────────────

/**
 * Bare /chatroom with recorded chatrooms: arm the start-picker state and
 * send the new-vs-continue card. No moderator wake — the card renders from
 * the ledger snapshot the caller captured.
 *
 * @param e - Engine owning the picker maps.
 * @param p - Platform used for the card send.
 * @param msg - Triggering message; its session key becomes the hub.
 * @param history - Ledger snapshot, newest first; must be non-empty.
 */
export function beginChatroomStartPick(e: Engine, p: Platform, msg: Message, history: ChatroomHistoryEntry[]): void {
  if (history.length === 0) throw new Error('chatroom: start picker requires a non-empty history snapshot')
  pickers(e).chatroomStartPick.set(msg.sessionKey, {
    history,
    userID: msg.userID,
    chatType: msg.chatType,
  })
  const cs = asCardSender(p)
  if (cs !== undefined) {
    void cs.sendCard(msg.replyCtx, renderChatroomStartPickCard(e, history)).catch(() => {
      // Best-effort start card; the user can re-run /chatroom.
    })
  }
}

/** Render the new-vs-continue start card from the ledger snapshot.
 *
 * @param e - Engine providing i18n strings.
 * @param history - Ledger snapshot, newest first.
 * @returns the start picker card.
 */
export function renderChatroomStartPickCard(e: Engine, history: ChatroomHistoryEntry[]): Card {
  const cb = newCard().title(e.i18n.t(Msg.ChatroomStartPickTitle), 'purple')
  cb.markdown(e.i18n.t(Msg.ChatroomStartPickHint))
  cb.listItemBtn(
    `**${e.i18n.t(Msg.ChatroomStartPickNew)}**\n${e.i18n.t(Msg.ChatroomStartPickNewBlurb)}`,
    e.i18n.t(Msg.ChatroomStartPickNew),
    'primary',
    'act:/chatroom-start-pick new',
  )
  history.forEach((h, i) => {
    cb.listItemBtn(
      `**${e.i18n.t(Msg.ChatroomStartPickContinue)}：${h.header.topic}**\n`
        + e.i18n.tf(Msg.ChatroomStartPickHistoryBlurb, h.header.roles.join(', '), h.header.started),
      e.i18n.t(Msg.ChatroomStartPickContinue),
      'default',
      `act:/chatroom-start-pick continue ${i}`,
    )
  })
  cb.buttons({ text: e.i18n.t(Msg.ChatroomPickCancel), type: 'default', value: 'act:/chatroom-start-pick cancel' })
  return cb.build()
}

/** Render the plain / research-auto / research-manual mode card.
 *
 * @param e - Engine providing i18n strings.
 * @param ms - Mode-picker state to render.
 * @returns the mode picker card.
 */
export function renderChatroomModePickCard(e: Engine, ms: ChatroomModePickState): Card {
  const cb = newCard().title(e.i18n.t(Msg.ChatroomModePickTitle), 'purple')
  let body = `### ${e.i18n.t(Msg.ChatroomTopicLabel)}\n${ms.topic}\n${ms.roles.join(', ')}`
  if (ms.prior !== undefined) body += `\n${e.i18n.tf(Msg.ChatroomInheritNote, ms.prior.topic)}`
  cb.markdown(body)
  cb.listItemBtn(
    `**${e.i18n.t(Msg.ChatroomModePlain)}**\n${e.i18n.t(Msg.ChatroomModePlainBlurb)}`,
    e.i18n.t(Msg.ChatroomModePickStart), 'primary', 'act:/chatroom-mode-pick start plain',
  )
  cb.listItemBtn(
    `**${e.i18n.t(Msg.ChatroomModeResearchAuto)}**\n${e.i18n.t(Msg.ChatroomModeResearchAutoBlurb)}`,
    e.i18n.t(Msg.ChatroomModePickStart), 'default', 'act:/chatroom-mode-pick start research-auto',
  )
  cb.listItemBtn(
    `**${e.i18n.t(Msg.ChatroomModeResearchManual)}**\n${e.i18n.t(Msg.ChatroomModeResearchManualBlurb)}`,
    e.i18n.t(Msg.ChatroomModePickStart), 'default', 'act:/chatroom-mode-pick start research-manual',
  )
  cb.buttons({ text: e.i18n.t(Msg.ChatroomPickCancel), type: 'default', value: 'act:/chatroom-mode-pick cancel' })
  return cb.build()
}

/**
 * The start-picker state machine behind the card actions: 'new' dispatches
 * the async handoff to the topic picker; 'continue <i>' re-validates the
 * snapshot entry and either arms the mode picker (mode undecided) or starts
 * directly (explicit --research already stashed); 'cancel' clears the state.
 *
 * @param e - Engine owning the picker state.
 * @param sessionKey - Hub session key the card action targets.
 * @param args - Space-separated action words: 'new', 'continue <i>', or 'cancel'.
 * @returns the outcome for the card wrapper: '' (no-op), 'new', 'cancel',
 *   'continue-armed', 'continue-starting', 'continue-roles', or 'continue-gone'.
 */
export function executeChatroomStartPickAction(e: Engine, sessionKey: string, args: string): '' | 'new' | 'cancel' | 'continue-armed' | 'continue-starting' | 'continue-roles' | 'continue-gone' {
  const ps = pickers(e).chatroomStartPick.get(sessionKey)
  if (ps === undefined) return ''
  const fields = args.split(/\s+/).filter(f => f !== '')
  if (fields.length === 0) return ''
  switch (fields[0]) {
    case 'new': {
      pickers(e).chatroomStartPick.delete(sessionKey) // clear before async dispatch
      void finalizeChatroomStartPickNew(e, sessionKey, ps.userID, ps.chatType)
      return 'new'
    }
    case 'continue': {
      const idx = Number.parseInt(fields[1] ?? '', 10)
      if (!Number.isInteger(idx) || idx < 0 || idx >= ps.history.length) return ''
      const entry = ps.history[idx]
      if (entry === undefined) return ''
      // The ledger dir may have been deleted since the card was rendered;
      // continuing a dangling pointer would fail deep inside the moderator.
      if (readChatroomLedgerHeader(entry.dir) === undefined) {
        pickers(e).chatroomStartPick.delete(sessionKey)
        return 'continue-gone'
      }
      const prior: ChatroomInheritTarget = { topic: entry.header.topic, dir: entry.dir, roles: [...entry.header.roles] }
      pickers(e).chatroomStartPick.delete(sessionKey)
      // An empty-cast prior falls through to the role picker, matching the
      // explicit --continue path (the picker chain carries no prior).
      if (prior.roles.length === 0) {
        void finalizeChatroomStartPickRoles(e, sessionKey, prior.topic, ps.userID, ps.chatType)
        return 'continue-roles'
      }
      const ms: ChatroomModePickState = { topic: prior.topic, roles: [...prior.roles], prior, userID: ps.userID, chatType: ps.chatType }
      // Research already decided (explicit --research): start now, no mode card.
      if (chatroomState(e.sessions.getOrCreateActive(sessionKey)).chatroomResearch) {
        void finalizeChatroomStart(e, sessionKey, ms)
        return 'continue-starting'
      }
      pickers(e).chatroomModePick.set(sessionKey, ms)
      return 'continue-armed'
    }
    case 'cancel':
      pickers(e).chatroomStartPick.delete(sessionKey)
      return 'cancel'
    default:
      return ''
  }
}

/** Start-pick 'new': hand off to the #59 topic picker (async rctx reconstruct). */
async function finalizeChatroomStartPickNew(e: Engine, hubKey: string, userID: string, chatType: string): Promise<void> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) {
    console.warn(`chatroom: start-pick finalize: no spawn-capable platform (hub=${hubKey})`)
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
    beginChatroomTopicPick(e, p, msg)
  } catch (error) {
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(Msg.ChatroomStartPickTitle), color: 'red' })
  }
}

/** Start-pick 'continue' with an empty-cast prior: hand off to the #43 role picker. */
async function finalizeChatroomStartPickRoles(e: Engine, hubKey: string, topic: string, userID: string, chatType: string): Promise<void> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) {
    console.warn(`chatroom: start-pick finalize: no spawn-capable platform (hub=${hubKey})`)
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
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(Msg.ChatroomStartPickTitle), color: 'red' })
  }
}

/** Start a chatroom whose mode flags are already stashed on the hub session. */
async function finalizeChatroomStart(e: Engine, hubKey: string, ms: ChatroomModePickState): Promise<void> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) {
    console.warn(`chatroom: start finalize: no spawn-capable platform (hub=${hubKey})`)
    return
  }
  const rctx = await reconstructReplyCtx(e, p, hubKey)
  let started
  try {
    started = await startChatroom(e, hubKey, ms.roles, ms.topic, ms.prior)
  } catch (error) {
    console.warn(`chatroom: start finalize StartChatroom failed (hub=${hubKey}): ${String(error)}`)
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(Msg.ChatroomReady), color: 'red' })
    return
  }
  await afterChatroomStarted(e, p, hubKey, ms.userID, ms.chatType, rctx, started, ms.topic, ms.prior)
}

/**
 * The mode-picker state machine behind the card actions: 'start
 * <plain|research-auto|research-manual>' stashes the mode's research flags
 * and dispatches the async start (research modes gate on the shared venv);
 * 'cancel' clears the state.
 *
 * @param e - Engine owning the picker state.
 * @param sessionKey - Hub session key the card action targets.
 * @param args - Space-separated action words: 'start <mode>' or 'cancel'.
 * @returns the outcome for the card wrapper: '' (no-op), 'start', or 'cancel'.
 */
export function executeChatroomModePickAction(e: Engine, sessionKey: string, args: string): '' | 'start' | 'cancel' {
  const ps = pickers(e).chatroomModePick.get(sessionKey)
  if (ps === undefined) return ''
  const fields = args.split(/\s+/).filter(f => f !== '')
  if (fields.length === 0) return ''
  switch (fields[0]) {
    case 'start': {
      if (fields[1] !== 'plain' && fields[1] !== 'research-auto' && fields[1] !== 'research-manual') return ''
      const mode = fields[1]
      pickers(e).chatroomModePick.delete(sessionKey) // clear before async dispatch
      void finalizeChatroomModePickStart(e, sessionKey, ps, mode)
      return 'start'
    }
    case 'cancel':
      pickers(e).chatroomModePick.delete(sessionKey)
      return 'cancel'
    default:
      return ''
  }
}

/** Mode-pick start: stash the chosen mode's flags, gate research on the shared venv, then start. */
async function finalizeChatroomModePickStart(
  e: Engine, hubKey: string, ms: ChatroomModePickState, mode: 'plain' | 'research-auto' | 'research-manual',
): Promise<void> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) {
    console.warn(`chatroom: mode-pick finalize: no spawn-capable platform (hub=${hubKey})`)
    return
  }
  const rctx = await reconstructReplyCtx(e, p, hubKey)
  stashChatroomResearchFlags(e, hubKey, mode !== 'plain', mode === 'research-auto' ? 'auto' : 'manual')
  if (mode !== 'plain') {
    try {
      await ensureResearchPythonEnv(e, chatroomResearchWorkspace(e))
    } catch (error) {
      console.warn(`chatroom: research venv provisioning failed; blocking startup (hub=${hubKey}): ${String(error)}`)
      void e.sendAsCard(p, rctx, e.i18n.t(Msg.ChatroomResearchNeedsUv), { title: e.i18n.t(Msg.ChatroomModePickTitle), color: 'red' })
      return
    }
  }
  let started
  try {
    started = await startChatroom(e, hubKey, ms.roles, ms.topic, ms.prior)
  } catch (error) {
    console.warn(`chatroom: mode-pick finalize StartChatroom failed (hub=${hubKey}): ${String(error)}`)
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(Msg.ChatroomReady), color: 'red' })
    return
  }
  await afterChatroomStarted(e, p, hubKey, ms.userID, ms.chatType, rctx, started, ms.topic, ms.prior)
}

/**
 * A multi-role start whose mode the user did not state explicitly: arm the
 * mode-picker state and send the mode card (no moderator wake). Used by the
 * explicit `/chatroom <roles> <topic>` command path; the picker flows arm
 * the state inline on confirm.
 *
 * @param e - Engine owning the picker maps.
 * @param p - Platform used for the card send.
 * @param msg - Triggering message; its session key becomes the hub.
 * @param topic - Discussion topic.
 * @param roles - Role names to start once the mode is picked.
 * @param prior - Resolved inherit target when continuing a past chatroom.
 */
export function beginChatroomModePick(
  e: Engine, p: Platform, msg: Message, topic: string, roles: string[], prior?: ChatroomInheritTarget,
): void {
  const ms: ChatroomModePickState = {
    topic,
    roles: [...roles],
    ...(prior !== undefined ? { prior } : {}),
    userID: msg.userID,
    chatType: msg.chatType,
  }
  pickers(e).chatroomModePick.set(msg.sessionKey, ms)
  const cs = asCardSender(p)
  if (cs !== undefined) {
    void cs.sendCard(msg.replyCtx, renderChatroomModePickCard(e, ms)).catch(() => {
      // Best-effort mode card; the user can re-run /chatroom.
    })
  }
}

// ── #59 topic picker ──────────────────────────────────────────────────────

/**
 * /chatroom with no topic: the moderator scans the role directory and recent
 * notes, proposes candidate topics; the user picks one, then the #43 role
 * picker takes over (Go beginChatroomTopicPick).
 *
 * @param e - Engine whose moderator agent is woken.
 * @param p - Platform used for the picking notice card and the wake message.
 * @param msg - Triggering message; its session key becomes the hub.
 */
export function beginChatroomTopicPick(e: Engine, p: Platform, msg: Message): void {
  const rolesDir = chatroomConfig(e).rolesDir()
  const all = listRoleNames(rolesDir)
  if (all.length === 0) {
    throw new Error(e.i18n.t(Msg.ChatroomNoRolesConfigured))
  }
  const home = chatroomConfig(e).moderatorDir()
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
    void cs.sendCard(msg.replyCtx, simpleCard(e.i18n.t(Msg.ChatroomTopicPickTitle), 'purple', e.i18n.t(Msg.ChatroomTopicPickPicking))).catch(() => {
      // Best-effort picking notice; the moderator wake right below carries the real signal.
    })
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
      // Same one-shot override as the role picker: keep plan mode off the
      // topic-suggestion turn.
      modeOverride: 'default',
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
    ps.hint = e.i18n.t(Msg.ChatroomTopicPickWatchdogHint)
    const card = renderChatroomTopicPickCard(e, ps)
    const cs = asCardSender(p)
    if (cs !== undefined) {
      void reconstructReplyCtx(e, p, hubKey).then((rctx) => {
        void cs.sendCard(rctx, card).catch(() => {
          // Best-effort watchdog hint card; the hint is advisory — the user can re-run /chatroom.
        })
      })
    }
  }, chatroomPickWatchdogTimeout)
  timer.unref()
}

/** Render the single-select topic picker card (Go renderChatroomTopicPickCard).
 *
 * @param e - Engine providing i18n strings.
 * @param ps - Topic-picker state to render.
 * @returns the single-select topic picker card.
 */
export function renderChatroomTopicPickCard(e: Engine, ps: ChatroomTopicPickState): Card {
  const cb = newCard().title(e.i18n.t(Msg.ChatroomTopicPickTitle), 'purple')
  for (const t of ps.recs) {
    const sel = ps.selected === t.title
    const marker = sel ? '◉' : '○'
    let desc = `${marker} **${t.title}**`
    if (t.recommended) desc += `  「${e.i18n.t(Msg.ChatroomPickRecommended)}」`
    if (t.blurb !== '') desc += `\n${t.blurb}`
    const btnText = sel ? e.i18n.t(Msg.ChatroomTopicPickPicked) : e.i18n.t(Msg.ChatroomTopicPickPick)
    const btnType = sel ? 'primary' : 'default'
    cb.listItemBtn(desc, btnText, btnType, `act:/chatroom-topic-pick toggle ${t.title}`)
  }
  if (ps.selected === '') {
    cb.taggedNote('chatroom-topic-pick-status', e.i18n.t(Msg.ChatroomTopicPickNotSelected))
  } else {
    cb.taggedNote('chatroom-topic-pick-status', e.i18n.tf(Msg.ChatroomTopicPickPickedHint, ps.selected))
  }
  if (ps.hint !== '') cb.note(ps.hint)
  cb.buttons(
    { text: e.i18n.t(Msg.ChatroomTopicPickConfirm), type: 'primary', value: 'act:/chatroom-topic-pick confirm' },
    { text: e.i18n.t(Msg.ChatroomTopicPickCancel), type: 'default', value: 'act:/chatroom-topic-pick cancel' },
  )
  return cb.build()
}

/** The #59 API entry: validate topics, flip to 'select', push the card (Go RenderChatroomTopicPickCard).
 *
 * @param e - Engine owning the picker state.
 * @param hubKey - Hub session key the picker is armed on.
 * @param topics - Moderator-proposed candidate topics to display.
 */
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
        void cs.sendCard(rctx, card).catch(() => {
          // Best-effort topic-card push; the moderator turn already ended, so a
          // failed card leaves the user to re-run /chatroom.
        })
      })
    }
  }
}

/** The #59 single-select state machine behind the card actions (radio semantics).
 *
 * @param e - Engine owning the picker state.
 * @param sessionKey - Hub session key the card action targets.
 * @param args - Space-separated action words: 'toggle <title>', 'confirm', or 'cancel'.
 */
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
        ps.hint = e.i18n.t(Msg.ChatroomTopicPickEmpty)
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
 *
 * @param e - Engine owning the picker states.
 * @param sessionKey - Hub session key the card action targets.
 * @param cmd - Card command path: '/chatroom-pick' or '/chatroom-topic-pick'.
 * @param args - Action words forwarded to the picker state machine.
 * @returns the replacement card, or undefined when nothing should swap in.
 */
export function executeChatroomCardAction(e: Engine, sessionKey: string, cmd: string, args: string): Card | undefined {
  // A picker with no armed state is an orphaned card (the engine-keyed maps
  // died with a daemon restart or the pick watchdog): every action swaps the
  // pressed card for the expired card — confirm used to reply 正在启动
  // while starting nothing, and toggle was silently consumed.

  if (cmd === '/chatroom-start-pick') {
    if (pickers(e).chatroomStartPick.get(sessionKey) === undefined) {
      return simpleCard(e.i18n.t(Msg.ChatroomStartPickTitle), 'grey', e.i18n.t(Msg.ChatroomPickExpired))
    }
    const outcome = executeChatroomStartPickAction(e, sessionKey, args)
    switch (outcome) {
      case 'cancel':
        return simpleCard(e.i18n.t(Msg.ChatroomStartPickTitle), 'grey', e.i18n.t(Msg.ChatroomStartPickCancelled))
      case 'new':
        return simpleCard(e.i18n.t(Msg.ChatroomStartPickTitle), 'purple', e.i18n.t(Msg.ChatroomStartPickToTopic))
      case 'continue-armed': {
        const ms = pickers(e).chatroomModePick.get(sessionKey)
        return ms === undefined ? undefined : renderChatroomModePickCard(e, ms)
      }
      case 'continue-starting':
        return simpleCard(e.i18n.t(Msg.ChatroomStartPickTitle), 'purple', e.i18n.t(Msg.ChatroomPickStarting))
      case 'continue-roles':
        return simpleCard(e.i18n.t(Msg.ChatroomStartPickTitle), 'purple', e.i18n.t(Msg.ChatroomStartPickToRoles))
      case 'continue-gone':
        return simpleCard(e.i18n.t(Msg.ChatroomStartPickTitle), 'grey', e.i18n.t(Msg.ChatroomStartPickGone))
      default:
        return undefined
    }
  }
  if (cmd === '/chatroom-mode-pick') {
    if (pickers(e).chatroomModePick.get(sessionKey) === undefined) {
      return simpleCard(e.i18n.t(Msg.ChatroomModePickTitle), 'grey', e.i18n.t(Msg.ChatroomPickExpired))
    }
    const outcome = executeChatroomModePickAction(e, sessionKey, args)
    if (outcome === 'cancel') {
      return simpleCard(e.i18n.t(Msg.ChatroomModePickTitle), 'grey', e.i18n.t(Msg.ChatroomModePickCancelled))
    }
    if (outcome === 'start') {
      // Research modes provision the venv first; plain starts immediately.
      return simpleCard(e.i18n.t(Msg.ChatroomModePickTitle), 'purple',
        args.includes('research') ? e.i18n.t(Msg.ChatroomModePickPreparing) : e.i18n.t(Msg.ChatroomPickStarting))
    }
    return undefined
  }
  if (cmd === '/chatroom-pick') {
    if (pickers(e).chatroomPick.get(sessionKey) === undefined) {
      return simpleCard(e.i18n.t(Msg.ChatroomPickTitle), 'grey', e.i18n.t(Msg.ChatroomPickExpired))
    }
    executeChatroomPickAction(e, sessionKey, args)
    if (args.startsWith('cancel')) {
      return simpleCard(e.i18n.t(Msg.ChatroomPickTitle), 'grey', e.i18n.t(Msg.ChatroomPickCancelled))
    }
    if (args.startsWith('confirm')) {
      // executeChatroomPickAction may have refused to confirm (empty or
      // over-max) and left the picker alive; re-render it with its hint.
      const ps = pickers(e).chatroomPick.get(sessionKey)
      if (ps !== undefined && ps.phase === 'select') return renderChatroomPickCard(e, ps)
      // A multi-role confirm with the mode undecided armed the mode picker.
      const ms = pickers(e).chatroomModePick.get(sessionKey)
      if (ms !== undefined) return renderChatroomModePickCard(e, ms)
      return simpleCard(e.i18n.t(Msg.ChatroomPickTitle), 'purple', e.i18n.t(Msg.ChatroomPickStarting))
    }
    // toggle: re-render the picker from current state.
    const ps = pickers(e).chatroomPick.get(sessionKey)
    if (ps === undefined || ps.phase !== 'select') return undefined
    return renderChatroomPickCard(e, ps)
  }
  if (cmd === '/chatroom-topic-pick') {
    if (pickers(e).chatroomTopicPick.get(sessionKey) === undefined) {
      return simpleCard(e.i18n.t(Msg.ChatroomTopicPickTitle), 'grey', e.i18n.t(Msg.ChatroomPickExpired))
    }
    executeChatroomTopicPickAction(e, sessionKey, args)
    if (args.startsWith('cancel')) {
      return simpleCard(e.i18n.t(Msg.ChatroomTopicPickTitle), 'grey', e.i18n.t(Msg.ChatroomTopicPickCancelled))
    }
    if (args.startsWith('confirm')) {
      // The state machine already cleared state + armed the async finalize;
      // show a transitional card in place of the picker.
      return simpleCard(e.i18n.t(Msg.ChatroomTopicPickTitle), 'purple', e.i18n.t(Msg.ChatroomTopicPickStarting))
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
    if (chatroomState(hub).chatroomResearch) {
      void e.reply(p, rctx, e.i18n.t(Msg.ChatroomResearchSingleRole))
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
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(Msg.ChatroomReady), color: 'red' })
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
    void e.sendAsCard(p, rctx, String(error instanceof Error ? error.message : error), { title: e.i18n.t(Msg.ChatroomTopicPickTitle), color: 'red' })
  }
}
