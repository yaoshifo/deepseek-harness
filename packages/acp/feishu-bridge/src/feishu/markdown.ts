/**
 * Feishu card markdown transforms ported from cc-connect
 * platform/feishu/feishu_markdown.go: markdown detection, card table
 * collapsing (11310 guard), schema 2.0 line-break normalization, URL/HTML
 * sanitization, and the post-format inline parser. Go's dead untested
 * buildPostJSON (zero callers) was not ported.
 *
 * @module dsh-feishu-bridge/feishu-markdown
 */

/** Outbound msg_type values (Go larkim.Msg.Type*). */
export const msgTypeText = 'text'
/** Outbound msg_type for rich-text post messages. */
export const msgTypePost = 'post'
/** Outbound msg_type for interactive cards. */
export const msgTypeInteractive = 'interactive'

/**
 * The Feishu interactive card limit for table components: a single card
 * supports at most 5 tables; exceeding this causes API error 11310.
 */
export const maxCardTables = 5

const markdownIndicators = ['```', '**', '~~', '`', '\n- ', '\n* ', '\n1. ', '\n# ', '---']

/**
 * Whether s carries any markdown syntax worth rich rendering.
 * @param s - Candidate message text.
 * @returns True when any markdown indicator is present.
 */
export function containsMarkdown(s: string): boolean {
  const padded = `\n${s}`
  return markdownIndicators.some(ind => padded.includes(ind))
}

/**
 * Whether s has code blocks or tables that require card rendering.
 * @param s - Candidate message text.
 * @returns True when a fenced code block or a table line is present.
 */
export function hasComplexMarkdown(s: string): boolean {
  if (s.includes('```')) return true
  // Table: line starting and ending with |
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 1 && trimmed[0] === '|' && trimmed[trimmed.length - 1] === '|') return true
  }
  return false
}

/**
 * Length-aware code-fence tracker shared by the fence-aware transforms in
 * this module, markdown-html, and progress: a fence opens on a leading
 * backtick run (``` or longer, info string allowed) and closes on a
 * pure-backtick line at least as long as the opener. Inside a fence, pipe
 * lines are code text, not table rows, and a shorter ``` run is content,
 * not a toggle.
 */
export class FenceTracker {
  private openLen = 0

  /** Update the tracker with one line's trimmed text; returns whether the line sits inside a fence. */
  update(trimmed: string): boolean {
    if (this.openLen === 0) {
      const open = /^(`{3,})/.exec(trimmed)
      if (open !== null) this.openLen = open[0].length
    } else if (/^`{3,}\s*$/.test(trimmed) && trimmed.length >= this.openLen) {
      this.openLen = 0
    }
    return this.openLen > 0
  }
}

/**
 * Count the distinct markdown tables in s: a table is a group of consecutive
 * lines where each line starts and ends with '|'. Pipe lines inside code
 * fences are code text and never count.
 * @param s - Markdown text to scan.
 * @returns The number of distinct table groups.
 */
export function countMarkdownTables(s: string): number {
  let count = 0
  let inTable = false
  const fence = new FenceTracker()
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    const inFence = fence.update(trimmed)
    const isTableLine = !inFence && trimmed.length > 1 && trimmed[0] === '|' && trimmed[trimmed.length - 1] === '|'
    if (isTableLine && !inTable) {
      count++
      inTable = true
    } else if (!isTableLine) {
      inTable = false
    }
  }
  return count
}

/**
 * Keep at most {@link maxCardTables} markdown tables in s, replacing every
 * further table with a single marker line; prose is preserved verbatim. The
 * preview-card PATCH path cannot fall back to a non-card format mid-stream,
 * so excess tables are collapsed and the engine delivers the full answer
 * out-of-band (PreviewOverflowReporter / analysisTruncated). Pipe lines
 * inside code fences are code text and are never collapsed.
 * @param s - Markdown text to deliver.
 * @returns The text with tables beyond maxCardTables replaced by a single marker line.
 */
export function collapseExcessCardTables(s: string): string {
  if (countMarkdownTables(s) <= maxCardTables) return s
  const marker = '_(更多表格见完整答复)_'
  let b = ''
  let tableCount = 0
  let inTable = false
  let markerWritten = false
  const fence = new FenceTracker()
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    const inFence = fence.update(trimmed)
    const isTableLine = !inFence && trimmed.length > 1 && trimmed[0] === '|' && trimmed[trimmed.length - 1] === '|'
    if (isTableLine) {
      if (!inTable) {
        tableCount++
        inTable = true
      }
      if (tableCount <= maxCardTables) {
        b += `${line}\n`
        continue
      }
      if (!markerWritten) {
        b += `${marker}\n`
        markerWritten = true
      }
      // drop excess table line
    } else {
      inTable = false
      b += `${line}\n`
    }
  }
  return b.endsWith('\n') ? b.slice(0, -1) : b
}

