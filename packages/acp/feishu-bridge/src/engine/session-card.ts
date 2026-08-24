/**
 * Session-lifecycle picker cards ported from cc-connect
 * core/engine_cmd_session.go and core/engine_cmd_card.go: the /list session
 * card (renderListCard — one switch button per session), the /status green
 * card (renderStatusCard with splitCardTitleBody), and the delete-mode card
 * family (select → confirm → deleting → result, with the engine-side
 * deletion effect).
 *
 * @module dsh-feishu-bridge/session-card
 */

import { Msg } from '../i18n/index.js'
import { dangerBtn, defaultBtn, newCard, type Card, type CardButton } from '../card.js'
import type { AgentSessionInfo, Message, Platform } from '../core/types.js'
import { asCardRefresher, asSessionDeleter } from '../core/types.js'
import { InteractiveState } from './engine.js'
import type { Engine } from './engine.js'
import { collectAgentSessions, formatModified, liveAgentSessionIDs, statusText, totalPages } from './commands.js'

/**
 * Split a composed status text into its card title (first paragraph) and the
 * markdown body (the rest) — Go splitCardTitleBody.
 * @param content - The full status text.
 * @returns The title line and the remaining body; a single-paragraph input
 *   yields an empty body.
 */
function splitCardTitleBody(content: string): [string, string] {
  const trimmed = content.trim()
  const idx = trimmed.indexOf('\n\n')
  if (idx === -1) return [trimmed, '']
  return [trimmed.slice(0, idx).trim(), trimmed.slice(idx + 2).trim()]
}

/**
 * The /list session picker card (Go renderListCard): one row button per
 * session switching to it, page navigation, a back button, and the
 * delete-mode entry.
 * @param e - The engine owning the session state.
 * @param sessionKey - Session key whose active session marks the ▶ row.
 * @param page - 1-based page to render; clamped into the valid range.
 * @returns The rendered card, or undefined when listing fails.
 */
export async function renderListCard(e: Engine, sessionKey: string, page: number): Promise<Card | undefined> {
  const agentSessions = await collectAgentSessions(e, sessionKey)
  if (agentSessions === undefined) return undefined
  if (agentSessions.length === 0) {
    return newCard().title(e.i18n.tf(Msg.CardTitleSessions, e.agent.name(), 0), 'turquoise')
      .markdown(e.i18n.t(Msg.ListEmpty)).build()
  }

  const total = agentSessions.length
  const pages = totalPages(total)
  if (page > pages) page = pages
  const start = (page - 1) * 5
  const end = Math.min(start + 5, total)

  const agentName = e.agent.name()
  const activeAgentID = e.sessions.getOrCreateActive(sessionKey).getAgentSessionID()
  const liveSessions = liveAgentSessionIDs(e)
  const title = pages > 1
    ? e.i18n.tf(Msg.CardTitleSessionsPaged, agentName, total, page, pages)
    : e.i18n.tf(Msg.CardTitleSessions, agentName, total)

  const cb = newCard().title(title, 'turquoise')
  for (let i = start; i < end; i++) {
    const s = agentSessions[i]
    if (s === undefined) continue
    let marker = '◻'
    if (s.id === activeAgentID) marker = '▶'
    else if (liveSessions[s.id]) marker = '●'
    let displayName = e.sessions.getSessionName(s.id)
    if (displayName !== '') {
      displayName = `📌 ${displayName}`
    } else {
      displayName = s.summary.replaceAll('\n', ' ').trim().split(/\s+/).join(' ')
      if (displayName === '') displayName = '(empty)'
      if (Array.from(displayName).length > 40) displayName = `${Array.from(displayName).slice(0, 40).join('')}…`
    }
    cb.listItemBtn(
      e.i18n.tf(Msg.ListItem, marker, i + 1, displayName, s.messageCount, formatModified(s.modifiedAt)),
      `#${i + 1}`,
      s.id === activeAgentID ? 'primary' : 'default',
      `act:/switch ${s.id}`,
    )
  }

  const navBtns: CardButton[] = []
  if (page > 1) navBtns.push(defaultBtn(e.i18n.t(Msg.CardPrev), `nav:/list ${page - 1}`))
  navBtns.push(defaultBtn(e.i18n.t(Msg.CardBack), 'nav:/help'))
  navBtns.push(dangerBtn(e.i18n.t(Msg.DeleteModeTitle), 'act:/delete-mode enter'))
  if (page < pages) navBtns.push(defaultBtn(e.i18n.t(Msg.CardNext), `nav:/list ${page + 1}`))
  cb.buttons(...navBtns)
  if (pages > 1) cb.note(e.i18n.tf(Msg.ListPageHint, page, pages))
  return cb.build()
}

