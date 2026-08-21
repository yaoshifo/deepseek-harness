/**
 * Markdown to plain-text stripping, ported from cc-connect
 * core/markdown/markdown.go.
 *
 * @module dsh-feishu-bridge/markdown
 */

// (?s) inline flags in the Go source become JS regex flags (`s`, `m`).
const reCodeBlock = /```[a-zA-Z]*\n?([\s\S]*?)```/g
const reInlineCode = /`([^`]+)`/g
const reBoldAst = /\*\*(.+?)\*\*/g
const reBoldUnd = /__(.+?)__/g
const reItalicAst = /\*(.+?)\*/g
const reItalicUnd = /_(.+?)_/g
const reStrike = /~~(.+?)~~/g
const reLink = /\[([^\]]+)\]\(([^)]+)\)/g
const reHeading = /^#{1,6}\s+/gm
const reHorizontal = /^---+\s*$/gm
const reBlockquote = /^>\s?/gm
const reBlankRuns = /\n{3,}/g

/**
 * Convert Markdown-formatted text to clean plain text. Useful for platforms
 * that don't support Markdown rendering (WeChat, LINE, etc.). Code content is
 * preserved; fences and formatting markers are removed.
 * @param s - Markdown source text.
 * @returns Trimmed plain text.
 */
export function stripMarkdown(s: string): string {
  // Preserve code block content but remove fences
  s = s.replace(reCodeBlock, '$1')

  // Inline code — remove backticks
  s = s.replace(reInlineCode, '$1')

  // Bold / italic / strikethrough — keep text
  s = s.replace(reBoldAst, '$1')
  s = s.replace(reBoldUnd, '$1')
  s = s.replace(reItalicAst, '$1')
  s = s.replace(reItalicUnd, '$1')
  s = s.replace(reStrike, '$1')

  // Links [text](url) → text (url)
  s = s.replace(reLink, '$1 ($2)')

  // Headings — remove # prefix
  s = s.replace(reHeading, '')

  // Horizontal rules
  s = s.replace(reHorizontal, '')

  // Blockquotes
  s = s.replace(reBlockquote, '')

  // Collapse 3+ consecutive blank lines into 2
  s = s.replace(reBlankRuns, '\n\n')

  return s.trim()
}
