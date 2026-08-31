/**
 * ProjectStateStore's durable-file parse boundary: a hand-corrupted state
 * file holding legal-but-wrong JSON (null, an array, a bare primitive) must
 * fall back to empty state instead of poisoning every accessor with a
 * TypeError at plugin load.
 *
 * @module dsh-feishu-bridge/tests-project-state-shape
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectStateStore } from '../../src/engine/project-state.ts'

describe('ProjectStateStore corrupt-shape fallback', () => {
  it.each(['null', '[]', '"text"', '123'])('a %s file loads as empty state', (raw) => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-pstate-shape-'))
    const path = join(dir, 'test.state.json')
    writeFileSync(path, raw, 'utf8')
    const s = new ProjectStateStore(path)
    expect(s.workspaceDirOverride('k')).toBe('')
  })
})
