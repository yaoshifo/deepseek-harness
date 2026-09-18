/**
 * Profile-link preflight behavior: which `link:` dependencies a profile
 * manifest may keep and which must fail the check before a merge.
 *
 * @module verify-profile-links.spec
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { findBrokenProfileLinks, resolveProfileLink } from './verify-profile-links.ts'

describe('profile link preflight', () => {
  let root: string
  let profileDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'profile-links-'))
    profileDir = join(root, 'profiles', 'feishu-bridge')
    mkdirSync(profileDir, { recursive: true })
  })

  function makePackage(path: string): string {
    const dir = join(root, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n')
    return dir
  }

  it('reports a link whose target directory is gone', () => {
    const target = join(root, 'packages', 'fs', 'tool-present')
    expect(findBrokenProfileLinks(
      { dependencies: { '@deepseek-ai/dsh-tool-present': `link:${target}` } },
      { profileDir, forkDir: root },
    )).toEqual([{
      name: '@deepseek-ai/dsh-tool-present',
      specifier: `link:${target}`,
      target,
      reason: 'missing-directory',
    }])
  })

  it('reports a target that exists without a package manifest', () => {
    const target = join(root, 'packages', 'deliverables', 'tool-present')
    mkdirSync(target, { recursive: true })
    expect(findBrokenProfileLinks(
      { dependencies: { '@deepseek-ai/dsh-tool-present': `link:${target}` } },
      { profileDir, forkDir: root },
    )).toEqual([{
      name: '@deepseek-ai/dsh-tool-present',
      specifier: `link:${target}`,
      target,
      reason: 'missing-manifest',
    }])
  })

  it('resolves the template placeholder and relative targets, and passes when both load', () => {
    const placed = makePackage('packages/core/agent')
    const sibling = makePackage('shared/dsh-context')
    expect(findBrokenProfileLinks(
      {
        dependencies: {
          '@deepseek-ai/dsh-agent': 'link:@FORK_DIR@/packages/core/agent',
          'dsh-context': 'link:../../shared/dsh-context',
          '@deepseek-ai/dsh-mcp-client': '1.0.0',
        },
      },
      { profileDir, forkDir: root },
    )).toEqual([])
    expect(resolveProfileLink('link:@FORK_DIR@/packages/core/agent', { profileDir, forkDir: root })).toBe(placed)
    expect(resolveProfileLink('link:../../shared/dsh-context', { profileDir, forkDir: root })).toBe(sibling)
  })

  it('reports a link that names no target', () => {
    expect(findBrokenProfileLinks(
      { dependencies: { '@deepseek-ai/dsh-agent': 'link:' } },
      { profileDir, forkDir: root },
    )).toEqual([{
      name: '@deepseek-ai/dsh-agent',
      specifier: 'link:',
      target: '',
      reason: 'missing-target',
    }])
  })
})