/**
 * The /list card with a red error-card fallback (Go renderListCardSafe).
 * @param e - The engine owning the session state.
 * @param sessionKey - Session key whose active session marks the ▶ row.
 * @param page - 1-based page to render; clamped into the valid range.
 * @returns The rendered card, or a red listing-failed card.
 */
export async function renderListCardSafe(e: Engine, sessionKey: string, page: number): Promise<Card> {
  const card = await renderListCard(e, sessionKey, page)
  return card ?? newCard().title(e.i18n.tf(Msg.CardTitleSessions, e.agent.name(), 0), 'red')
    .markdown(e.i18n.tf(Msg.ListError, 'agent session listing failed')).build()
}

/**
 * The /status green card (Go renderStatusCard): the status text's first
 * paragraph becomes the green title, the rest the markdown body, with a back
 * button to the help card.
 * @param e - The engine whose state is reported.
 * @param sessionKey - Session key the status is rendered for.
 * @param userID - User ID the status is rendered for ('' omits the line).
 * @returns The assembled status card.
 */
export function renderStatusCard(e: Engine, sessionKey: string, userID: string): Card {
  const msg = statusCardMessage(sessionKey, userID)
  const [title, body] = splitCardTitleBody(statusText(e, msg))
  const cb = newCard().title(title, 'green')
  if (body !== '') cb.markdown(body)
  cb.buttons(defaultBtn(e.i18n.t(Msg.CardBack), 'nav:/help'))
  return cb.build()
}

/** Minimal Message carrier for {@link statusText} from a card action. */
function statusCardMessage(sessionKey: string, userID: string): Message {
  return {
    sessionKey,
    userID,
    platform: '',
    messageID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: undefined,
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
  }
}

// ── delete-mode card family (Go engine_cmd_card.go deleteModeState) ─────────

/** The delete-mode picker state machine parked on an interactive state. */
export interface DeleteModeState {
  /** 1-based listing page the select card renders. */
  page: number
  /** 'select' → 'confirm' → 'deleting' → 'result'; 'cancel' clears the state. */
  phase: 'select' | 'confirm' | 'result' | 'deleting'
  /** Hint line shown on the select card (empty selection error). */
  hint: string
  /** Result lines shown on the result card. */
  result: string
  /** Agent session IDs ticked for deletion. */
  selectedIDs: Set<string>
}

/**
 * The interactive state's delete-mode state, creating and resetting it on
 * first entry with the acting platform recorded for the result-card push
 * (Go getOrCreateDeleteModeState).
 * @param e - The engine owning the interactive state.
 * @param sessionKey - Interactive-state slot key.
 * @param p - Platform the delete-mode card was pressed on.
 * @param replyCtx - Platform reply context addressing the chat.
 * @returns The fresh delete-mode state, also stored on the interactive state.
 */
