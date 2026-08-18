import { describe, expect, it } from 'vitest'
import { unescapeCLIText } from '../src/cli-escape.js'

// Ported from cc-connect core/cli_escape_test.go (1 Go test, table-driven).
describe('unescapeCLIText', () => {
  it('restores common backslash escapes and preserves the rest', () => {
    expect(unescapeCLIText('a\\nb')).toBe('a\nb')
    expect(unescapeCLIText('a\\n\\nb')).toBe('a\n\nb')
    expect(unescapeCLIText('a\\tb')).toBe('a\tb')
    expect(unescapeCLIText('a\\rb')).toBe('a\rb')
    // literal backslash + n (escaped backslash followed by n) stays two chars
    expect(unescapeCLIText('\\\\n')).toBe('\\n')
    // escaped backslash collapses to one
    expect(unescapeCLIText('a\\\\b')).toBe('a\\b')
    // mixed realistic moderator list
    expect(unescapeCLIText('1. **属性**：x\\n2. **相位**：y\\n- 子项'))
      .toBe('1. **属性**：x\n2. **相位**：y\n- 子项')
    // no escapes -> unchanged
    expect(unescapeCLIText('普通文本无转义')).toBe('普通文本无转义')
    // unknown escape preserved as-is
    expect(unescapeCLIText('a\\*b')).toBe('a\\*b')
    // trailing lone backslash preserved
    expect(unescapeCLIText('abc\\')).toBe('abc\\')
    // empty
    expect(unescapeCLIText('')).toBe('')
  })
})
