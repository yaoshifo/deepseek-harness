import { describe, expect, it } from 'vitest'
import { ACTIVE_TAG_NAME, activeTagNameFor } from '../src/active-tag.ts'

// Ported from cc-connect core/active_tag_test.go (1 Go test).
// Go's stubPlatform / stubActiveTagPlatform map to plain objects; the Go
// interface type-assertion p.(ActiveTagNamer) maps to a structural
// activeTagName() check.
describe('activeTagNameFor', () => {
  it('falls back to the global default unless the platform names one', () => {
    // Platform without ActiveTagNamer → global default.
    expect(activeTagNameFor({})).toBe(ACTIVE_TAG_NAME)
    // Platform reporting its own heart → that name.
    expect(activeTagNameFor({ activeTagName: () => '💛' })).toBe('💛')
    // Reports empty → still falls back to default.
    expect(activeTagNameFor({ activeTagName: () => '' })).toBe(ACTIVE_TAG_NAME)
  })
})
