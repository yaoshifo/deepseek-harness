/**
 * Session picker cards ported from cc-connect core engine_cmd_session.go /
 * engine_cmd_card.go: the /list card's switch rows and navigation, the
 * /status green card's title/body split, the delete-mode card family's state
 * machine and SessionManager side effects, and the handleCardAction routes
 * (act:/switch, nav:/list, nav:/help) that the cron and /dir cards' back
 * buttons ride.
 *
 * @module dsh-feishu-bridge/tests-engine-session-card
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import {
  executeDeleteModeAction,
  getOrCreateDeleteModeState,
  renderDeleteModeCard,
  renderListCard,
  renderListCardSafe,
  renderStatusCard,
} from '../../src/engine/session-card.ts'
import { renderHelpGroupCard } from '../../src/engine/misc-commands.ts'
import { createStubAgent, createStubCardPlatform, newStubMessage, type StubCardPlatform } from '../stubs/engine-stubs.ts'
import { Msg } from '../../src/i18n/index.ts'
import type { Agent, AgentSessionInfo, Message, Platform } from '../../src/core/types.ts'
import type { Card, CardListItem, CardActions } from '../../src/card.ts'

const SK = 'test:ch1:u1'

function listAgent(sessions: AgentSessionInfo[]): Agent {
  return { ...createStubAgent(), listSessions: async () => sessions }
}

function failingListAgent(): Agent {
  return { ...createStubAgent(), listSessions: async () => { throw new Error('boom') } }
}

function newCardEngine(agent: Agent, p: Platform): Engine {
  const e = new Engine('test', agent, [p], '', 'en')
  registerSessionCommands(e)
  // The delete-mode card family runs as admin (the card path gates on
  // admin_from like the text commands; unconfigured admin lists deny all).
  e.setAdminFrom('*')
  return e
}

function rows(card: Card): CardListItem[] {
  return card.elements.filter((el): el is CardListItem => el.kind === 'listItem')
}

function actionRows(card: Card): CardActions[] {
  return card.elements.filter((el): el is CardActions => el.kind === 'actions')
}

function allButtons(card: Card): string[] {
  return actionRows(card).flatMap(a => a.buttons.map(b => `${b.type}:${b.value}`))
}

function cardActionMsg(sessionKey: string, action: string): Message {
  return { ...newStubMessage(), sessionKey, platform: 'test', userID: 'u1', content: action, replyCtx: 'rctx', isCardAction: true }
}

/** A card platform recording in-place refreshes (CardRefresher). */
interface RefreshingPlatform extends StubCardPlatform {
  refreshed: Array<{ sessionKey: string; card: unknown }>
  refreshCard(sessionKey: string, card: unknown): Promise<void>
}

function newRefreshingPlatform(n = 'test'): RefreshingPlatform {
  const base = createStubCardPlatform(n)
  const p: RefreshingPlatform = {
    ...base,
    refreshed: [],
    refreshCard: async (sessionKey, card) => {
      p.refreshed.push({ sessionKey, card })
    },
  }
  return p
}

const twoSessions: AgentSessionInfo[] = [
  { id: 'agent-sess-a', summary: 'First chat', messageCount: 3, modifiedAt: Date.UTC(2026, 2, 11, 2, 0, 0) },
  { id: 'agent-sess-b', summary: 'Second chat', messageCount: 7, modifiedAt: Date.UTC(2026, 2, 12, 2, 0, 0) },
]

