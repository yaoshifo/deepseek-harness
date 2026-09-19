/**
 * Ported from cc-connect core/dir_history_test.go TestDirHistory_ResolveScanPathFuzzy
 * plus the /dir resolution fallback that consumes it (M7 #3: dir_scan_paths)
 * and the shared argument resolution behind every --dir surface.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DirHistory, resolveDirArg } from '../../src/engine/dir-history.ts'

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

describe('resolveDirArg', () => {
  it('passes an existing absolute path through and rejects a missing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'dirarg-abs-'))
    const target = join(root, 'repo')
    mkdirSync(target)
    expect(resolveDirArg(undefined, 'p1', target, false)).toBe(target)
    expect(resolveDirArg(undefined, 'p1', join(root, 'missing'), false)).toBeUndefined()
  })

  it('expands a leading tilde', () => {
    const home = process.env.HOME ?? ''
    if (home === '') return
    expect(resolveDirArg(undefined, 'p1', '~', false)).toBe(home)
  })

  it('expands ~ from the OS home when HOME is unset', () => {
    const saved = process.env.HOME
    delete process.env.HOME
    try {
      // Reading the environment alone would expand to '' and fail the stat
      // probe; the OS lookup still answers.
      expect(resolveDirArg(undefined, 'p1', '~', false)).toBe(homedir())
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
    }
  })

  it('resolves a bare name under the scan roots, first root holding it wins', () => {
    const first = mkdtempSync(join(tmpdir(), 'dirarg-first-'))
    const second = mkdtempSync(join(tmpdir(), 'dirarg-second-'))
    const target = join(second, 'mem0')
    mkdirSync(target)
    const dh = new DirHistory(mkdtempSync(join(tmpdir(), 'dirarg-data-')))
    dh.setScanPaths('p1', [first, second])
    expect(resolveDirArg(dh, 'p1', 'mem0', false)).toBe(target)
    expect(resolveDirArg(dh, 'p1', 'not-scanned', false)).toBeUndefined()
  })

  it('fuzzy-matches a typo only when the caller allows it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dirarg-fuzzy-'))
    const target = join(root, 'mem0')
    mkdirSync(target)
    const dh = new DirHistory(mkdtempSync(join(tmpdir(), 'dirarg-data-')))
    dh.setScanPaths('p1', [root])
    // Same input, same store: the flag alone decides whether the neighbour
    // directory is picked (human-typed) or the miss fails loud (dispatched).
    expect(resolveDirArg(dh, 'p1', 'nem0', true)).toBe(target)
    expect(resolveDirArg(dh, 'p1', 'nem0', false)).toBeUndefined()
  })

  it('keeps absolute paths working without a dir history and drops bare names', () => {
    const root = mkdtempSync(join(tmpdir(), 'dirarg-nohistory-'))
    const target = join(root, 'mem0')
    mkdirSync(target)
    expect(resolveDirArg(undefined, 'p1', target, false)).toBe(target)
    expect(resolveDirArg(undefined, 'p1', 'mem0', false)).toBeUndefined()
  })
})
