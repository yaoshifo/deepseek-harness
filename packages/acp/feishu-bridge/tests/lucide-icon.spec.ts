import { describe, expect, it } from 'vitest'
import { levenshtein } from '../src/lucide/fuzzy.ts'
import { lucideIconSVG, normalizeArcFlags, splitRepeatedArcs } from '../src/lucide/icon.ts'

// Ported from cc-connect core/lucide_icon_test.go. it() names are
// `GoTestName/subtestName`.

describe('lucideIconSVG', () => {
  it('Known', () => {
    const svg = lucideIconSVG('check', '#ffffff')
    expect(svg).toBeDefined()
    expect(svg!.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toContain('<path')
    expect(svg).toContain('stroke="#ffffff"')
    expect(svg).toContain('stroke-width="3"')
  })

  it('DefaultStroke', () => {
    // Empty strokeColor → default #1f2329
    const svg = lucideIconSVG('check', '')
    expect(svg).toBeDefined()
    expect(svg).toContain('stroke="#1f2329"')
  })

  it('Unknown', () => {
    expect(lucideIconSVG('this-icon-does-not-exist-xyz', '#ffffff')).toBeUndefined()
  })

  it('CaseInsensitive', () => {
    expect(lucideIconSVG('CHECK', '#ffffff')).toBeDefined()
  })

  it('BookOpenArcFlagNormalized', () => {
    // Regression: book-open's page path uses compact arc flags; lucideIconSVG
    // must normalize them or the rasterizer drops the page path.
    const svg = lucideIconSVG('book-open', '#ffffff')
    expect(svg).toBeDefined()
    expect(svg).not.toContain('0 0022')
    expect(svg).toContain('0 0 22 17')
  })

  it('CurrentColorReplaced', () => {
    // tag & friends carry fill="currentColor"; it must be replaced by the
    // stroke color (Lucide semantics: currentColor = foreground = stroke).
    for (const name of ['tag', 'tags', 'palette']) {
      const svg = lucideIconSVG(name, '#ffffff')
      expect(svg, `${name} not found in sprite`).toBeDefined()
      expect(svg).not.toContain('currentColor')
      expect(svg).toContain('fill="#ffffff"')
    }
  })

  it('FuzzyTypo', () => {
    // A misspelled name (one missing letter) corrects to the nearest valid
    // icon and returns the same SVG as the correct name.
    const good = lucideIconSVG('microscope', '#ffffff')
    expect(good).toBeDefined()
    expect(good).not.toBe('')
    const got = lucideIconSVG('micrscope', '#ffffff') // missing one o
    expect(got, 'fuzzy fallback miss for "micrscope"').toBeDefined()
    expect(got).toBe(good)
  })

  it('FuzzyFar', () => {
    // Garbage far from any icon: no correction, undefined (keep default avatar).
    expect(lucideIconSVG('zzqqxx', '#ffffff')).toBeUndefined()
  })
})

describe('normalizeArcFlags', () => {
  it('normalizes compact arc flags', () => {
    // book-open's page-outline path: several compact arc flags
    // (e.g. A2 2 0 0022 17, flags 0,0 glued to x=22).
    const input = 'M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z'
    const out = normalizeArcFlags(input)
    expect(out).toContain('A 2 2 0 0 0 22 17') // 1st A: rx=2 ry=2 rot=0 laf=0 sf=0 x=22 y=17
    expect(out).toContain('a 2 2 0 0 0 -1.999 -2') // 1st a (relative)
    expect(out).toContain('A 5 5 0 0 0 12 5') // 2nd A
    expect(out).toContain('a 5 5 0 0 1 4 2') // a with sweep-flag=1 (014 → laf=0 sf=1 x=4)
    // Compact flags (flag glued to a digit) must not remain
    expect(out).not.toContain('0 0022')
    // Non-arc commands pass through untouched
    expect(out).toContain('M20.001 19')
  })

  it('NoArcUnchanged', () => {
    const input = 'M0 0L10 10L20 0'
    expect(normalizeArcFlags(input)).toBe(input)
  })
})

describe('splitRepeatedArcs', () => {
  it('single a two groups split', () => {
    expect(splitRepeatedArcs('a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719'))
      .toBe('a 2 2 0 0 1 1.099 .092 a 10 10 0 1 0 -4.777 -4.719')
  })

  it('single group unchanged', () => {
    expect(splitRepeatedArcs('a2 2 0 0 1 1.167')).toBe('a2 2 0 0 1 1.167')
  })

  it('absolute A preserves case', () => {
    expect(splitRepeatedArcs('A2 2 0 0 1 5 6 2 2 0 1 0 7 8'))
      .toBe('A 2 2 0 0 1 5 6 A 2 2 0 1 0 7 8')
  })

  it('non-arc commands untouched', () => {
    expect(splitRepeatedArcs('M1 2L3 4')).toBe('M1 2L3 4')
  })

  it('mixed path single-group arc untouched', () => {
    expect(splitRepeatedArcs('M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29'))
      .toBe('M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29')
  })
})

describe('levenshtein', () => {
  it('computes standard edit distance', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('flaw', 'lawn')).toBe(2)
    expect(levenshtein('micrscope', 'microscope')).toBe(1)
    expect(levenshtein('databse', 'database')).toBe(1)
  })
})
