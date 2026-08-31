/**
 * Ported from cc-connect core/dir_history_test.go TestDirHistory_ResolveScanPathFuzzy
 * plus the /dir resolution fallback that consumes it (M7 #3: dir_scan_paths).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DirHistory } from '../../src/engine/dir-history.ts'

describe('DirHistory.resolveScanPathFuzzy', () => {
  it('prefix, substring, case-insensitive, and edit-distance matches', () => {
    const parent = mkdtempSync(join(tmpdir(), 'fuzzy-'))
    for (const name of ['riskai', 'riskctl', 'ainvest', 'Mem0', 'xrisk']) {
      mkdirSync(join(parent, name))
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'fuzzy-data-'))
    const dh = new DirHistory(dataDir)
    dh.setScanPaths('p1', [parent])

    // Prefix hit: "risk" matches riskai or riskctl.
    const risk = dh.resolveScanPathFuzzy('p1', 'risk')
    expect(risk).toBeDefined()
    expect(['riskai', 'riskctl']).toContain(basename(risk ?? ''))

    // Prefix beats substring: riskai (prefix) vs xrisk (substring).
    expect(basename(dh.resolveScanPathFuzzy('p1', 'riskai') ?? '')).toBe('riskai')

    // Substring hit.
    expect(basename(dh.resolveScanPathFuzzy('p1', 'invest') ?? '')).toBe('ainvest')

    // Case-insensitive exact.
    expect(basename(dh.resolveScanPathFuzzy('p1', 'mem0') ?? '')).toBe('Mem0')

    // Single-character typo (edit distance 1 <= threshold 1).
    expect(basename(dh.resolveScanPathFuzzy('p1', 'nem0') ?? '')).toBe('Mem0')

    // Too short never matches.
    expect(dh.resolveScanPathFuzzy('p1', 'a')).toBeUndefined()

    // No candidate.
    expect(dh.resolveScanPathFuzzy('p1', 'zzz-not-there')).toBeUndefined()

    // No scan root configured.
    const dh2 = new DirHistory(dataDir)
    expect(dh2.resolveScanPathFuzzy('p2', 'risk')).toBeUndefined()
  })
})

describe('DirHistory.load shape validation', () => {
  it('skips malformed MRU rows without half-loading intact ones', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fuzzy-data-'))
    // The numeric row comes first: an unguarded spread would throw on it and
    // drop every row after it (half-load); the string row would spread into
    // single-character entries.
    writeFileSync(join(dataDir, 'dir_history.json'), JSON.stringify({
      badNumber: 42,
      badString: '/not/an/array',
      good: ['/a', '/b'],
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dh = new DirHistory(dataDir)
      expect(dh.contains('good', '/a')).toBe(true)
      expect(dh.contains('good', '/b')).toBe(true)
      expect(dh.contains('badNumber', '/a')).toBe(false)
      // A string row must not decompose into single characters.
      expect(dh.contains('badString', '/')).toBe(false)
      expect(dh.list('badString')).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('badNumber'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('badString'))
    } finally {
      warn.mockRestore()
    }
  })

  it('starts empty when the store file is not a JSON object', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fuzzy-data-'))
    writeFileSync(join(dataDir, 'dir_history.json'), '["/a","/b"]')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dh = new DirHistory(dataDir)
      expect(dh.contains('good', '/a')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a history object'))
    } finally {
      warn.mockRestore()
    }
  })
})
