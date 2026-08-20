/**
 * The /dir picker card ported from cc-connect core/engine_cmd_workspace.go
 * (renderDirCard / renderDirCardSafe): current work directory, paged history
 * rows with select buttons, reset/prev actions, and page navigation.
 *
 * @module dsh-feishu-bridge/dir-card
 */

import { Msg } from '../i18n/index.js'
import { defaultBtn, newCard, type Card, type CardButton } from '../card.js'
import type { Engine } from './engine.js'

/** Max directory history rows per card page (Go dirCardPageSize). */
const dirCardPageSize = 5

/**
 * Truncate a display path to 53 runes + ellipsis at 56 runes (Go
 * dirCardTruncPath); rune-based so multibyte paths never split mid-character.
 * @param absPath - Absolute path to truncate for display.
 * @returns The path unchanged at ≤56 runes, otherwise its first 53 runes + '…'.
 */
function dirCardTruncPath(absPath: string): string {
  const r = Array.from(absPath)
  if (r.length <= 56) return absPath
  return `${r.slice(0, 53).join('')}…`
}

/**
 * The /dir card (Go Engine.renderDirCard).
 *
 * @param e - The engine owning the dir override and history.
 * @param sessionKey - Session whose dir override and history feed the card.
 * @param page - 1-based history page to render; clamped into the valid range.
 * @param notice - Extra markdown appended under the current-dir line.
 * @returns The rendered card, or undefined when the agent has no getWorkDir.
 */
export function renderDirCard(e: Engine, sessionKey: string, page: number, notice: string): Card | undefined {
  const switcher = e.agent as { getWorkDir?: () => string } | undefined
  if (switcher === undefined || typeof switcher.getWorkDir !== 'function') return undefined
  let currentDir = switcher.getWorkDir()
  const override = e.perChatWorkDir(e.dirOverrideKey(sessionKey))
  if (override !== '') currentDir = override

  const history = e.dirHistory?.list(e.name) ?? []
  const total = history.length
  let totalPages = 1
  if (total > 0) totalPages = Math.ceil(total / dirCardPageSize)
  if (page < 1) page = 1
  if (page > totalPages) page = totalPages
  const start = (page - 1) * dirCardPageSize
  const end = Math.min(start + dirCardPageSize, total)

  const cb = newCard().title(e.i18n.t(Msg.DirCardTitle), 'turquoise')
  cb.markdown(e.i18n.tf(Msg.DirCurrent, currentDir))
  if (notice !== '') cb.markdown(notice)
  if (total === 0) {
    cb.note(e.i18n.t(Msg.DirCardEmptyHistory))
  } else {
    cb.divider()
    history.slice(start, end).forEach((dir, rel) => {
      const i = start + rel
      const isCurrent = dir === currentDir
      cb.listItemBtn(
        `${isCurrent ? '▶' : '◻'} **${i + 1}.** \`${dirCardTruncPath(dir)}\``,
        `#${i + 1}`,
        isCurrent ? 'primary' : 'default',
        `act:/dir select ${i + 1}`,
      )
    })
  }

  const actionRow: CardButton[] = []
  if (e.dirHistory !== undefined && history.length >= 2) {
    actionRow.push(defaultBtn(e.i18n.t(Msg.DirCardPrev), 'act:/dir prev'))
  }
  actionRow.push(defaultBtn(e.i18n.t(Msg.DirCardReset), 'act:/dir reset'))
  cb.buttons(...actionRow)

  // Go appends cardBackButton() (nav:/help) between the page buttons; the
  // help-card system it navigates to is not ported yet, so the button would
  // be inert — it returns together with the help-card milestone.
  const navBtns: CardButton[] = []
  if (totalPages > 1 && page > 1) navBtns.push(defaultBtn(e.i18n.t(Msg.CardPrev), `nav:/dir ${page - 1}`))
  if (totalPages > 1 && page < totalPages) navBtns.push(defaultBtn(e.i18n.t(Msg.CardNext), `nav:/dir ${page + 1}`))
  cb.buttons(...navBtns)

  if (totalPages > 1) cb.note(e.i18n.tf(Msg.DirCardPageHint, page, totalPages))
  return cb.build()
}

/**
 * The /dir card with a red error card fallback (Go Engine.renderDirCardSafe).
 *
 * @param e - The engine owning the dir override and history.
 * @param sessionKey - Session whose dir override and history feed the card.
 * @param page - 1-based history page to render; clamped into the valid range.
 * @param notice - Extra markdown appended under the current-dir line.
 * @returns The rendered card, or a red not-supported card when rendering fails.
 */
export function renderDirCardSafe(e: Engine, sessionKey: string, page: number, notice: string): Card {
  return renderDirCard(e, sessionKey, page, notice)
    ?? newCard().title(e.i18n.t(Msg.DirCardTitle), 'red').markdown(e.i18n.t(Msg.DirNotSupported)).build()
}
