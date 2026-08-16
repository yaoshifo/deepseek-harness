import { describe, expect, it } from 'vitest'
import { claudeProjectSlug } from '../src/slug.ts'

describe('claudeProjectSlug', () => {
  it.each([
    ['/home/hm/workspace/ainvest', '-home-hm-workspace-ainvest'],
    ['/home/hm/workspace/cc-connect', '-home-hm-workspace-cc-connect'],
    // Each path separator AND each dot becomes one dash; the leading dash is
    // the leading separator, so `.dsh` yields a doubled dash (verified on disk).
    ['/home/hm/.dsh/profiles/cc-connect', '-home-hm--dsh-profiles-cc-connect'],
    ['/home/hm/.claude', '-home-hm--claude'],
    // Case is preserved (verified: -Users-hm-workspace-mem0 on macOS layouts).
    ['/Users/hm/workspace/mem0', '-Users-hm-workspace-mem0'],
    // Underscores and hyphens inside segments survive verbatim.
    ['/home/hm/my_repo/v2-app', '-home-hm-my_repo-v2-app'],
    ['/', '-'],
  ])('encodes %s', (cwd, slug) => {
    expect(claudeProjectSlug(cwd)).toBe(slug)
  })

  it('rejects an empty cwd', () => {
    expect(() => claudeProjectSlug('')).toThrow(TypeError)
  })

  it('rejects a relative cwd', () => {
    expect(() => claudeProjectSlug('workspace/ainvest')).toThrow(TypeError)
  })
})