describe('renderListCard', () => {
  it('renders one switch row per session with the active session primary', async () => {
    const e = newCardEngine(listAgent(twoSessions), createStubCardPlatform('test'))
    e.sessions.getOrCreateActive(SK).setAgentSessionID('agent-sess-b', 'stub')

    const card = await renderListCard(e, SK, 1)
    expect(card).toBeDefined()
    if (card === undefined) return
    expect(card.header).toEqual({ title: 'stub Sessions (2)', color: 'turquoise' })
    const listRows = rows(card)
    expect(listRows).toHaveLength(2)
    expect(listRows[0]?.btnValue).toBe('act:/switch agent-sess-a')
    expect(listRows[0]?.btnType).toBe('default')
    expect(listRows[0]?.text).toContain('◻')
    expect(listRows[1]?.btnValue).toBe('act:/switch agent-sess-b')
    expect(listRows[1]?.btnType).toBe('primary')
    expect(listRows[1]?.text).toContain('▶')
  })

  it('paginates five rows per page with prev/back/delete/next navigation', async () => {
    const sessions: AgentSessionInfo[] = Array.from({ length: 7 }, (_, i) => ({
      id: `sess-${i + 1}`, summary: `chat ${i + 1}`, messageCount: 1, modifiedAt: Date.UTC(2026, 2, 1 + i, 0, 0, 0),
    }))
    const e = newCardEngine(listAgent(sessions), createStubCardPlatform('test'))

    const page1 = await renderListCard(e, SK, 1)
    expect(page1).toBeDefined()
    if (page1 === undefined) return
    expect(rows(page1)).toHaveLength(5)
    const buttons1 = allButtons(page1)
    expect(buttons1).toContain('default:nav:/help')
    expect(buttons1).toContain('danger:act:/delete-mode enter')
    expect(buttons1).toContain('default:nav:/list 2')
    expect(buttons1).not.toContain('default:nav:/list 0')

    const page2 = await renderListCard(e, SK, 2)
    expect(page2).toBeDefined()
    if (page2 === undefined) return
    expect(rows(page2)).toHaveLength(2)
    expect(allButtons(page2)).toContain('default:nav:/list 1')
    expect(allButtons(page2)).not.toContain('default:nav:/list 3')
  })

  it('renders the empty-listing card without rows', async () => {
    const e = newCardEngine(listAgent([]), createStubCardPlatform('test'))
    const card = await renderListCard(e, SK, 1)
    expect(card?.header).toEqual({ title: 'stub Sessions (0)', color: 'turquoise' })
    expect(card !== undefined && rows(card)).toHaveLength(0)
  })
})

describe('renderListCardSafe', () => {
  it('falls back to a red error card when listing fails', async () => {
    const e = newCardEngine(failingListAgent(), createStubCardPlatform('test'))
    const card = await renderListCardSafe(e, SK, 1)
    expect(card.header?.color).toBe('red')
    expect(card.renderText()).toContain('Failed to list sessions')
  })
})

describe('renderStatusCard', () => {
  it('splits the status text into a green title, markdown body, and back button', async () => {
    const e = newCardEngine(listAgent(twoSessions), createStubCardPlatform('test'))
    const card = await renderStatusCard(e, SK, 'u1')
    expect(card.header?.color).toBe('green')
    expect(card.header?.title).toContain('Status')
    const mds = card.elements.filter(el => el.kind === 'markdown') as Array<{ content: string }>
    expect(mds.length).toBe(1)
    expect(mds[0]?.content).toContain('Agent: stub')
    expect(allButtons(card)).toEqual(['default:nav:/help'])
  })
})

describe('renderHelpGroupCard', () => {
  it('renders four group tabs with the current one primary', () => {
    const e = newCardEngine(listAgent(twoSessions), createStubCardPlatform('test'))
    const card = renderHelpGroupCard(e, 'tools')
    const tabs = allButtons(card).filter(b => b.includes('nav:/help'))
    expect(tabs).toEqual([
      'default:nav:/help session',
      'default:nav:/help agent',
      'primary:nav:/help tools',
      'default:nav:/help system',
    ])
  })
})

