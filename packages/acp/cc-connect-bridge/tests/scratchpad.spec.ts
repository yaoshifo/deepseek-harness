import { describe, expect, it } from 'vitest'
import { scratchpadContextText } from '../src/scratchpad.js'

describe('scratchpadContextText', () => {
  it('contributes nothing when the env is unset or empty', () => {
    expect(scratchpadContextText(undefined)).toBe('')
    expect(scratchpadContextText('')).toBe('')
  })

  it('names the session directory and its purpose', () => {
    const text = scratchpadContextText('/tmp/cc-scratch/cc-20260816-x')
    expect(text).toContain('/tmp/cc-scratch/cc-20260816-x')
    expect(text).toContain('temporary')
    expect(text).toContain('project')
  })
})
