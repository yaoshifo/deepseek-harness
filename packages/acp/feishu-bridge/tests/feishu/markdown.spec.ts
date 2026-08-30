/**
 * Markdown transform tests ported from cc-connect platform/feishu
 * feishu_test.go (markdown section) and feishu_markdown_html_test.go.
 *
 * @module dsh-feishu-bridge/tests-feishu-markdown
 */

import { describe, expect, it } from 'vitest'
import {
  collapseExcessCardTables,
  containsMarkdown,
  countMarkdownTables,
  finalizeFeishuCardMarkdown,
  hasComplexMarkdown,
  maxCardTables,
  padBoldDelimiters,
  parseInlineMarkdown,
  preprocessFeishuMarkdown,
  previewOverflow,
  sanitizeFeishuMarkdownHTML,
} from '../../src/feishu/markdown.js'

describe('sanitizeFeishuMarkdownHTML', () => {
  const cases: Array<[name: string, input: string, want: string]> = [
    ['plain text unchanged', 'just a normal question', 'just a normal question'],
    ['div stripped inner kept', '<div class="card">善本</div>', '善本'],
    ['table stripped', '<table><tr><td>A</td><td>B</td></tr></table>', 'AB'],
    ['p and span stripped', '<p>line</p><span>x</span>', 'linex'],
    ['font preserved', '<font color="red">w</font>', '<font color="red">w</font>'],
    ['at preserved', '<at user_id="1"></at> hi', '<at user_id="1"></at> hi'],
    ['anchor preserved', '<a href="https://x.com">link</a>', '<a href="https://x.com">link</a>'],
    ['br self-close preserved', 'x<br/>y', 'x<br/>y'],
    ['code fence html preserved', '```\n<div>raw</div>\n```', '```\n<div>raw</div>\n```'],
    ['img self-close stripped', '<img src="x"/>photo', 'photo'],
    ['comparison not stripped', 'if a < b then c', 'if a < b then c'],
    [
      'real-world html preview (bug repro)',
      "<style>.x{color:red}</style>\n<div class='hero'>\n  <h1>善本</h1>\n  <p>T</p>\n</div>",
      '.x{color:red}\n\n  善本\n  T\n',
    ],
  ]
  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(sanitizeFeishuMarkdownHTML(input)).toBe(want)
    })
  }
})

describe('parseInlineMarkdown', () => {
  it('link', () => {
    const elements = parseInlineMarkdown('visit [Google](https://google.com) now')
    const found = elements.some(el => el.tag === 'a' && el.text === 'Google' && el.href === 'https://google.com')
    expect(found).toBe(true)
  })

  it('italic', () => {
    const elements = parseInlineMarkdown('hello *world*')
    const found = elements.some(el => (el.style ?? []).includes('italic') && el.text === 'world')
    expect(found).toBe(true)
  })

  it('strikethrough', () => {
    const elements = parseInlineMarkdown('hello ~~world~~')
    const found = elements.some(el => (el.style ?? []).includes('lineThrough') && el.text === 'world')
    expect(found).toBe(true)
  })

  it('bold and code', () => {
    const elements = parseInlineMarkdown('**bold** and `code`')
    const hasBold = elements.some(el => (el.style ?? []).includes('bold') && el.text === 'bold')
    const hasCode = elements.some(el => (el.style ?? []).includes('code') && el.text === 'code')
    expect(hasBold && hasCode).toBe(true)
  })
})

describe('preprocessFeishuMarkdown', () => {
  it('newline before code fence', () => {
    const out = preprocessFeishuMarkdown('some text```go\ncode\n```')
    // After pass 1: code fence gets its own line. After pass 2: non-empty
    // lines get \n\n.
    expect(out).toContain('text\n\n```go')
    expect(out).toContain('```go\ncode\n```')
  })

  it('already newline', () => {
    const out = preprocessFeishuMarkdown('text\n```go\ncode\n```')
    expect(out).toContain('```go\ncode\n```')
    expect(out).toContain('text\n\n```go')
  })

  it('preserves tables and headings', () => {
    const out = preprocessFeishuMarkdown('## Title\n| A | B |\n|---|---|\n> quote')
    expect(out).toContain('## Title')
    expect(out).toContain('| A | B |')
    expect(out).toContain('> quote')
  })

  it('does not split a four-backtick fence mid-run', () => {
    // A nested code example (the standard way to show a fenced block inside
    // a block) — pass 1 must insert the break before the run, never inside.
    const out = preprocessFeishuMarkdown('example````markdown\ninner\n````done')
    expect(out).toContain('example\n\n````markdown')
    expect(out).toContain('````markdown\ninner\n````done')
  })

  it('a fenced block containing a shorter fence keeps its interior intact', () => {
    // The inner ``` is content of the four-backtick block, not a closing
    // fence; blank-line padding must not be injected between its lines.
    const md = '````markdown\nbefore\n```\ncode\n```\nafter\n````'
    const out = preprocessFeishuMarkdown(md)
    expect(out).toContain('```\ncode\n```')
    expect(out).not.toContain('```\n\ncode')
  })
})

