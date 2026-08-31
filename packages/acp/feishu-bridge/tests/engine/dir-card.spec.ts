/**
 * renderDirCard / renderDirCardSafe (Go engine_cmd_workspace.go): the /dir
 * picker card — header color, history rows with act:/dir select values,
 * prev/reset buttons, page navigation, empty-history note, rune-safe path
 * truncation, the dir override, and the not-supported error card.
 *
 * @module dsh-feishu-bridge/tests-engine-dir-card
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DirHistory } from '../../src/engine/dir-history.ts'
import { renderDirCard, renderDirCardSafe } from '../../src/engine/dir-card.ts'
import { Engine } from '../../src/engine/engine.ts'
import { ProjectStateStore } from '../../src/engine/project-state.ts'
import type { Card, CardActions, CardListItem, CardNote } from '../../src/card.ts'
import type { Agent } from '../../src/core/types.ts'
import { createStubAgent, createStubCardPlatform } from '../stubs/engine-stubs.ts'

function workDirAgent(workDir: string): Agent & { getWorkDir(): string } {
  const dir = workDir
  return { ...createStubAgent(), getWorkDir: () => dir }
}

function newEngine(agent: Agent, dataDir: string): { e: Engine; dh: DirHistory } {
  const e = new Engine('test', agent, [createStubCardPlatform('test')], '', 'en')
  const dh = new DirHistory(dataDir)
  e.setDirHistory(dh)
  return { e, dh }
}

function rows(card: Card): CardListItem[] {
  return card.elements.filter((el): el is CardListItem => el.kind === 'listItem')
}

function actionRows(card: Card): CardActions[] {
  return card.elements.filter((el): el is CardActions => el.kind === 'actions')
}

function notes(card: Card): CardNote[] {
  return card.elements.filter((el): el is CardNote => el.kind === 'note')
}

function allButtons(card: Card): string[] {
  return actionRows(card).flatMap(a => a.buttons.map(b => `${b.type}:${b.value}`))
}

function tempProject(nDirs: number, nameLen = 4): { dataDir: string; dirs: string[] } {
  const dataDir = mkdtempSync(join(tmpdir(), 'fb-dircard-'))
  const dirs: string[] = []
  for (let i = 1; i <= nDirs; i++) {
    const d = join(dataDir, `${'x'.repeat(nameLen)}${i}`)
    mkdirSync(d)
    dirs.push(d)
  }
  return { dataDir, dirs }
}

describe('renderDirCard', () => {
  it('renders history rows, current-dir primary, reset and prev buttons', () => {
    const { dataDir, dirs } = tempProject(3)
    const { e, dh } = newEngine(workDirAgent(dirs[1] ?? ''), dataDir)
    for (const d of dirs) dh.add('test', d)

    const card = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(card).toBeDefined()
    if (card === undefined) return
    expect(card.header).toEqual({ title: 'Working directory', color: 'turquoise' })

    const listRows = rows(card)
    expect(listRows).toHaveLength(3)
    expect(listRows[0]?.btnValue).toBe('act:/dir select 1')
    expect(listRows[0]?.btnText).toBe('#1')
    expect(listRows[0]?.btnType).toBe('default')
    expect(listRows[1]?.btnType).toBe('primary')
    expect(listRows[1]?.text).toContain('▶')
    expect(listRows[0]?.text).toContain('◻')

    const buttons = allButtons(card)
    expect(buttons).toContain('default:act:/dir prev')
    expect(buttons).toContain('default:act:/dir reset')
    // Single page: no nav buttons and no page-hint note.
    expect(buttons.filter(b => b.includes('nav:/dir'))).toHaveLength(0)
    expect(notes(card)).toHaveLength(0)
  })

  it('drops the prev button and keeps reset for a single-entry history', () => {
    const { dataDir, dirs } = tempProject(1)
    const { e, dh } = newEngine(workDirAgent(dirs[0] ?? ''), dataDir)
    dh.add('test', dirs[0] ?? '')

    const card = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(card).toBeDefined()
    if (card === undefined) return
    expect(rows(card)).toHaveLength(1)
    const buttons = allButtons(card)
    expect(buttons).not.toContain('default:act:/dir prev')
    expect(buttons).toContain('default:act:/dir reset')
  })

  it('renders an empty-history note and no rows without history', () => {
    const { dataDir } = tempProject(0)
    const { e } = newEngine(workDirAgent('/tmp/project-a'), dataDir)

    const card = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(card).toBeDefined()
    if (card === undefined) return
    expect(rows(card)).toHaveLength(0)
    expect(notes(card).map(n => n.text)).toEqual(['No directory history yet. Type `/dir <path>` to switch, or use **Reset** to restore the default.'])
    expect(allButtons(card)).toEqual(['default:act:/dir reset', 'default:nav:/help'])
  })

  it('paginates five rows per page with nav buttons and a page hint', () => {
    const { dataDir, dirs } = tempProject(7)
    const { e, dh } = newEngine(workDirAgent(dirs[0] ?? ''), dataDir)
    for (const d of dirs) dh.add('test', d)

    const page1 = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(page1).toBeDefined()
    if (page1 === undefined) return
    expect(rows(page1)).toHaveLength(5)
    expect(allButtons(page1)).toContain('default:nav:/dir 2')
    expect(allButtons(page1)).not.toContain('default:nav:/dir 0')
    expect(notes(page1)[0]?.text).toContain('1/2')

    const page2 = renderDirCard(e, 'test:ch1:u1', 2, '')
    expect(page2).toBeDefined()
    if (page2 === undefined) return
    expect(rows(page2)).toHaveLength(2)
    expect(rows(page2)[0]?.btnValue).toBe('act:/dir select 6')
    expect(allButtons(page2)).toContain('default:nav:/dir 1')
    expect(allButtons(page2)).not.toContain('default:nav:/dir 3')
  })

  it('clamps out-of-range pages into the valid range', () => {
    const { dataDir, dirs } = tempProject(7)
    const { e, dh } = newEngine(workDirAgent(dirs[0] ?? ''), dataDir)
    for (const d of dirs) dh.add('test', d)

    const high = renderDirCard(e, 'test:ch1:u1', 99, '')
    expect(high).toBeDefined()
    if (high !== undefined) {
      expect(rows(high)).toHaveLength(2)
      expect(notes(high)[0]?.text).toContain('2/2')
    }

    const low = renderDirCard(e, 'test:ch1:u1', 0, '')
    expect(low).toBeDefined()
    if (low !== undefined) {
      expect(rows(low)).toHaveLength(5)
      expect(notes(low)[0]?.text).toContain('1/2')
    }
  })

  it('appends the notice markdown after the current-dir line', () => {
    const { dataDir, dirs } = tempProject(1)
    const { e, dh } = newEngine(workDirAgent(dirs[0] ?? ''), dataDir)
    dh.add('test', dirs[0] ?? '')

    const card = renderDirCard(e, 'test:ch1:u1', 1, 'Session ended.')
    expect(card).toBeDefined()
    if (card === undefined) return
    const mds = card.elements.filter(el => el.kind === 'markdown') as Array<{ kind: 'markdown'; content: string }>
    expect(mds.map(m => m.content)).toEqual([
      '📂 Current work directory: `' + (dirs[0] ?? '') + '`',
      'Session ended.',
    ])
  })

  it('keeps short display paths untruncated', () => {
    // /tmp (not the long macOS per-user tmpdir) keeps the path under 56 runes.
    const dataDir = mkdtempSync('/tmp/fb-dircard-short-')
    const dirs = [join(dataDir, 'a'), join(dataDir, 'b')]
    for (const d of dirs) mkdirSync(d)
    const { e, dh } = newEngine(workDirAgent(dirs[0] ?? ''), dataDir)
    for (const d of dirs) dh.add('test', d)

    const card = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(card).toBeDefined()
    if (card === undefined) return
    const texts = rows(card).map(r => r.text)
    expect(texts.some(t => t.includes(`\`${dirs[0] ?? ''}\``))).toBe(true)
    expect(texts.some(t => t.includes('…'))).toBe(false)
  })

  it('truncates display paths at 56 runes without splitting characters', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fb-dircard-trunc-'))
    const longName = '深'.repeat(30)
    const d = join(dataDir, longName)
    mkdirSync(d)
    const { e, dh } = newEngine(workDirAgent(d), dataDir)
    dh.add('test', d)

    const card = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(card).toBeDefined()
    if (card === undefined) return
    const text = rows(card)[0]?.text ?? ''
    // Display path = full path minus leading marker/number formatting; the
    // truncation itself keeps 53 runes + ellipsis.
    const shown = text.slice(text.indexOf('`') + 1, text.lastIndexOf('`'))
    expect(Array.from(shown)).toHaveLength(54)
    expect(shown.endsWith('…')).toBe(true)
    expect(Array.from(shown).slice(0, 53)).toEqual(Array.from(d).slice(0, 53))
  })

  it('prefers the per-chat dir override over the agent work dir', () => {
    const { dataDir, dirs } = tempProject(2)
    const { e, dh } = newEngine(workDirAgent('/tmp/agent-base'), dataDir)
    for (const d of dirs) dh.add('test', d)
    e.setProjectStateStore(new ProjectStateStore(join(dataDir, 'state', 'test.state.json')))
    e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey('test:ch1:u1'), dirs[0] ?? '')

    const card = renderDirCard(e, 'test:ch1:u1', 1, '')
    expect(card).toBeDefined()
    if (card === undefined) return
    const mds = card.elements.filter(el => el.kind === 'markdown') as Array<{ kind: 'markdown'; content: string }>
    expect(mds[0]?.content).toContain(dirs[0] ?? '')
    // MRU order puts the last-added dir first; the override dir (dirs[0], a long
    // tmp path, so display text is truncated) is the second row and is primary.
    expect(rows(card)[1]?.btnType).toBe('primary')
    expect(rows(card)[1]?.btnValue).toBe('act:/dir select 2')
    expect(rows(card)[0]?.btnType).toBe('default')
  })
})

describe('renderDirCardSafe', () => {
  it('returns a red error card when the agent has no getWorkDir', () => {
    const e = new Engine('test', createStubAgent(), [createStubCardPlatform('test')], '', 'en')

    expect(renderDirCard(e, 'test:ch1:u1', 1, '')).toBeUndefined()
    const card = renderDirCardSafe(e, 'test:ch1:u1', 1, '')
    expect(card.header).toEqual({ title: 'Working directory', color: 'red' })
    const mds = card.elements.filter(el => el.kind === 'markdown') as Array<{ kind: 'markdown'; content: string }>
    expect(mds[0]?.content).toBe('This agent does not support dynamic work directory switching.')
  })

  it('passes the rendered card through when rendering succeeds', () => {
    const { dataDir, dirs } = tempProject(1)
    const { e, dh } = newEngine(workDirAgent(dirs[0] ?? ''), dataDir)
    dh.add('test', dirs[0] ?? '')

    expect(renderDirCardSafe(e, 'test:ch1:u1', 1, '').header?.color).toBe('turquoise')
  })
})