export function getOrCreateDeleteModeState(e: Engine, sessionKey: string, p?: Platform, replyCtx?: unknown): DeleteModeState {
  let state = e.interactiveStates.get(sessionKey)
  if (state === undefined) {
    state = new InteractiveState()
    e.interactiveStates.set(sessionKey, state)
  }
  if (p !== undefined) state.platform = p
  if (replyCtx !== undefined) state.replyCtx = replyCtx
  state.deleteMode = { page: 1, phase: 'select', hint: '', result: '', selectedIDs: new Set() }
  return state.deleteMode
}

/**
 * Run one delete-mode card action's state-machine step (Go
 * executeDeleteModeAction).
 * @param e - The engine owning the interactive state.
 * @param sessionKey - Interactive-state slot key.
 * @param args - The action arguments: enter|toggle|page|confirm|back|submit|cancel.
 * @param p - Platform the delete-mode card was pressed on.
 * @param replyCtx - Platform reply context addressing the chat.
 */
export function executeDeleteModeAction(e: Engine, sessionKey: string, args: string, p?: Platform, replyCtx?: unknown): void {
  const fields = args.split(/\s+/).filter(f => f !== '')
  if (fields.length === 0) return

  if (fields[0] === 'enter') {
    getOrCreateDeleteModeState(e, sessionKey, p, replyCtx)
    return
  }
  const state = e.interactiveStates.get(sessionKey)
  if (state === undefined) return
  const dm = state.deleteMode
  if (dm === undefined) return

  switch (fields[0]) {
    case 'toggle': {
      const id = fields[1] ?? ''
      if (id === '') return
      if (dm.selectedIDs.has(id)) dm.selectedIDs.delete(id)
      else dm.selectedIDs.add(id)
      dm.phase = 'select'
      dm.hint = ''
      break
    }
    case 'page': {
      const n = Number.parseInt(fields[1] ?? '', 10)
      if (Number.isInteger(n) && n > 0) dm.page = n
      dm.phase = 'select'
      break
    }
    case 'confirm': {
      if (dm.selectedIDs.size === 0) {
        dm.phase = 'select'
        dm.hint = e.i18n.t(Msg.DeleteModeEmptySelection)
        return
      }
      dm.phase = 'confirm'
      dm.hint = ''
      break
    }
    case 'back': {
      dm.phase = 'select'
      break
    }
    case 'submit': {
      const ids = new Set(dm.selectedIDs)
      dm.selectedIDs = new Set()
      dm.phase = 'deleting'
      dm.hint = e.i18n.tf(Msg.DeleteModeDeletingBody, ids.size)
      void performDeleteModeAsync(e, sessionKey, state, ids)
      break
    }
    case 'cancel': {
      state.deleteMode = undefined
      break
    }
    default:
      break
  }
}

/**
 * Render the delete-mode card for the current phase (Go
 * renderDeleteModeCard).
 * @param e - The engine owning the interactive state.
 * @param sessionKey - Interactive-state slot key.
 * @returns The phase's card, or undefined when the state is gone or listing
 *   fails (the caller falls back to the session list card).
 */
export async function renderDeleteModeCard(e: Engine, sessionKey: string): Promise<Card | undefined> {
  const dm = e.interactiveStates.get(sessionKey)?.deleteMode
  if (dm === undefined) return undefined
  switch (dm.phase) {
    case 'confirm': {
      const agentSessions = await collectAgentSessions(e, sessionKey)
      if (agentSessions === undefined) return undefined
      const names: string[] = []
      for (const s of agentSessions) {
        if (dm.selectedIDs.has(s.id)) names.push(`- ${deleteSessionDisplayName(e, s)}`)
      }
      const body = names.length > 0 ? names.join('\n') : e.i18n.t(Msg.DeleteModeEmptySelection)
      return newCard().title(e.i18n.t(Msg.DeleteModeConfirmTitle), 'carmine')
        .markdown(body)
        .buttons(
          dangerBtn(e.i18n.t(Msg.DeleteModeConfirmButton), 'act:/delete-mode submit'),
          defaultBtn(e.i18n.t(Msg.DeleteModeBackButton), 'act:/delete-mode back'),
        )
        .build()
    }
    case 'result':
      return newCard().title(e.i18n.t(Msg.DeleteModeResultTitle), 'turquoise')
        .markdown(dm.result)
        .buttons(defaultBtn(e.i18n.t(Msg.CardBack), 'nav:/list 1'))
        .build()
    case 'deleting':
      return newCard().title(e.i18n.t(Msg.DeleteModeDeletingTitle), 'orange')
        .markdown(dm.hint)
        .build()
    default: {
      const agentSessions = await collectAgentSessions(e, sessionKey)
      if (agentSessions === undefined) return undefined
      return renderDeleteModeSelectCard(e, sessionKey, dm, agentSessions)
    }
  }
}

