/**
 * Unit behavior of `@path` import parsing and expansion for workspace instructions.
 *
 * @module dsh-agent-instructions/tests-imports
 */

import { describe, expect, it } from 'vitest'
import { expandInstructionImports, parseImportReferences } from '../src/imports.ts'
describe('instruction import parsing', () => {
  it('skips references inside inline code spans', () => {
    expect(parseImportReferences('Mention `@README` literally; use @docs/real.md.')).toEqual([
      { path: 'docs/real.md', start: 33, end: 46 },
    ])
  })

  it('skips references inside fenced code blocks', () => {
    const content = [
      'Before @docs/before.md',
      '```',
      '@docs/inside.md',
      '```',
      'After @docs/after.md',
    ].join('\n')
    expect(parseImportReferences(content).map(reference => reference.path))
      .toEqual(['docs/before.md', 'docs/after.md'])
  })

  it('does not treat email addresses or mid-word @ as references', () => {
    expect(parseImportReferences('Contact user@example.com or a@b for details.')).toEqual([])
  })

  it('accepts a bare word reference and strips trailing sentence punctuation', () => {
    expect(parseImportReferences('See @README, then @docs/guide.md!'))
      .toEqual([
        { path: 'README', start: 4, end: 11 },
        { path: 'docs/guide.md', start: 18, end: 32 },
      ])
    expect(parseImportReferences('quoted @notes’ tail')).toEqual([
      { path: 'notes', start: 7, end: 13 },
    ])
    expect(parseImportReferences('Punctuation-only @!! token')).toEqual([])
  })
})

describe('instruction import expansion', () => {
  it('resolves ~ and absolute paths and nests relative to the imported file', async () => {
    const files = new Map<string, string>([
      ['/home/tester/rules/inner.md', 'inner rule'],
      ['/abs/shared.md', 'shared rule'],
      ['/home/tester/rules/outer.md', 'outer adds @inner.md'],
    ])
    const expanded = await expandInstructionImports(
      'Home @~/rules/outer.md and absolute @/abs/shared.md',
      '/repo',
      async path => files.get(path),
      { homeDir: '/home/tester' },
    )
    expect(expanded.content).toContain('Imported from: ~/rules/outer.md')
    expect(expanded.content).toContain('outer adds Imported from: inner.md\ninner rule\nEnd imported from: inner.md')
    expect(expanded.content).toContain('Imported from: /abs/shared.md\nshared rule\nEnd imported from: /abs/shared.md')
    expect(expanded.imports).toEqual(['/home/tester/rules/outer.md', '/home/tester/rules/inner.md', '/abs/shared.md'])
  })

  it('stops recursing at the maximum hop depth with an unavailable marker', async () => {
    const files = new Map<string, string>([
      ['/w/b.md', '@c.md'],
      ['/w/c.md', '@d.md'],
      ['/w/d.md', '@e.md'],
      ['/w/e.md', '@f.md'],
      ['/w/f.md', 'deepest rule'],
    ])
    const expanded = await expandInstructionImports('@b.md', '/w', async path => files.get(path))

    expect(expanded.content).not.toContain('deepest rule')
    expect(expanded.content).toContain('[instruction import unavailable: f.md]')
    expect(expanded.imports).toEqual(['/w/b.md', '/w/c.md', '/w/d.md', '/w/e.md'])
  })

  it('marks missing imports unavailable and expands repeated references separately', async () => {
    const files = new Map<string, string>([['/w/there.md', 'present']])
    const expanded = await expandInstructionImports(
      'First @missing.md plus @there.md and again @there.md',
      '/w',
      async path => files.get(path),
    )

    expect(expanded.content).toContain('[instruction import unavailable: missing.md]')
    expect(expanded.content.match(/Imported from: there.md/g)).toHaveLength(2)
    expect(expanded.imports).toEqual(['/w/there.md', '/w/there.md'])
  })
})