describe('handleCardAction routes', () => {
  it('act:/switch swaps the session and re-renders the list card in place', async () => {
    const p = newRefreshingPlatform()
    const e = newCardEngine(listAgent(twoSessions), p)
    const active = e.sessions.getOrCreateActive(SK)
    active.setAgentSessionID('agent-sess-a', 'stub')

    await e.handleCardAction(p, cardActionMsg(SK, ''), 'act:/switch agent-sess-b')
    await vi.waitFor(() => { expect(p.refreshed.length).toBeGreaterThanOrEqual(1) })

    expect(e.sessions.getOrCreateActive(SK).getAgentSessionID()).toBe('agent-sess-b')
    const card = p.refreshed[p.refreshed.length - 1]?.card as Card
    expect(card.header?.color).toBe('turquoise')
    expect(card.renderText()).toContain('Second chat')
    // A card action never starts an agent turn.
    expect(p.getSent()).toEqual([])
  })

  it('nav:/help renders the help group card (the cron and /dir back buttons)', async () => {
    const p = newRefreshingPlatform()
    const e = newCardEngine(listAgent(twoSessions), p)

    await e.handleCardAction(p, cardActionMsg(SK, ''), 'nav:/help')
    await vi.waitFor(() => { expect(p.refreshed.length).toBe(1) })
    let card = p.refreshed[0]?.card as Card
    expect(card.header?.color).toBe('blue')
    expect(allButtons(card).some(b => b === 'primary:nav:/help session')).toBe(true)

    // Group navigation flips the primary tab.
    await e.handleCardAction(p, cardActionMsg(SK, ''), 'nav:/help tools')
    await vi.waitFor(() => { expect(p.refreshed.length).toBe(2) })
    card = p.refreshed[1]?.card as Card
    expect(allButtons(card).some(b => b === 'primary:nav:/help tools')).toBe(true)
    expect(p.getSent()).toEqual([])
  })

  it('nav:/list turns the page without a side effect', async () => {
    const sessions: AgentSessionInfo[] = Array.from({ length: 7 }, (_, i) => ({
      id: `sess-${i + 1}`, summary: `chat ${i + 1}`, messageCount: 1, modifiedAt: Date.UTC(2026, 2, 1 + i, 0, 0, 0),
    }))
    const p = newRefreshingPlatform()
    const e = newCardEngine(listAgent(sessions), p)
    e.sessions.getOrCreateActive(SK).setAgentSessionID('sess-1', 'stub')

    await e.handleCardAction(p, cardActionMsg(SK, ''), 'nav:/list 2')
    await vi.waitFor(() => { expect(p.refreshed.length).toBe(1) })
    const card = p.refreshed[0]?.card as Card
    expect(rows(card)).toHaveLength(2)
    expect(e.sessions.getOrCreateActive(SK).getAgentSessionID()).toBe('sess-1')
  })

  it('nav:/status renders the status card in place', async () => {
    const p = newRefreshingPlatform()
    const e = newCardEngine(listAgent(twoSessions), p)

    await e.handleCardAction(p, cardActionMsg(SK, ''), 'nav:/status')
    await vi.waitFor(() => { expect(p.refreshed.length).toBe(1) })
    const card = p.refreshed[0]?.card as Card
    expect(card.header?.color).toBe('green')
  })
})