/**
 * Whether content overflows the streaming-preview card's table limit.
 * @param content - Candidate card markdown.
 * @returns True when the table count exceeds maxCardTables.
 */
export function previewOverflow(content: string): boolean {
  return countMarkdownTables(content) > maxCardTables
}

/**
 * Whether a line is a markdown table row.
 * @param line - Line to test.
 * @returns True when the line is a markdown table row.
 */
export function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.includes('|')
}

/**
 * Split text into lines the way the Feishu card markdown renderer breaks
 * them: \n, \r\n, and a lone \r each end a line (CommonMark line endings).
 * Line-count caps must count with this rule — tool output holding
 * \r-separated progress updates (git checkout) packs many rendered lines
 * into one \n-line and would otherwise break fixed-height card windows.
 * @param s - Text to split.
 * @returns Lines without their line-ending characters.
 */
export function splitCardLines(s: string): string[] {
  return s.split(/\r\n|\r|\n/)
}

/**
 * Ensure proper line breaks for Feishu card schema 2.0 markdown elements,
 * where a single \n is treated as whitespace (like HTML): converts \n between
 * non-empty lines to \n\n outside code blocks, preserves \n between adjacent
 * table rows, and ensures code fences start on their own line.
 * @param md - Card markdown to normalize.
 * @returns The markdown with Feishu-renderable line breaks.
 */
export function preprocessFeishuMarkdown(md: string): string {
  // Pass 1: ensure code fences start on their own line. Walk whole
  // backtick runs so a four-backtick fence gets one break before the run —
  // splitting at the second backtick would break the fence in half.
  let normalized = ''
  for (let i = 0; i < md.length;) {
    if (md[i] === '`') {
      let j = i
      while (j < md.length && md[j] === '`') j++
      if (j - i >= 3 && i > 0 && md[i - 1] !== '\n') normalized += '\n'
      normalized += md.slice(i, j)
      i = j
      continue
    }
    normalized += md.charAt(i)
    i++
  }

  // Pass 2: convert \n between non-empty lines to \n\n outside code blocks
  // and between non-table rows, so Feishu card markdown renders line breaks.
  // Fence tracking is length-aware: a fence closes only on a pure-backtick
  // line at least as long as the opener, so a ``` inside a ```` block is
  // content, not a toggle.
  const lines = normalized.split('\n')
  let openFenceLen = 0
  let b = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const next = i + 1 < lines.length ? lines[i + 1] as string : undefined
    const trimmed = line.trim()
    if (openFenceLen === 0) {
      const open = /^(`{3,})/.exec(trimmed)
      if (open !== null) openFenceLen = open[0].length
    } else if (/^`{3,}\s*$/.test(trimmed) && trimmed.length >= openFenceLen) {
      openFenceLen = 0
    }
    const inCodeBlock = openFenceLen > 0

    b += line

    if (next !== undefined) {
      if (inCodeBlock) {
        b += '\n'
      } else if (isTableRow(line) && isTableRow(next)) {
        // Adjacent table rows must stay together.
        b += '\n'
      } else if (line !== '' && next !== '') {
        b += '\n\n'
      } else {
        b += '\n'
      }
    }
  }
  return b
}

/**
 * Feishu post hrefs must be HTTP(S); other schemes fail with code 230001.
 * @param u - Link URL to test.
 * @returns True when the scheme is http:// or https://.
 */
export function isValidFeishuHref(u: string): boolean {
  return u.startsWith('http://') || u.startsWith('https://')
}

const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g
const mdImageRe = /!\[([^\]]*)\]\(([^)]+)\)/g

/**
 * Rewrite markdown links with non-HTTP(S) schemes to plain text and strip
 * image syntax, preventing Feishu API rejection (code 230001; cards also
 * reject external image URLs).
 * @param md - Markdown to rewrite.
 * @returns The markdown with image syntax stripped and non-HTTP(S) links converted to plain text.
 */
