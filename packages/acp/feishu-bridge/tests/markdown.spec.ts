import { describe, expect, it } from 'vitest'
import { stripMarkdown } from '../src/markdown/markdown.ts'

// Ported from cc-connect core/markdown/markdown_test.go (TestStripMarkdown).
describe('stripMarkdown', () => {
  it('bold', () => {
    expect(stripMarkdown('**bold text**')).toContain('bold text')
  })

  it('italic', () => {
    expect(stripMarkdown('_italic_')).toContain('italic')
  })

  it('code', () => {
    expect(stripMarkdown('`code`')).toContain('code')
  })

  it('code block', () => {
    expect(stripMarkdown('```\ncode\n```')).toContain('code')
  })

  it('link', () => {
    expect(stripMarkdown('[text](http://x)')).toContain('text (http://x)')
  })

  it('heading', () => {
    expect(stripMarkdown('## Title')).toContain('Title')
  })

  it('strikethrough', () => {
    expect(stripMarkdown('~~deleted~~')).toContain('deleted')
  })

  it('mixed', () => {
    expect(stripMarkdown('**bold** and `code`')).toContain('bold')
  })
})
