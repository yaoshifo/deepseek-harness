/**
 * Hint-button click counting ported from cc-connect core/hint_usage.go:
 * per-category counts, write-through JSON persistence, and stable
 * frequency-descending ordering for the hints panels.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HintUsage } from '../../src/engine/hint-usage.js'

describe('HintUsage', () => {
  it('counts increments per category and ignores unknown ones', () => {
    const hu = new HintUsage(mkdtempSync(join(tmpdir(), 'hint-usage-')))
    hu.increment('hints', '/new')
    hu.increment('hints', '/new')
    hu.increment('hints_with_param', '/tdd')
    hu.increment('hints_common', '/done')

    expect(hu.sortedByFrequency('hints', ['/new', '/list'])).toEqual(['/new', '/list'])
    expect(hu.sortedByFrequency('hints', ['/list', '/new'])).toEqual(['/new', '/list'])
    expect(hu.sortedByFrequency('hints_with_param', ['/html', '/tdd'])).toEqual(['/tdd', '/html'])
    expect(hu.sortedByFrequency('hints_common', ['/done', '/spawn'])).toEqual(['/done', '/spawn'])
  })

  it('keeps config order among equal counts (stable sort)', () => {
    const hu = new HintUsage(mkdtempSync(join(tmpdir(), 'hint-usage-')))
    hu.increment('hints', '/list')
    expect(hu.sortedByFrequency('hints', ['/new', '/list', '/stop'])).toEqual(['/list', '/new', '/stop'])
  })

  it('persists all three categories and reloads them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hint-usage-'))
    const hu = new HintUsage(dataDir)
    hu.increment('hints', '/new')
    hu.increment('hints_with_param', '/tdd')
    hu.increment('hints_common', '/done')

    const reloaded = new HintUsage(dataDir)
    expect(reloaded.sortedByFrequency('hints', ['/list', '/new'])).toEqual(['/new', '/list'])
    expect(reloaded.sortedByFrequency('hints_with_param', ['/html', '/tdd'])).toEqual(['/tdd', '/html'])
    // Go's store dropped the hints_common counts; the TS port keeps them.
    expect(reloaded.sortedByFrequency('hints_common', ['/spawn', '/done'])).toEqual(['/done', '/spawn'])
  })

  it('survives a corrupt store file by starting empty', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hint-usage-'))
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'hint_usage.json'), '{not json')
    const hu = new HintUsage(dataDir)
    expect(hu.sortedByFrequency('hints', ['/new'])).toEqual(['/new'])
  })

  it('writes the counts through on every increment', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hint-usage-'))
    const hu = new HintUsage(dataDir)
    hu.increment('hints', '/new')
    const raw = JSON.parse(readFileSync(join(dataDir, 'hint_usage.json'), 'utf8')) as Record<string, Record<string, number>>
    expect(raw.hints?.['/new']).toBe(1)
    expect(raw.hints_with_param).toEqual({})
    expect(raw.hints_common).toEqual({})
  })

  it('skips malformed counts on load so increments stay numeric', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hint-usage-'))
    // A string count turns increments into string concatenation, which
    // corrupts the store on the next write-through save.
    writeFileSync(join(dataDir, 'hint_usage.json'), JSON.stringify({
      hints: { '/new': '3', '/list': 2 },
      hints_with_param: 'not-an-object',
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const hu = new HintUsage(dataDir)
      hu.increment('hints', '/new')
      // '/new' restarts from 1 (the bad '3' was dropped); '/list' keeps its 2.
      const raw = JSON.parse(readFileSync(join(dataDir, 'hint_usage.json'), 'utf8')) as Record<string, Record<string, number>>
      expect(raw.hints?.['/new']).toBe(1)
      expect(raw.hints?.['/list']).toBe(2)
      expect(raw.hints_with_param).toEqual({})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('/new'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('hints_with_param'))
    } finally {
      warn.mockRestore()
    }
  })
})