/** The multi-select card (Go renderDeleteModeSelectCard). */
function renderDeleteModeSelectCard(
  e: Engine,
  sessionKey: string,
  dm: DeleteModeState,
  agentSessions: AgentSessionInfo[],
): Card {
  if (agentSessions.length === 0) {
    return newCard().title(e.i18n.t(Msg.DeleteModeTitle), 'red').markdown(e.i18n.t(Msg.ListEmpty)).build()
  }
  const total = agentSessions.length
  const pages = totalPages(total)
  let page = dm.page
  if (page < 1) page = 1
  if (page > pages) page = pages
  const start = (page - 1) * 5
  const end = Math.min(start + 5, total)

  const cb = newCard().title(e.i18n.t(Msg.DeleteModeTitle), 'carmine')
  const activeAgentID = e.sessions.getOrCreateActive(sessionKey).getAgentSessionID()
  for (let i = start; i < end; i++) {
    const s = agentSessions[i]
    if (s === undefined) continue
    const isActive = activeAgentID === s.id
    const isSelected = !isActive && dm.selectedIDs.has(s.id)
    let marker = '◻'
    if (isActive) marker = '▶'
    else if (isSelected) marker = '☑'
    let btnText = e.i18n.t(Msg.DeleteModeSelect)
    let btnType = 'default'
    let action = `act:/delete-mode toggle ${s.id}`
    if (isActive) {
      btnText = e.i18n.t(Msg.CardTitleCurrentSession)
      btnType = 'primary'
      action = `act:/delete-mode noop ${s.id}`
    } else if (isSelected) {
      btnText = e.i18n.t(Msg.DeleteModeSelected)
      btnType = 'primary'
    }
    cb.listItemBtn(
      e.i18n.tf(Msg.ListItem, marker, i + 1, deleteSessionDisplayName(e, s), s.messageCount, formatModified(s.modifiedAt)),
      btnText,
      btnType,
      action,
    )
  }
  cb.note(e.i18n.tf(Msg.DeleteModeSelectedCount, dm.selectedIDs.size))
  if (dm.hint !== '') cb.note(dm.hint)
  cb.buttons(
    dangerBtn(e.i18n.t(Msg.DeleteModeDeleteSelected), 'act:/delete-mode confirm'),
    defaultBtn(e.i18n.t(Msg.DeleteModeCancel), 'act:/delete-mode cancel'),
  )
  const navBtns: CardButton[] = []
  if (page > 1) navBtns.push(defaultBtn(e.i18n.t(Msg.CardPrev), `act:/delete-mode page ${page - 1}`))
  if (page < pages) navBtns.push(defaultBtn(e.i18n.t(Msg.CardNext), `act:/delete-mode page ${page + 1}`))
  if (navBtns.length > 0) cb.buttons(...navBtns)
  return cb.build()
}

/**
 * Run the selected deletions off the card-callback path, then push the result
 * card (Go performDeleteModeAsync + pushDeleteModeResultCard).
 * @param e - The engine owning the interactive state.
 * @param sessionKey - Interactive-state slot key.
 * @param state - The interactive state carrying the delete-mode state.
 * @param ids - The selected agent session IDs to delete.
 */
