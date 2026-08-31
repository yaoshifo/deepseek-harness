/**
 * Worktree memory-cleanup helpers: the empty-dir guard on
 * removeOrphanMemory — the engine passes '' explicitly when no work dir is
 * tracked, and '' must not fall through to a CWD-relative memory/ path.
 *
 * @module dsh-feishu-bridge/tests-engine-worktree
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { removeOrphanMemory } from '../../src/engine/worktree.ts'

describe('removeOrphanMemory', () => {
  it("'' is a no-op even when the process CWD holds a populated memory/ directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-worktree-'))
    const prevCwd = process.cwd()
    try {
      await mkdir(join(dir, 'memory'))
      await writeFile(join(dir, 'memory', 'MEMORY.md'), 'content')
      process.chdir(dir)
      expect(removeOrphanMemory('')).toBe('')
      expect(existsSync(join(dir, 'memory', 'MEMORY.md'))).toBe(true)
    } finally {
      process.chdir(prevCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