describe('delete-mode card family', () => {
  it('enter creates the picker; toggle selects; the active session row is a noop', async () => {
    const e = newCardEngine(listAgent(twoSessions), createStubCardPlatform('test'))
    e.sessions.getOrCreateActive(SK).setAgentSessionID('agent-sess-b', 'stub')

    executeDeleteModeAction(e, SK, 'enter')
    executeDeleteModeAction(e, SK, 'toggle agent-sess-a')
    executeDeleteModeAction(e, SK, 'toggle agent-sess-b')

    // The toggle itself does not refuse the active session (Go parity); the
    // deletion step and the select card's row button are what protect it.
    const state = e.interactiveStates.get(SK)
    expect(state?.deleteMode?.selectedIDs).toEqual(new Set(['agent-sess-a', 'agent-sess-b']))
    expect(state?.deleteMode?.phase).toBe('select')

    // The select card renders the active row as a noop and the selected row
    // as primary.
    const card = await renderDeleteModeCard(e, SK)
    expect(card).toBeDefined()
    const listRows = card?.elements.filter((el): el is CardListItem => el.kind === 'listItem') ?? []
    expect(listRows[0]?.btnValue).toBe('act:/delete-mode toggle agent-sess-a')
    expect(listRows[0]?.btnType).toBe('primary')
    expect(listRows[1]?.btnValue).toBe('act:/delete-mode noop agent-sess-b')
  })

  it('confirm with nothing selected bounces back to select with the hint', () => {
    const e = newCardEngine(listAgent(twoSessions), createStubCardPlatform('test'))
    executeDeleteModeAction(e, SK, 'enter')
    executeDeleteModeAction(e, SK, 'confirm')

    const dm = e.interactiveStates.get(SK)?.deleteMode
    expect(dm?.phase).toBe('select')
    expect(dm?.hint).toContain('at least one')
  })

  it('submit deletes the selected sessions from the SessionManager and protects the active one', async () => {
    const p = newRefreshingPlatform()
    const e = newCardEngine(listAgent(twoSessions), p)
    const active = e.sessions.getOrCreateActive(SK)
    active.setAgentSessionID('agent-sess-b', 'stub')
    // A second chat mapped to the same agent session: both local mappings go.
    e.sessions.switchToAgentSession('test:ch2:u2', 'agent-sess-a', 'stub', 'First chat')
    e.sessions.setSessionName('agent-sess-a', 'named session')

    executeDeleteModeAction(e, SK, 'enter', p, 'rctx')
    executeDeleteModeAction(e, SK, 'toggle agent-sess-a')
    // The active session is protected at deletion time even when selected.
    executeDeleteModeAction(e, SK, 'toggle agent-sess-b')
    executeDeleteModeAction(e, SK, 'confirm')
    const dm = e.interactiveStates.get(SK)?.deleteMode
    expect(dm?.phase).toBe('confirm')

    executeDeleteModeAction(e, SK, 'submit')
    expect(e.interactiveStates.get(SK)?.deleteMode?.phase).toBe('deleting')
    await vi.waitFor(() => {
      expect(e.interactiveStates.get(SK)?.deleteMode?.phase).toBe('result')
    })

    // The local ledger dropped every mapping and the custom name.
    expect(e.sessions.findByAgentSessionID('agent-sess-a')).toBeUndefined()
    expect(e.sessions.getSessionName('agent-sess-a')).toBe('')
    // The requesting chat's active session survived.
    expect(active.getAgentSessionID()).toBe('agent-sess-b')
    const result = e.interactiveStates.get(SK)?.deleteMode?.result ?? ''
    expect(result).toContain('named session')
    expect(result).toContain(e.i18n.t(Msg.DeleteActiveDenied))

    // The result card reached the platform.
    await vi.waitFor(() => { expect(p.refreshed.length).toBeGreaterThanOrEqual(1) })
    const card = p.refreshed[p.refreshed.length - 1]?.card as Card
    expect(card.header?.color).toBe('turquoise')
    expect(allButtons(card)).toEqual(['default:nav:/list 1'])
  })

  it('cancel clears the picker state and handleCardAction returns to the list card', async () => {
    const p = newRefreshingPlatform()
    const e = newCardEngine(listAgent(twoSessions), p)
    executeDeleteModeAction(e, SK, 'enter')

    await e.handleCardAction(p, cardActionMsg(SK, ''), 'act:/delete-mode cancel')
    await vi.waitFor(() => { expect(p.refreshed.length).toBe(1) })

    expect(e.interactiveStates.get(SK)?.deleteMode).toBeUndefined()
    const card = p.refreshed[0]?.card as Card
    expect(card.header?.color).toBe('turquoise')
  })

  it('getOrCreateDeleteModeState resets a stale picker', () => {
    const e = newCardEngine(listAgent(twoSessions), createStubCardPlatform('test'))
    const first = getOrCreateDeleteModeState(e, SK)
    first.selectedIDs.add('agent-sess-a')
    first.phase = 'confirm'

    const second = getOrCreateDeleteModeState(e, SK)
    expect(second).not.toBe(first)
    expect(second.selectedIDs.size).toBe(0)
    expect(second.phase).toBe('select')
  })
})
