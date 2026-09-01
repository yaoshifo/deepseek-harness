/**
 * `@path` import parsing and recursive expansion for workspace instruction files.
 *
 * @module @deepseek-ai/dsh-agent-instructions/imports
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

/**
 * Maximum recursive import depth in file hops, matching Claude Code memory-file
 * imports (external spec parity; deliberately not configurable).
 */
export const MAX_IMPORT_HOPS = 4

/** One `@path` reference located in instruction content. */
export interface InstructionImportReference {
  /** Path exactly as written, without the leading `@`. */
  path: string
  /** Content offset of the leading `@`. */
  start: number
  /** Content offset just past the reference token. */
  end: number
}

/**
 * Reads one candidate import file under the configured source byte cap.
 * Returning `undefined` reports the file as unavailable.
 */
export type InstructionImportReader = (absolutePath: string) => Promise<string | undefined>

/** Instruction content after expansion plus the files that contributed to it. */
export interface ExpandedInstructionContent {
  content: string
  /** Absolute paths of every imported file whose content the expansion inlined. */
  imports: string[]
}

interface ExpandOptions {
  homeDir?: string
}

/** Characters stripped from the end of a reference token so sentence punctuation stays literal. */
const TRAILING_PUNCTUATION = /[.,;:!?)"'’]+$/

/** Single-line replacement for a reference whose file could not be loaded. */
function unavailableMarker(path: string): string {
  return `[instruction import unavailable: ${path}]`
}

/** Labeled frame replacing one reference token with the imported file's content. */
function importFrame(path: string, content: string): string {
  return `Imported from: ${path}\n${content}\nEnd imported from: ${path}`
}

/**
 * Locate `@path` references in one line outside inline code spans. Spans pair
 * backticks within the line only; an unpaired backtick never suppresses
 * references on later lines.
 */
function parseLineReferences(line: string, lineOffset: number, references: InstructionImportReference[]): void {
  let inCodeSpan = false
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char === '`') {
      inCodeSpan = !inCodeSpan
      index += 1
      continue
    }
    const atReferenceStart = char === '@' && !inCodeSpan && (index === 0 || /\s/.test(line[index - 1] ?? ''))
    if (!atReferenceStart) {
      index += 1
      continue
    }
    const tokenEnd = findTokenEnd(line, index + 1)
    const token = line.slice(index + 1, tokenEnd)
    const path = token.replace(TRAILING_PUNCTUATION, '')
    if (path.length > 0) {
      references.push({
        path,
        start: lineOffset + index,
        end: lineOffset + index + 1 + path.length,
      })
    }
    index = tokenEnd
  }
}

/** Offset just past the run of non-space, non-backtick characters starting at `index`. */
function findTokenEnd(line: string, index: number): number {
  let end = index
  while (end < line.length && !/\s/.test(line[end] ?? '') && line[end] !== '`') end += 1
  return end
}

/** Opening fence marker of a fenced code block: three or more backticks or tildes. */
const FENCE_OPEN_RE = /^(`{3,}|~{3,})/

/**
 * Locate every `@path` import reference in instruction content, skipping inline
 * code spans and fenced code blocks.
 * @param content - raw instruction file text.
 * @returns references in document order with `@`-prefixed token offsets.
 */
export function parseImportReferences(content: string): InstructionImportReference[] {
  if (!content.includes('@')) return []
  const references: InstructionImportReference[] = []
  let lineOffset = 0
  let fence: string | undefined
  for (const line of content.split('\n')) {
    // A fence opens with ``` or ~~~ and closes only on a longer or equal run of
    // the same character; its info string and body never contain references.
    const opensFence = fence === undefined ? FENCE_OPEN_RE.exec(line) : null
    if (opensFence !== null) {
      fence = opensFence[1]?.[0]
    } else if (fence !== undefined && line.trimStart().startsWith(fence.repeat(3))) {
      fence = undefined
    } else if (fence === undefined) {
      parseLineReferences(line, lineOffset, references)
    }
    lineOffset += line.length + 1
  }
  return references
}

/**
 * Resolve one written import path against the file that references it.
 * @param path - path as written after the `@`.
 * @param originDir - absolute directory of the referencing file.
 * @param homeDir - home directory for `~`-prefixed paths.
 * @returns the absolute import path.
 */
export function resolveImportPath(path: string, originDir: string, homeDir: string): string {
  if (path.startsWith('~/')) return resolve(homeDir, path.slice(2))
  if (isAbsolute(path)) return resolve(path)
  return resolve(originDir, path)
}

async function expandContent(
  content: string,
  originDir: string,
  read: InstructionImportReader,
  options: Required<ExpandOptions>,
  imports: string[],
  depth: number,
): Promise<string> {
  const references = parseImportReferences(content)
  let expanded = ''
  let cursor = 0
  for (const reference of references) {
    expanded += content.slice(cursor, reference.start)
    cursor = reference.end
    const absolutePath = resolveImportPath(reference.path, originDir, options.homeDir)
    // The hop budget is spent before reading: a file at the maximum depth keeps
    // its own references as literal unavailable markers instead of recursing.
    const imported = depth < MAX_IMPORT_HOPS ? await read(absolutePath) : undefined
    if (imported === undefined) {
      expanded += unavailableMarker(reference.path)
      continue
    }
    imports.push(absolutePath)
    const nested = await expandContent(imported, dirname(absolutePath), read, options, imports, depth + 1)
    expanded += importFrame(reference.path, nested)
  }
  return expanded + content.slice(cursor)
}

/**
 * Expand every `@path` reference in instruction content, inlining each imported
 * file at its reference site and recursively expanding nested references.
 * @param content - raw instruction file text.
 * @param originDir - absolute directory of the file owning `content`.
 * @param read - bounded reader for imported files.
 * @param options - home directory overriding the operating-system default.
 * @returns expanded content and the absolute paths of every inlined file.
 */
export async function expandInstructionImports(
  content: string,
  originDir: string,
  read: InstructionImportReader,
  options: ExpandOptions = {},
): Promise<ExpandedInstructionContent> {
  const imports: string[] = []
  const resolved: Required<ExpandOptions> = { homeDir: options.homeDir ?? homedir() }
  const expanded = await expandContent(content, originDir, read, resolved, imports, 0)
  return { content: expanded, imports }
}
