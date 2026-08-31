import { describe, expect, it } from 'vitest'
import { markdownToSimpleHTML, splitMessageCodeFenceAware } from '../src/markdown/markdown-html.js'

/**
 * Ported from cc-connect core/markdown/markdown_html_test.go. it() names are
 * `GoTestName/subtestName` (subtests after the slash) so failures map back to
 * the Go suite.
 */

// validateHTMLNesting is ported verbatim from the Go test helper.
function validateHTMLNesting(html: string): Error | null {
  const stack: string[] = []
  let i = 0
  while (i < html.length) {
    if (html[i] !== '<') {
      i++
      continue
    }
    const end = html.indexOf('>', i)
    if (end < 0) break
    const tag = html.slice(i + 1, end)
    i = end + 1
    if (tag.startsWith('/')) {
      let closing = tag.slice(1)
      const sp = closing.indexOf(' ')
      if (sp > 0) closing = closing.slice(0, sp)
      if (stack.length === 0) return new Error(`unexpected closing tag </${closing}>`)
      const top = stack[stack.length - 1]!
      if (top !== closing) return new Error(`expected </${top}>, found </${closing}>`)
      stack.pop()
    } else {
      let name = tag
      const sp = name.indexOf(' ')
      if (sp > 0) name = name.slice(0, sp)
      stack.push(name)
    }
  }
  return null
}