async function performDeleteModeAsync(e: Engine, sessionKey: string, state: InteractiveState, ids: Set<string>): Promise<void> {
  const lines = await submitDeleteModeSelection(e, sessionKey, ids)
  const dm = state.deleteMode
  if (dm !== undefined) {
    dm.result = lines.join('\n')
    dm.hint = ''
    dm.phase = 'result'
  }
  const card = await renderDeleteModeCard(e, sessionKey)
  if (card === undefined) return
  const p = state.platform
  if (p === undefined) return
  // Prefer updating the "deleting" card in place; fall back to a new card
  // (Go pushDeleteModeResultCard).
  const refresher = asCardRefresher(p)
  if (refresher !== undefined) {
    try {
      await refresher.refreshCard(sessionKey, card)
      return
    } catch {
      // fall through to the new-card fallback
    }
  }
  await e.replyWithCard(p, state.replyCtx, card)
}

/**
 * Delete every selected session that still exists and collect one reply line
 * per session (Go submitDeleteModeSelection).
 * @param e - The engine owning the session state.
 * @param sessionKey - Session key whose active session is delete-protected.
 * @param ids - The selected agent session IDs.
 * @returns One line per selected session; empty selections fall back to the
 *   empty-selection hint.
 */
async function submitDeleteModeSelection(e: Engine, sessionKey: string, ids: Set<string>): Promise<string[]> {
  const agentSessions = await collectAgentSessions(e, sessionKey)
  if (agentSessions === undefined) return [e.i18n.tf(Msg.ListError, 'agent session listing failed')]
  const seen = new Set(agentSessions.map(s => s.id))
  const lines: string[] = []
  for (const s of agentSessions) {
    if (!ids.has(s.id)) continue
    const line = await deleteSingleSessionReply(e, sessionKey, s)
    if (line !== '') lines.push(line)
  }
  const missing = [...ids].filter(id => !seen.has(id)).sort()
  for (const id of missing) lines.push(e.i18n.tf(Msg.DeleteModeMissingSession, id))
  if (lines.length === 0) lines.push(e.i18n.t(Msg.DeleteModeEmptySelection))
  return lines
}

/**
 * Delete one agent session: agent-side when the agent implements the
 * SessionDeleter capability, then the bridge's own ledger; the requesting
 * chat's active session is protected (Go deleteSingleSessionReply).
 * @param e - The engine owning the session state.
 * @param sessionKey - Session key whose active session is delete-protected.
 * @param matched - The session to delete.
 * @returns The reply line ('' when matched is absent).
 */
async function deleteSingleSessionReply(e: Engine, sessionKey: string, matched: AgentSessionInfo): Promise<string> {
  const activeAgentID = e.sessions.getOrCreateActive(sessionKey).getAgentSessionID()
  if (activeAgentID === matched.id) return e.i18n.t(Msg.DeleteActiveDenied)

  const displayName = deleteSessionDisplayName(e, matched)
  const deleter = asSessionDeleter(e.agent)
  if (deleter !== undefined) {
    try {
      await deleter.deleteSession(matched.id)
    } catch {
      // The local ledger deletion below still runs so the bridge's own view
      // stays consistent when the agent-side deletion fails.
    }
  }
  e.sessions.deleteByAgentSessionID(matched.id)
  e.sessions.setSessionName(matched.id, '')
  return e.i18n.tf(Msg.DeleteSuccess, displayName)
}

/** Name, summary, or short ID for a deleted session's reply line (Go). */
function deleteSessionDisplayName(e: Engine, matched: AgentSessionInfo): string {
  let displayName = e.sessions.getSessionName(matched.id)
  if (displayName === '') displayName = matched.summary
  if (displayName === '') {
    displayName = matched.id.length > 12 ? matched.id.slice(0, 12) : matched.id
  }
  return displayName
}
