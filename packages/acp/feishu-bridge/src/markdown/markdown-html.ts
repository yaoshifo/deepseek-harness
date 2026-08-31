/**
 * Markdown to simplified-HTML conversion, ported from cc-connect
 * core/markdown/markdown_html.go. Supported tags: `<b>`, `<i>`, `<s>`,
 * `<code>`, `<pre>`, `<a href="">`, `<blockquote>` — the subset accepted by
 * HTML-limited platforms (e.g. Telegram).
 *
 * @module dsh-feishu-bridge/markdown-html
 */

import { FenceTracker } from '../feishu/markdown.js'

const encoder = new TextEncoder()

/**
 * Go `len(string)` counts UTF-8 bytes and the message-size limits this module
 * enforces (chunk splitting, table column padding) were byte-based in the
 * source; keep byte semantics so multi-byte content measures identically.
 * @param s - String to measure.
 * @returns UTF-8 byte length of `s`.
 */
const byteLength = (s: string): number => encoder.encode(s).length

const reInlineCodeHTML = /`([^`]+)`/g
const reBoldItalicHTML = /\*\*\*(.+?)\*\*\*/g
const reBoldAstHTML = /\*\*(.+?)\*\*/g
const reBoldUndHTML = /__(.+?)__/g
const reItalicAstHTML = /(?:^|[^*])\*([^*]+?)\*(?:[^*]|$)/g
const reStrikeHTML = /~~(.+?)~~/g
const reLinkHTML = /\[([^\]]+)\]\(([^)]+)\)/g
const reWikilinkHTML = /\[\[([^\]|]+)\|([^\]]+)\]\]|\[\[([^\]]+)\]\]/g
const reUnorderedList = /^(\s*)[-*]\s+(.*)$/
const reOrderedList = /^(\s*)\d+\.\s+(.*)$/
const reHeading = /^#{1,6}\s+/
const reHorizontal = /^---+\s*$/
const reTableSep = /^\|[\s:|-]+\|$/
const reCallout = /^\[!(\w+)\]\s*(.*)$/

const escapeHTML = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/**
 * Convert inline Markdown formatting to the simplified HTML subset.
 *
 * Each formatting pass (inline code, links, bold, strikethrough) protects its
 * output as `\u0000PHn\u0000` placeholders so that subsequent passes (italic)
 * cannot match across HTML tag boundaries.
 */
function convertInlineHTML(source: string): string {
  const phs: { key: string; html: string }[] = []
  let phIdx = 0

  // Mirrors the Go key "\x00PH" + rune('0'+i) + "\x00".
  const nextPH = (html: string): string => {
    const key = `\u0000PH${String.fromCharCode(48 + phIdx)}\u0000`
    phs.push({ key, html })
    phIdx++
    return key
  }

  let s = source

  // 1. Extract inline code → placeholder (content escaped)
  s = s.replace(reInlineCodeHTML, m => nextPH(`<code>${escapeHTML(m.slice(1, -1))}</code>`))

  // 2. Extract links → placeholder (text & URL escaped)
  s = s.replace(reLinkHTML, (_m, text: string, url: string) =>
    nextPH(`<a href="${escapeHTML(url)}">${escapeHTML(text)}</a>`))

  // 2b. Wikilinks: [[Link|Text]] → Text, [[Link]] → Link
  // Don't escape here — step 3 will HTML-escape the whole remaining text.
  s = s.replace(reWikilinkHTML, (m, link: string | undefined, display: string | undefined, bare: string | undefined) => {
    if (link !== undefined && display !== undefined && link !== '' && display !== '') return display
    if (bare !== undefined && bare !== '') return bare
    return m
  })

  // 3. HTML-escape the entire remaining text.
  s = escapeHTML(s)

  // 4. Bold-italic (***text***) → placeholder (must be before bold)
  s = s.replace(reBoldItalicHTML, m => nextPH(`<b><i>${m.slice(3, -3)}</i></b>`))

  // 5. Bold → placeholder (so italic regex can't cross bold boundaries)
  s = s.replace(reBoldAstHTML, m => nextPH(`<b>${m.slice(2, -2)}</b>`))
  s = s.replace(reBoldUndHTML, m => nextPH(`<b>${m.slice(2, -2)}</b>`))

  // 6. Strikethrough → placeholder
  s = s.replace(reStrikeHTML, m => nextPH(`<s>${m.slice(2, -2)}</s>`))

  // 7. Italic (applied last, on text with bold/strike already protected)
  s = s.replace(reItalicAstHTML, (m) => {
    const idx = m.indexOf('*')
    if (idx < 0) return m
    const lastIdx = m.lastIndexOf('*')
    if (lastIdx <= idx) return m
    return `${m.slice(0, idx)}<i>${m.slice(idx + 1, lastIdx)}</i>${m.slice(lastIdx + 1)}`
  })

  // 8. Restore all placeholders (may be nested, so iterate until stable).
  for (let i = 0; i <= phs.length; i++) {
    let changed = false
    for (const ph of phs) {
      if (s.includes(ph.key)) {
        s = s.replace(ph.key, ph.html)
        changed = true
      }
    }
    if (!changed) break
  }

  return s
}

/**
 * Convert common Markdown to the simplified HTML subset.
 * @param md - Markdown source text.
 * @returns HTML using only the supported tag set.
 */
export function markdownToSimpleHTML(md: string): string {
  let b = ''

  const lines = md.split('\n')
  let inCodeBlock = false
  let codeLang = ''
  let codeLines: string[] = []
  let inBlockquote = false
  let bqLines: string[] = []
  let inTable = false
  let tblLines: string[] = []
  // Length-aware fence tracking: a ``` run shorter than the opening fence
  // is code content, not a toggle.
  const fence = new FenceTracker()

  // flushBlockquote merges buffered blockquote lines into a single
  // <blockquote>. Supports Obsidian-style callouts: `> [!type] Title`.
  const flushBlockquote = (): void => {
    if (bqLines.length === 0) return
    b += '<blockquote>'
    let startIdx = 0
    const m = reCallout.exec(bqLines[0] ?? '')
    if (m !== null) {
      const calloutType = m[1] ?? ''
      const calloutTitle = m[2] ?? ''
      if (calloutTitle !== '') {
        b += `<b>${escapeHTML(calloutType)}: ${escapeHTML(calloutTitle)}</b>`
      } else {
        b += `<b>${escapeHTML(calloutType)}</b>`
      }
      startIdx = 1
      if (startIdx < bqLines.length) b += '\n'
    }
    for (let j = startIdx; j < bqLines.length; j++) {
      if (j > startIdx) b += '\n'
      b += convertInlineHTML(bqLines[j] ?? '')
    }
    b += '</blockquote>'
    bqLines = []
    inBlockquote = false
  }

  // flushTable renders buffered table rows inside a <pre> block with aligned columns.
  const flushTable = (): void => {
    if (tblLines.length === 0) return

    // Parse all rows into cells, skipping separator rows.
    const rows: { cells: string[]; isSep: boolean }[] = []
    for (const tl0 of tblLines) {
      const tl = tl0.trim()
      if (reTableSep.test(tl)) {
        rows.push({ cells: [], isSep: true })
        continue
      }
      let inner = tl
      if (tl.startsWith('|') && tl.endsWith('|') && tl.length >= 2) {
        inner = tl.slice(1, -1).trim()
      }
      rows.push({ cells: inner.split('|').map(c => c.trim()), isSep: false })
    }

    // Compute max width per column.
    let numCols = 0
    for (const r of rows) {
      if (!r.isSep && r.cells.length > numCols) numCols = r.cells.length
    }
    const colWidths: number[] = Array.from<number>({ length: numCols }).fill(0)
    for (const r of rows) {
      if (r.isSep) continue
      for (const [k, c] of r.cells.entries()) {
        if (k < numCols && byteLength(c) > (colWidths[k] ?? 0)) colWidths[k] = byteLength(c)
      }
    }

    // Render inside <pre>.
    b += '<pre>'
    let first = true
    for (const r of rows) {
      if (!first) b += '\n'
      first = false
      if (r.isSep) {
        // Draw separator line matching column widths.
        for (const [k, w] of colWidths.entries()) {
          if (k > 0) b += '-+-'
          b += '-'.repeat(w)
        }
      } else {
        for (let k = 0; k < numCols; k++) {
          if (k > 0) b += ' | '
          const cell = k < r.cells.length ? (r.cells[k] ?? '') : ''
          b += escapeHTML(cell)
          // Pad to column width.
          const pad = (colWidths[k] ?? 0) - byteLength(cell)
          if (pad > 0) b += ' '.repeat(pad)
        }
      }
    }
    b += '</pre>'
    tblLines = []
    inTable = false
  }

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim()
    const inFence = fence.update(trimmed)

    // A state transition marks a fence delimiter line (open on entering,
    // close on leaving); inside a longer fence a shorter ``` line keeps the
    // state and falls through to the code-content branch below.
    if (inFence !== inCodeBlock) {
      if (inFence) {
        if (inBlockquote) {
          flushBlockquote()
          b += '\n'
        }
        if (inTable) {
          flushTable()
          b += '\n'
        }
        inCodeBlock = true
        codeLang = trimmed.slice(3)
        codeLines = []
      } else {
        inCodeBlock = false
        if (codeLang !== '') {
          b += `<pre><code class="language-${escapeHTML(codeLang)}">`
        } else {
          b += '<pre><code>'
        }
        b += escapeHTML(codeLines.join('\n'))
        b += '</code></pre>'
        if (i < lines.length - 1) b += '\n'
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    // Determine line type for blockquote/table buffering
    const isQuote = trimmed.startsWith('> ') || trimmed === '>'
    const isTable = trimmed.length > 2 && trimmed.startsWith('|') && trimmed.endsWith('|')

    // Flush blockquote when leaving
    if (!isQuote && inBlockquote) {
      flushBlockquote()
      b += '\n'
    }
    // Flush table when leaving
    if (!isTable && inTable) {
      flushTable()
      b += '\n'
    }

    // Buffer blockquote lines into a single block
    if (isQuote) {
      let quoteContent = trimmed.startsWith('> ') ? trimmed.slice(2) : trimmed
      if (trimmed === '>') quoteContent = ''
      bqLines.push(quoteContent)
      inBlockquote = true
      continue
    }

    // Buffer table lines
    if (isTable) {
      tblLines.push(trimmed)
      inTable = true
      continue
    }

    // Headings → bold
    const heading = reHeading.exec(line)
    const mu = reUnorderedList.exec(line)
    const mo = reOrderedList.exec(line)
    if (heading !== null) {
      const rest = line.slice(heading[0].length)
      b += `<b>${convertInlineHTML(rest)}</b>`
    } else if (reHorizontal.test(trimmed)) {
      b += '——————————'
    } else if (mu !== null) {
      const indent = '  '.repeat(Math.floor((mu[1] ?? '').length / 2))
      b += `${indent}• ${convertInlineHTML(mu[2] ?? '')}`
    } else if (mo !== null) {
      const indent = '  '.repeat(Math.floor((mo[1] ?? '').length / 2))
      const numDot = line.slice(0, line.length - (mo[2] ?? '').length).trim()
      b += `${indent}${escapeHTML(numDot)} ${convertInlineHTML(mo[2] ?? '')}`
    } else {
      b += convertInlineHTML(line)
    }

    if (i < lines.length - 1) b += '\n'
  }

  // Flush any remaining buffered state
  if (inBlockquote) flushBlockquote()
  if (inTable) flushTable()
  if (inCodeBlock && codeLines.length > 0) {
    b += `<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`
  }

  return b
}