describe('markdownToSimpleHTML', () => {
  it('Bold', () => {
    const out = markdownToSimpleHTML('hello **world**')
    expect(out).toContain('<b>world</b>')
  })

  it('Italic', () => {
    const out = markdownToSimpleHTML('hello *world*')
    expect(out).toContain('<i>world</i>')
  })

  it('Strikethrough', () => {
    const out = markdownToSimpleHTML('hello ~~world~~')
    expect(out).toContain('<s>world</s>')
  })

  it('InlineCode', () => {
    const out = markdownToSimpleHTML('run `echo hello`')
    expect(out).toContain('<code>echo hello</code>')
  })

  it('CodeBlock', () => {
    const out = markdownToSimpleHTML('```go\nfmt.Println()\n```')
    expect(out).toContain('<pre><code class="language-go">')
    expect(out).toContain('fmt.Println()')
  })

  it('Link', () => {
    const out = markdownToSimpleHTML('visit [Google](https://google.com)')
    expect(out).toContain('<a href="https://google.com">Google</a>')
  })

  it('Heading', () => {
    const out = markdownToSimpleHTML('## Section Title')
    expect(out).toContain('<b>Section Title</b>')
  })

  it('Blockquote', () => {
    const out = markdownToSimpleHTML('> quoted text')
    expect(out).toContain('<blockquote>quoted text</blockquote>')
  })

  it('EscapesHTML', () => {
    const out = markdownToSimpleHTML('x < y && y > z')
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
    expect(out).toContain('&amp;')
  })

  it('EscapesInsideBold', () => {
    const out = markdownToSimpleHTML('**x < y**')
    expect(out).toContain('<b>x &lt; y</b>')
  })

  it('LinkWithAmpersand', () => {
    const out = markdownToSimpleHTML('click [here](https://example.com?a=1&b=2)')
    expect(out).toContain('&amp;b=2')
    expect(out).toContain('<a href=')
  })

  it('LinkWithQuotesInURL', () => {
    const out = markdownToSimpleHTML('visit [book](https://example.com/q="test")')
    expect(out).not.toContain('href="https://example.com/q="')
    expect(out).toContain('&quot;')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('EscapesQuotesInText', () => {
    const out = markdownToSimpleHTML('He said "hello" world')
    expect(out).not.toContain('"hello"')
    expect(out).toContain('&quot;hello&quot;')
  })

  it('CodeBlockEscapesHTML', () => {
    const out = markdownToSimpleHTML('```\nif a < b && c > d {\n}\n```')
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
  })

  it('InlineCodeEscapesHTML', () => {
    const out = markdownToSimpleHTML('run `x<y>z`')
    expect(out).toContain('<code>x&lt;y&gt;z</code>')
  })

  it('MixedFormattingWithSpecialChars', () => {
    const out = markdownToSimpleHTML('**bold** & *italic* < normal')
    expect(out).toContain('<b>bold</b>')
    expect(out).toContain('&amp;')
    expect(out).toContain('&lt;')
  })

  it('NoCrossedTags/bold then italic', () => {
    const out = markdownToSimpleHTML('**bold *text***')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('NoCrossedTags/italic around bold', () => {
    const out = markdownToSimpleHTML('*italic **bold** more*')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('NoCrossedTags/heading with bold', () => {
    const out = markdownToSimpleHTML('## **important** heading')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('NoCrossedTags/heading with italic', () => {
    const out = markdownToSimpleHTML('## *weather* report')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('NoCrossedTags/mixed line', () => {
    const out = markdownToSimpleHTML('**北京** *晴天* 25°C')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('NoCrossedTags/triple star', () => {
    const out = markdownToSimpleHTML('***bold italic***')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('UnorderedList', () => {
    const out = markdownToSimpleHTML('Items:\n- first item\n- second item\n- third item')
    expect(out).toContain('• first item')
    expect(out).toContain('• second item')
  })

  it('UnorderedListAsterisk', () => {
    const out = markdownToSimpleHTML('* one\n* two')
    expect(out).toContain('• one')
  })

  it('OrderedList', () => {
    const out = markdownToSimpleHTML('Steps:\n1. first\n2. second\n3. third')
    expect(out).toContain('1.')
    expect(out).toContain('first')
    expect(out).toContain('2.')
    expect(out).toContain('second')
  })

  it('ListWithInlineFormatting', () => {
    const out = markdownToSimpleHTML('- **bold item**\n- `code item`\n- *italic item*')
    expect(out).toContain('• <b>bold item</b>')
    expect(out).toContain('• <code>code item</code>')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('NestedList', () => {
    const out = markdownToSimpleHTML('- top\n  - nested\n    - deep')
    expect(out).toContain('• top')
    expect(out).toContain('  • nested')
    expect(out).toContain('    • deep')
  })

  it('GeminiTypicalOutput', () => {
    const md = `## Analysis Results

Here are the findings:

- **File structure**: The project has 3 main directories
- **Dependencies**: All up to date
- **Tests**: 15 passing, 0 failing

### Recommendations

1. Update the \`README.md\` file
2. Add **error handling** to the main function
3. Consider using ~~deprecated~~ updated API

> Note: This is an automated analysis

For more info, visit [docs](https://example.com).`

    const out = markdownToSimpleHTML(md)

    expect(out).toContain('<b>Analysis Results</b>')
    expect(out).toContain('• <b>File structure</b>')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<a href=')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('CodeBlockWithHTMLTags', () => {
    const out = markdownToSimpleHTML('```html\n<div class="test">\n  <p>Hello</p>\n</div>\n```')
    expect(out).toContain('&lt;div')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('HorizontalRule', () => {
    const out = markdownToSimpleHTML('before\n---\nafter')
    expect(out).toContain('——————————')
  })

  it('UnclosedCodeBlock', () => {
    const out = markdownToSimpleHTML("```python\nprint('hello')\nprint('world')")
    expect(out).toContain('print')
    expect(out).toContain('<pre><code>')
  })

  it('MultiLineBlockquote', () => {
    const out = markdownToSimpleHTML('> line 1\n> line 2\n> line 3')
    expect(out.match(/<blockquote>/g)?.length ?? 0).toBe(1)
    expect(out).toContain('line 1\nline 2\nline 3')
  })

  it('BlockquoteBreaksOnBlankLine', () => {
    const out = markdownToSimpleHTML('> quote 1\n\n> quote 2')
    expect(out.match(/<blockquote>/g)?.length ?? 0).toBe(2)
  })

  it('Table', () => {
    const out = markdownToSimpleHTML('| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |')
    expect(out).toContain('<pre>')
    expect(out).toContain('Name')
    expect(out).toContain('Age')
    expect(out).toContain('Alice')
    expect(out).toContain('30')
    // Columns should be aligned with padding
    expect(out).toContain('-----+-')
  })

  it('TableWithFormatting', () => {
    // Inline formatting is escaped inside <pre> since HTML tags in <pre> render literally in Telegram
    const out = markdownToSimpleHTML('| **Header** | `code` |\n|---|---|\n| *italic* | normal |')
    expect(out).toContain('<pre>')
    expect(out).toContain('Header')
    expect(out).toContain('code')
  })

  it('BoldItalic', () => {
    const out = markdownToSimpleHTML('this is ***bold italic*** text')
    expect(out).toContain('<b><i>bold italic</i></b>')
    expect(validateHTMLNesting(out)).toBeNull()
  })

  it('Wikilink/simple wikilink', () => {
    const out = markdownToSimpleHTML('see [[MyPage]]')
    expect(out).toContain('MyPage')
    expect(out).not.toContain('[[')
    expect(out).not.toContain(']]')
  })

  it('Wikilink/wikilink with display text', () => {
    const out = markdownToSimpleHTML('see [[MyPage|Display Text]]')
    expect(out).toContain('Display Text')
    expect(out).not.toContain('[[')
    expect(out).not.toContain(']]')
  })

  it('Wikilink/wikilink escapes html', () => {
    const out = markdownToSimpleHTML('see [[Page<script>]]')
    expect(out).toContain('Page&lt;script&gt;')
    expect(out).not.toContain('[[')
    expect(out).not.toContain(']]')
  })

  it('Callout/callout with title', () => {
    const out = markdownToSimpleHTML('> [!info] Important Note\n> This is the content')
    expect(out).toContain('<blockquote><b>info: Important Note</b>\nThis is the content</blockquote>')
  })

  it('Callout/callout without title', () => {
    const out = markdownToSimpleHTML('> [!warn]\n> Be careful')
    expect(out).toContain('<blockquote><b>warn</b>\nBe careful</blockquote>')
  })

  it('Callout/normal blockquote unchanged', () => {
    const out = markdownToSimpleHTML('> just a quote')
    expect(out).toContain('<blockquote>just a quote</blockquote>')
  })

  it('treats a ``` line inside a four-backtick fence as code content', () => {
    // A naive ``` toggle would close the block early and render the code
    // line as prose (bold-parsed, tag-escaped).
    const out = markdownToSimpleHTML('````md\n```\nbold **x**\n````')
    expect(out).toContain('```\nbold **x**')
    expect(out).not.toContain('<b>')
  })
})

describe('splitMessageCodeFenceAware', () => {
  it('Short', () => {
    const chunks = splitMessageCodeFenceAware('hello', 100)
    expect(chunks).toEqual(['hello'])
  })

  it('PreservesCodeBlock', () => {
    const text = ['before', '```python', "print('hello')", "print('world')", '```', 'after'].join('\n')

    const chunks = splitMessageCodeFenceAware(text, 30)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const full = chunks.join('')
    expect(full).toContain("print('hello')")
  })

  it('NoCodeBlock', () => {
    const text = 'abcdefghij\n'.repeat(20)
    const chunks = splitMessageCodeFenceAware(text, 50)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50)
    }
  })

  it('ChunkDoesNotExceedMaxLen', () => {
    // Build text: a code block long enough to force splitting
    let text = '```go\n'
    for (let i = 0; i < 30; i++) {
      text += `line ${i}: some code content here\n`
    }
    text += '```\n'

    const maxLen = 100
    const chunks = splitMessageCodeFenceAware(text, maxLen)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLen)
    }
  })

  it('keeps the tracked fence open across a ``` line inside a four-backtick block', () => {
    // A naive ``` toggle would clear the tracked fence at the inner run, so
    // continuation chunks would neither re-open nor close the block.
    const lines = ['````md', '```']
    for (let i = 0; i < 12; i++) lines.push(`line ${i}: some content`)
    lines.push('````')

    const chunks = splitMessageCodeFenceAware(lines.join('\n'), 60)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.startsWith('````md')).toBe(true)
      expect(chunk.endsWith('\n```')).toBe(true)
    }
    expect(chunks.at(-1)?.endsWith('````')).toBe(true)
  })
})