export function sanitizeMarkdownURLs(md: string): string {
  const stripped = md.replace(mdImageRe, '[$1]')
  return stripped.replace(mdLinkRe, (match, text: string, url: string) => {
    if (isValidFeishuHref(url)) return match
    // Convert invalid-scheme link to "text (url)" plain text
    return `${text} (${url})`
  })
}

/** Any HTML open/close/self-closing tag with a standard tag name. */
const htmlTagRe = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi

/**
 * Tags Feishu interactive card markdown (schema 2.0) can render; any other
 * tag triggers API error 11311 "markdown content parse error".
 */
const feishuAllowedTags = new Set([
  'font', 'at', 'a', 'br', 'hr', 'b', 'strong', 'em', 'i', 'u',
])

/** Remove every HTML tag whose name is not whitelisted, keeping inner text. */
function stripNonFeishuTags(line: string): string {
  return line.replace(htmlTagRe, (tag) => {
    let inner = tag.slice(1)
    if (inner.startsWith('/')) inner = inner.slice(1)
    let end = 0
    while (end < inner.length && /[a-zA-Z0-9]/.test(inner.charAt(end))) end++
    if (end === 0) return tag
    if (feishuAllowedTags.has(inner.slice(0, end).toLowerCase())) return tag
    return ''
  })
}

/**
 * Strip HTML tags Feishu card markdown cannot render. Code fences are tracked
 * line-by-line and left verbatim; outside fences, non-whitelisted tags are
 * removed while the text between tags is kept.
 * @param md - Markdown to clean.
 * @returns The markdown with non-whitelisted HTML tags removed outside code fences.
 */
export function sanitizeFeishuMarkdownHTML(md: string): string {
  const lines = md.split('\n')
  let b = ''
  const fence = new FenceTracker()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const inFence = fence.update(line.trim())
    // Fence lines carry no strippable tags (pure backticks plus an info
    // string), so a separate isFence clause is unneeded; the length-aware
    // tracker keeps a shorter ``` run inside a longer fence as content.
    b += inFence ? line : stripNonFeishuTags(line)
    if (i < lines.length - 1) b += '\n'
  }
  return b
}

/**
 * Pad bold delimiters glued to adjacent text with a space on the glued side.
 * Feishu card markdown renders **bold** / __bold__ only when the delimiters
 * keep whitespace on both sides; a delimiter glued to the neighboring
 * character (e.g. `**……上。**mico`) leaves the whole pair as raw text.
 * Code fences, inline code spans, and runs of 3+ delimiters are untouched.
 * @param md - Card markdown to pad.
 * @returns The markdown with glued bold delimiters space-separated.
 */