/**
 * Split text into chunks respecting code fence boundaries. When a chunk
 * boundary falls inside a code block, the fence is closed at the end of the
 * chunk and re-opened at the start of the next chunk.
 * @param text - Text to split (byte-based limits, matching the Go source).
 * @param maxLen - Maximum byte length per chunk.
 * @returns Chunks, each at most `maxLen` bytes.
 */
export function splitMessageCodeFenceAware(text: string, maxLen: number): string[] {
  if (byteLength(text) <= maxLen) {
    return [text]
  }

  const closingFence = '\n```' // 4 bytes appended when splitting inside a code block

  const lines = text.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0
  let openFence = '' // the ``` opening line, or "" if outside code block
  // Length-aware fence tracking: a ``` run shorter than the opening fence
  // is content, so the tracked fence stays open across it.
  const fence = new FenceTracker()

  for (const line of lines) {
    const lineLen = byteLength(line) + 1 // +1 for newline

    // Reserve space for the closing fence when inside a code block, so the
    // final chunk length stays within maxLen.
    const limit = openFence !== '' ? maxLen - closingFence.length : maxLen

    if (currentLen + lineLen > limit && current.length > 0) {
      let chunk = current.join('\n')
      if (openFence !== '') chunk += closingFence
      chunks.push(chunk)

      current = []
      currentLen = 0
      if (openFence !== '') {
        current = [openFence]
        currentLen = byteLength(openFence) + 1
      }
    }

    current.push(line)
    currentLen += lineLen

    const inFence = fence.update(line.trim())
    if (inFence && openFence === '') openFence = line.trim()
    else if (!inFence && openFence !== '') openFence = ''
  }

  if (current.length > 0) {
    let chunk = current.join('\n')
    if (openFence !== '') chunk += '\n```'
    chunks.push(chunk)
  }

  return chunks
}
