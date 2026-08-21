/**
 * Ported from cc-connect core/dir_history_test.go TestDirHistory_ResolveScanPathFuzzy
 * plus the /dir resolution fallback that consumes it (M7 #3: dir_scan_paths).
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DirHistory } from '../../src/engine/dir-history.js'

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