export function padBoldDelimiters(md: string): string {
  const boldPairRe = /(?<!\*)\*\*([^*\n]+)\*\*(?!\*)|(?<!_)__([^_\n]+)__(?!_)/g
  const padLine = (line: string): string => {
    // Mask inline code spans so their content is never padded.
    const masks: string[] = []
    const masked = line.replaceAll(/`[^`]*`/g, (m) => {
      masks.push(m)
      return `\u0000${masks.length - 1}\u0000`
    })
    let out = ''
    let last = 0
    for (const m of masked.matchAll(boldPairRe)) {
      const s = m.index
      const e = s + m[0].length
      out += masked.slice(last, s)
      let seg = m[0]
      const prev = s > 0 ? masked.charAt(s - 1) : ''
      if (prev !== '' && !/\s/.test(prev)) seg = ` ${seg}`
      const next = e < masked.length ? masked.charAt(e) : ''
      if (next !== '' && !/\s/.test(next)) seg = `${seg} `
      out += seg
      last = e
    }
    out += masked.slice(last)
    return out.replaceAll(/\u0000(\d+)\u0000/g, (_, i) => masks[Number(i)] ?? '')
  }
  const lines = md.split('\n')
  const fence = new FenceTracker()
  return lines
    .map(line => fence.update(line.trim()) ? line : padLine(line))
    .join('\n')
}

/**
 * The full cleaning pipeline expected by a schema 2.0 {tag:"markdown"}
 * element: bold padding → HTML strip → URL sanitize → line-break
 * normalization (preprocess last). Use everywhere card markdown content is
 * assembled.
 * @param md - Raw card markdown.
 * @returns The markdown ready for a schema 2.0 markdown element.
 */
export function finalizeFeishuCardMarkdown(md: string): string {
  return preprocessFeishuMarkdown(sanitizeMarkdownURLs(sanitizeFeishuMarkdownHTML(padBoldDelimiters(md))))
}

/**
 * Build a Feishu post message body using the md tag (normal chat font).
 * @param content - Markdown body text.
 * @returns The serialized post message JSON.
 */
export function buildPostMdJSON(content: string): string {
  content = sanitizeMarkdownURLs(content)
  const post = {
    zh_cn: {
      content: [[{ tag: 'md', text: content }]],
    },
  }
  return JSON.stringify(post)
}

/** One parsed Feishu post inline element (Go map[string]any). */
export interface PostInlineElement {
  tag: string
  text: string
  href?: string
  style?: string[]
}

interface MarkerDef {
  pattern: string
  tag: string
  style: string
}

const inlineMarkers: MarkerDef[] = [
  { pattern: '**', tag: 'text', style: 'bold' },
  { pattern: '~~', tag: 'text', style: 'lineThrough' },
  { pattern: '`', tag: 'text', style: 'code' },
  { pattern: '*', tag: 'text', style: 'italic' },
]

/**
 * Parse a single markdown line into Feishu post elements: **bold**, `code`,
 * ~~strike~~, *italic*, and [text](http url) links.
 * @param line - A single markdown line.
 * @returns The parsed inline elements.
 */
export function parseInlineMarkdown(line: string): PostInlineElement[] {
  const elements: PostInlineElement[] = []
  let remaining = line

  while (remaining.length > 0) {
    // Check for link [text](url)
    const linkIdx = remaining.indexOf('[')
    if (linkIdx >= 0) {
      let parenClose = -1
      const bracketCloseRel = remaining.indexOf('](', linkIdx)
      if (bracketCloseRel >= 0) {
        const bracketClose = bracketCloseRel
        const parenRel = remaining.indexOf(')', bracketClose + 2)
        if (parenRel >= 0) parenClose = parenRel
        else parenClose = -1
        if (parenClose >= 0) {
          // Check if any marker comes before this link
          const foundEarlierMarker = inlineMarkers.some((m) => {
            const idx = remaining.indexOf(m.pattern)
            return idx >= 0 && idx < linkIdx
          })
          if (!foundEarlierMarker) {
            const linkText = remaining.slice(linkIdx + 1, bracketClose)
            const linkURL = remaining.slice(bracketClose + 2, parenClose)
            if (isValidFeishuHref(linkURL)) {
              if (linkIdx > 0) {
                elements.push({ tag: 'text', text: remaining.slice(0, linkIdx) })
              }
              elements.push({ tag: 'a', text: linkText, href: linkURL })
              remaining = remaining.slice(parenClose + 1)
              continue
            }
          }
        }
      }
    }

    // Find the earliest formatting marker
    let bestIdx = -1
    let bestMarker: MarkerDef | undefined
    for (const m of inlineMarkers) {
      let idx = remaining.indexOf(m.pattern)
      if (idx < 0) continue
      // For single * marker, skip if it's actually ** (bold)
      if (m.pattern === '*' && idx + 1 < remaining.length && remaining.charAt(idx + 1) === '*') {
        idx = findSingleAsterisk(remaining)
        if (idx < 0) continue
      }
      if (bestIdx < 0 || idx < bestIdx) {
        bestIdx = idx
        bestMarker = m
      }
    }

    if (bestIdx < 0 || bestMarker === undefined) {
      if (remaining !== '') {
        elements.push({ tag: 'text', text: remaining })
      }
      break
    }

    if (bestIdx > 0) {
      elements.push({ tag: 'text', text: remaining.slice(0, bestIdx) })
    }
    remaining = remaining.slice(bestIdx + bestMarker.pattern.length)

    let closeIdx = remaining.indexOf(bestMarker.pattern)
    // For single *, make sure we don't match ** as close
    if (bestMarker.pattern === '*') {
      closeIdx = findSingleAsterisk(remaining)
    }
    if (closeIdx < 0) {
      elements.push({ tag: 'text', text: bestMarker.pattern + remaining })
      remaining = ''
      break
    }

    const inner = remaining.slice(0, closeIdx)
    remaining = remaining.slice(closeIdx + bestMarker.pattern.length)

    elements.push({ tag: bestMarker.tag, text: inner, style: [bestMarker.style] })
  }

  return elements
}

/** Index of a single '*' not part of '**' in s, or -1. */
function findSingleAsterisk(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) === '*') {
      if (i + 1 < s.length && s.charAt(i + 1) === '*') {
        i++ // skip **
        continue
      }
      return i
    }
  }
  return -1
}