describe('padBoldDelimiters', () => {
  const cases: Array<[name: string, input: string, want: string]> = [
    ['closing glued to latin letter', '**bold**mico runs locally', '**bold** mico runs locally'],
    ['closing glued to CJK', '**本地终端**上的进程', '**本地终端** 上的进程'],
    ['closing glued to fullwidth punctuation', '**三件事**：验证身份', '**三件事** ：验证身份'],
    ['opening glued to CJK', '拓扑是**执行面**与控制面', '拓扑是 **执行面** 与控制面'],
    ['both sides glued', '中文**加粗**中文', '中文 **加粗** 中文'],
    ['already spaced stays unchanged', 'a **b** c', 'a **b** c'],
    ['line boundaries need no padding', '**b**', '**b**'],
    ['code fence content untouched', '```\n**a**b\n```', '```\n**a**b\n```'],
    ['inline code content untouched', 'run `**a**b` now', 'run `**a**b` now'],
    ['three-star runs untouched', '***x***y', '***x***y'],
    ['four-star runs untouched', '****x****y', '****x****y'],
    ['underscore bold padded symmetrically', '__bold__tail', '__bold__ tail'],
    ['unpaired delimiters untouched', '2 ** 3 = 8 and a** alone', '2 ** 3 = 8 and a** alone'],
  ]
  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(padBoldDelimiters(input)).toBe(want)
    })
  }

  it('real-world reply: closing ** glued to the next word (bug repro)', () => {
    const reply = '**运行在你安装 mico 的本地终端（你的电脑）上，不在 mico 服务器上。**mico 服务器只负责签发凭证和协调。'
    expect(padBoldDelimiters(reply)).toBe(
      '**运行在你安装 mico 的本地终端（你的电脑）上，不在 mico 服务器上。** mico 服务器只负责签发凭证和协调。',
    )
  })
})

describe('finalizeFeishuCardMarkdown', () => {
  it('pads glued bold delimiters before rendering', () => {
    const out = finalizeFeishuCardMarkdown('前置文字**加粗段**后置文字')
    expect(out).toContain('前置文字 **加粗段** 后置文字')
  })
})

describe('hasComplexMarkdown', () => {
  it('detects code blocks, tables, and rejects simple markdown', () => {
    expect(hasComplexMarkdown('text\n```go\ncode\n```')).toBe(true)
    expect(hasComplexMarkdown('| A | B |\n|---|---|')).toBe(true)
    expect(hasComplexMarkdown('**bold** and *italic*')).toBe(false)
  })
})

describe('countMarkdownTables', () => {
  const cases: Array<[name: string, input: string, want: number]> = [
    ['no tables', 'hello world', 0],
    ['one table', '| A | B |\n|---|---|\n| 1 | 2 |', 1],
    ['two tables separated by text', '| A |\n|---|\n\nsome text\n\n| B |\n|---|', 2],
    ['consecutive tables no gap', '| A |\n|---|\n| 1 |\n| B |\n|---|', 1],
    [
      'six tables',
      '| A |\n|---|\n\nx\n\n| B |\n|---|\n\nx\n\n| C |\n|---|\n\nx\n\n| D |\n|---|\n\nx\n\n| E |\n|---|\n\nx\n\n| F |\n|---|',
      6,
    ],
    ['pipe lines inside a code fence are code, not a table', '```\n| A |\n```\n\n| B |\n|---|', 1],
  ]
  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(countMarkdownTables(input)).toBe(want)
    })
  }
})

describe('collapseExcessCardTables', () => {
  const mkTable = (id: string): string => `| ${id} |\n|---|`

  it('no tables unchanged', () => {
    const input = 'just prose\nno tables here'
    expect(collapseExcessCardTables(input)).toBe(input)
  })

  it('pipe lines inside a code fence are never collapsed', () => {
    // Tool output often embeds markdown files / CLI tables in code fences;
    // those render as code text (no table component, no 11310 risk) —
    // collapsing them deletes real content and mislabels the code block.
    const inner = ['| a |', '| b |', '| c |', '| d |', '| e |', '| f |'].join('\n\n')
    const input = `\`\`\`markdown\n${inner}\n\`\`\``
    const got = collapseExcessCardTables(input)
    expect(got).toBe(input)
  })

  it('five tables unchanged (fast path)', () => {
    const parts: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = String.fromCharCode(65 + i)
      parts.push(mkTable(id), `prose ${id}`)
    }
    const input = parts.join('\n\n')
    expect(collapseExcessCardTables(input)).toBe(input)
  })

  it('eight tables collapse to five with one marker', () => {
    const parts: string[] = []
    for (let i = 0; i < 8; i++) {
      const id = String.fromCharCode(65 + i)
      parts.push(mkTable(id), `prose ${id}`)
    }
    const got = collapseExcessCardTables(parts.join('\n\n'))
    expect(countMarkdownTables(got)).toBe(maxCardTables)
    expect(got.split('更多表格见完整答复').length - 1).toBe(1)
    for (let i = 0; i < 5; i++) {
      expect(got).toContain(`| ${String.fromCharCode(65 + i)} |`)
    }
    for (let i = 5; i < 8; i++) {
      expect(got).not.toContain(`| ${String.fromCharCode(65 + i)} |`)
    }
    for (let i = 0; i < 8; i++) {
      expect(got).toContain(`prose ${String.fromCharCode(65 + i)}`)
    }
  })
})

describe('previewOverflow', () => {
  const mkTable = (id: string): string => `| ${id} |\n|---|`

  it('no tables', () => {
    expect(previewOverflow('just prose')).toBe(false)
  })

  it('five tables', () => {
    const parts: string[] = []
    for (let i = 0; i < 5; i++) parts.push(mkTable(String.fromCharCode(65 + i)))
    expect(previewOverflow(parts.join('\n\n'))).toBe(false)
  })

  it('six tables', () => {
    const parts: string[] = []
    for (let i = 0; i < 6; i++) parts.push(mkTable(String.fromCharCode(65 + i)))
    expect(previewOverflow(parts.join('\n\n'))).toBe(true)
  })
})

describe('containsMarkdown', () => {
  it('plain text is not markdown', () => {
    expect(containsMarkdown('just a normal question')).toBe(false)
  })

  it('code fence and bold are markdown', () => {
    expect(containsMarkdown('```go\ncode\n```')).toBe(true)
    expect(containsMarkdown('**bold**')).toBe(true)
  })
})
