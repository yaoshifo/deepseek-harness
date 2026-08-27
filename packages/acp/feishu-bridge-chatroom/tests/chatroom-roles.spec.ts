/**
 * Chatroom role-directory tests ported 1:1 from cc-connect
 * core/chatroom_roles_test.go.
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-roles
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  defaultChatroomRolesDir,
  listRoleNames,
  roleEssence,
  roleExists,
  validRoleName,
} from '../src/engine/chatroom-roles.js'

/** Write a minimal role persona directory (CLAUDE.md only). */
async function writeRole(root: string, name: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'CLAUDE.md'), `# ${name}\n`, 'utf8')
}

describe('validRoleName', () => {
  it('accepts single-segment names', () => {
    for (const n of ['taleb', 'munger', 'naval-ravikant', '2nd_brain']) {
      expect(validRoleName(n)).toBeUndefined()
    }
  })

  it('rejects traversal and separator names', () => {
    for (const n of ['', '.', '..', 'a/b', 'a\\b', 'a..b', '../x', ' ']) {
      expect(validRoleName(n)).not.toBeUndefined()
    }
  })
})

describe('listRoleNames', () => {
  it('lists subdirectories containing CLAUDE.md, sorted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-roles-'))
    await writeRole(root, 'munger')
    await writeRole(root, 'taleb')
    // A subdir without CLAUDE.md must be ignored.
    await mkdir(join(root, 'incomplete'), { recursive: true })
    // A bare file (not a dir) must be ignored.
    await writeFile(join(root, 'stray.md'), 'x', 'utf8')

    const got = [...listRoleNames(root)].sort()
    expect(got).toEqual(['munger', 'taleb'])
  })

  it('returns empty for a missing root', async () => {
    expect(listRoleNames(join(tmpdir(), 'does-not-exist-xyz'))).toEqual([])
  })
})

describe('roleExists', () => {
  it('true only for directories with a CLAUDE.md file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-roles-'))
    await writeRole(root, 'taleb')
    await mkdir(join(root, 'incomplete'), { recursive: true })
    expect(roleExists(root, 'taleb')).toBe(true)
    expect(roleExists(root, 'incomplete')).toBe(false)
    expect(roleExists(root, '../elsewhere')).toBe(false)
  })
})

describe('roleEssence', () => {
  it('extracts the bold root mental model, degrades for other formats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-roles-'))

    const gDir = join(root, 'graham')
    await mkdir(gDir, { recursive: true })
    const ess = '# Graham\n\n## 核心框架\n\n根心智模型 = **margin of safety（安全边际）**：评估的内在价值显著高于价格。`[src: the-intelligent-investor/concept-graph.md → MOS]`\n'
    await writeFile(join(gDir, 'ESSENCE.md'), ess, 'utf8')

    const wDir = join(root, 'weird')
    await mkdir(wDir, { recursive: true })
    await writeFile(join(wDir, 'ESSENCE.md'), '# Weird\n\n总纲 = **X**：...\n', 'utf8')

    await writeRole(root, 'bare')

    expect(roleEssence(root, 'graham')).toBe('margin of safety（安全边际）')
    expect(roleEssence(root, 'weird')).toBe('')
    expect(roleEssence(root, 'bare')).toBe('')
    expect(roleEssence(join(root, 'missing'), 'x')).toBe('')
  })
})

describe('defaultChatroomRolesDir', () => {
  it('lives under the Claude config home', () => {
    expect(defaultChatroomRolesDir().endsWith(join('chatroom-roles'))).toBe(true)
  })
})
