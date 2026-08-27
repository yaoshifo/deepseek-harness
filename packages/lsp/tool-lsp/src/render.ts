/**
 * Pure formatting and coordinate conversion for the `lsp` tool: one-based↔zero-based UTF-16 cursor
 * conversion, workspace-grouped location and symbol rendering with `file:`-URI resolution,
 * complete-result capping, and UI presentation. No I/O — a UI may call the presenter on live
 * streaming and on replay, so it depends only on the tool arguments.
 * @module @deepseek-ai/dsh-tool-lsp/render
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { LspHover, LspLocation, LspOperation, LspPosition, LspSymbol } from '@deepseek-ai/dsh-lsp'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The four position operations the seam exposes, as a runtime tuple for validation. */
export const LSP_OPERATIONS: readonly LspOperation[] = ['goToDefinition', 'findReferences', 'goToImplementation', 'hover']

/**
 * The operations the tool exposes: the name-based `workspaceSymbol` plus the seam's four position
 * operations, as a runtime tuple for the schema enum + validation.
 */
export const LSP_TOOL_OPERATIONS: readonly LspToolOperation[] = ['workspaceSymbol', ...LSP_OPERATIONS]

/** An operation the `lsp` tool accepts: name-based symbol lookup or one of the seam's position operations. */
export type LspToolOperation = LspOperation | 'workspaceSymbol'

/** Default cap on rendered locations before an omission marker is appended. */
export const DEFAULT_MAX_LOCATIONS = 100

/** Default cap on the complete rendered tool result, including truncation metadata. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** Validated `lsp` arguments for a name-based symbol lookup. */
export interface LspSymbolToolInput {
  readonly operation: 'workspaceSymbol'
  readonly query: string
  /** A project file to open transiently for servers that index symbols only per loaded project. */
  readonly seedFilePath?: string
}

/** Validated `lsp` arguments for a position operation, after coordinate checks. */
export interface LspPositionToolInput {
  readonly operation: LspOperation
  readonly filePath: string
  /** Zero-based UTF-16 position converted from the one-based model coordinates. */
  readonly position: LspPosition
}

/** Validated `lsp` arguments after operation-specific checks. */
export type LspToolInput = LspSymbolToolInput | LspPositionToolInput

/**
 * The raw, schema-typed argument shape. `file_path`/`line`/`character` are required only for the
 * position operations; `query` only for `workspaceSymbol`.
 */
export interface LspToolArgs {
  readonly operation: string
  readonly file_path?: string
  readonly line?: number
  readonly character?: number
  readonly query?: string
}

/**
 * Validate and convert model arguments per operation: `workspaceSymbol` requires a non-empty
 * `query`; every other operation requires `file_path` plus `line`/`character` as positive one-based
 * integers converted to the seam's zero-based position.
 * @param args - the schema-validated raw arguments.
 * @returns the validated input for its operation.
 * @throws Error when the operation is unknown, `query` is empty, `file_path` is missing, or a
 *   coordinate is not a positive integer.
 */
export function parseLspArgs(args: LspToolArgs): LspToolInput {
  if (args.operation === 'workspaceSymbol') {
    if (args.query === undefined || args.query.trim().length === 0) {
      throw new Error('query must be a non-empty string for workspaceSymbol')
    }
    const seedFilePath = args.file_path !== undefined && args.file_path.trim().length > 0 ? args.file_path : undefined
    return {
      operation: 'workspaceSymbol',
      query: args.query,
      ...seedFilePath === undefined ? {} : { seedFilePath },
    }
  }
  if (!isOperation(args.operation)) {
    throw new Error(`operation must be one of ${LSP_TOOL_OPERATIONS.join(', ')}`)
  }
  if (args.file_path === undefined || args.file_path.trim().length === 0) {
    throw new Error('file_path must be a non-empty string')
  }
  const line = oneBased(args.line, 'line')
  const character = oneBased(args.character, 'character')
  return {
    operation: args.operation,
    filePath: args.file_path,
    // The model counts from 1; the seam (and protocol) count from 0.
    position: { line: line - 1, character: character - 1 },
  }
}

/** Whether a string is one of the four position operations. */
function isOperation(value: string): value is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(value)
}

/** Validate a one-based coordinate is a positive integer. */
function oneBased(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (one-based)`)
  }
  return value
}

/**
 * Render a locations result grouped by file, converting each zero-based location back to a one-based
 * `path:line:character` entry. A `file:` URI inside the workspace becomes a workspace-relative path;
 * outside it, a URI-derived absolute path; a non-`file:` URI is kept verbatim. Applies `maxLocations` and
 * appends an omission marker when it truncates by count, then applies the complete result cap.
 * @param locations - the seam's locations (possibly empty).
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @param maxLocations - the cap before truncation.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered text; a distinct no-result line when there are none.
 */
export function formatLocations(
  locations: readonly LspLocation[],
  workspaceUri: string,
  maxLocations: number,
  maxResultChars: number,
): string {
  if (locations.length === 0) return boundResult('No results.', maxResultChars, 'locations')
  const shown = locations.slice(0, maxLocations)
  const omitted = locations.length - shown.length
  const grouped = new Map<string, string[]>()
  for (const location of shown) {
    const path = renderUri(location.uri, workspaceUri)
    const line = location.range.start.line + 1
    const character = location.range.start.character + 1
    const entries = grouped.get(path) ?? []
    entries.push(`${path}:${line}:${character}`)
    grouped.set(path, entries)
  }
  const lines: string[] = []
  for (const entries of grouped.values()) lines.push(...entries)
  if (omitted > 0) {
    lines.push(`… ${omitted} more location${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'locations')
}

/**
 * Render a hover result, applying `maxResultChars` last and keeping its marker within the cap.
 * @param hover - the normalized hover, or `null` for no hover.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered hover text; a distinct no-result line for `null`.
 */
export function formatHover(hover: LspHover | null, maxResultChars: number): string {
  const text = hover === null ? 'No hover information.' : hover.contents
  return boundResult(text, maxResultChars, 'hover')
}

/** One provider group of the merged symbol result, as the tool output schema shapes it. */
export interface LspSymbolGroupInput {
  /** The provider's matched symbols, in its server's relevance order. */
  readonly symbols: readonly LspSymbol[]
  /** The provider's canonical workspace `file:` URI. */
  readonly resolvedWorkspaceUri: string
}

/**
 * Render a merged workspace-symbol result: one `name (kind) in container — path:line:character`
 * line per symbol, in each provider's relevance order. A symbol without a resolved location loses
 * the position suffix instead of the entry. Paths resolve through the group's own workspace URI,
 * exactly like {@link formatLocations}. Applies `maxLocations` across all groups and appends an
 * omission marker when it truncates by count, then applies the complete result cap.
 * @param groups - the seam's per-provider symbol groups (possibly empty symbols).
 * @param maxLocations - the cap before truncation.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered text; a distinct no-result line when every group is empty.
 */
export function formatSymbols(
  groups: readonly LspSymbolGroupInput[],
  maxLocations: number,
  maxResultChars: number,
): string {
  const total = groups.reduce((count, group) => count + group.symbols.length, 0)
  if (total === 0) return boundResult('No symbols found.', maxResultChars, 'symbols')
  let shown = 0
  const lines: string[] = []
  for (const group of groups) {
    for (const symbol of group.symbols) {
      if (shown >= maxLocations) break
      shown++
      lines.push(renderSymbolLine(symbol, group.resolvedWorkspaceUri))
    }
    if (shown >= maxLocations) break
  }
  const omitted = total - shown
  if (omitted > 0) {
    lines.push(`… ${omitted} more symbol${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'symbols')
}

/**
 * Render one symbol line: `name (kind) in container — path:line:character`, with one-based
 * coordinates the position operations accept verbatim.
 * @param symbol - the normalized symbol.
 * @param workspaceUri - the contributing provider's canonical workspace `file:` URI.
 * @returns the rendered line.
 */
function renderSymbolLine(symbol: LspSymbol, workspaceUri: string): string {
  const head = symbol.containerName === undefined
    ? `${symbol.name} (${symbol.kind})`
    : `${symbol.name} (${symbol.kind}) in ${symbol.containerName}`
  if (symbol.location === null) return `${head} — no location`
  const path = renderUri(symbol.location.uri, workspaceUri)
  const line = symbol.location.range.start.line + 1
  const character = symbol.location.range.start.character + 1
  return `${head} — ${path}:${line}:${character}`
}

/** Bound a complete rendered result, including the truncation notice itself. */
function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * Resolve a location URI without applying the harness host's path rules. A valid `file:` URI becomes
 * workspace-relative when it is under the provider's canonical workspace URI, or a URI-derived
 * absolute path otherwise; malformed and non-`file:` URIs remain verbatim.
 * @param uri - the target URI from the seam.
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @returns the display path or the verbatim URI.
 */
export function renderUri(uri: string, workspaceUri: string): string {
  if (!uri.startsWith('file:')) return uri
  let target: URL
  let workspace: URL
  try {
    target = new URL(uri)
    workspace = new URL(workspaceUri)
  } catch {
    return uri
  }
  if (workspace.protocol !== 'file:') return uri
  // A `file:` URI does not carry its world's OS, so a leading `/X:` segment is
  // read as a Windows drive. A POSIX workspace literally rooted at `/c:/...`
  // would mis-render (display only; edits and reads use the exact URI).
  const drivePath = /^\/[a-z](?::|%3A)/iu
  const windowsWorld = workspace.hostname.length > 0 || drivePath.test(workspace.pathname)
  const targetWindowsWorld = windowsWorld && (target.hostname.length > 0 || drivePath.test(target.pathname))
  const workspacePath = filePath(workspace, windowsWorld)
  const targetPath = filePath(target, targetWindowsWorld)
  if (workspacePath === undefined || targetPath === undefined) return uri
  if (windowsWorld !== targetWindowsWorld) return targetPath
  const path = windowsWorld ? win32 : posix
  const relative = path.relative(workspacePath, targetPath)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  const rendered = relative === '' ? '.' : outside ? targetPath : relative
  return windowsWorld ? rendered.replaceAll('\\', '/') : rendered
}

/** Decode a file URL for its execution world while containing malformed URL failures. */
function filePath(url: URL, windows: boolean): string | undefined {
  try {
    const path = fileURLToPath(url, { windows })
    return path.includes('\0') ? undefined : path
  } catch {
    // `fileURLToPath` rejects malformed escapes, authorities, and encoded path separators.
    return undefined
  }
}

/**
 * UI presentation for a pending `lsp` call. Uses a generic search card; a position operation's
 * title carries the one-based cursor and `locations` focuses the queried line (the shared location
 * shape has no character, so the title preserves the column). A `workspaceSymbol` call has no
 * cursor, so its title carries the quoted query.
 * @param args - the raw tool arguments.
 * @returns the generic call view.
 */
export function presentLspCall(args: LspToolArgs): GenericCallView {
  if (args.operation === 'workspaceSymbol') {
    return {
      card: 'generic',
      kind: 'search',
      title: `LSP workspaceSymbol "${args.query ?? ''}"`,
    }
  }
  return {
    card: 'generic',
    kind: 'search',
    title: `LSP ${args.operation} ${args.file_path ?? ''}:${args.line ?? ''}:${args.character ?? ''}`,
    // A well-formed position call always carries file_path and line; a malformed one still renders
    // its title without fabricating a location.
    ...(args.file_path !== undefined && args.line !== undefined
      ? { locations: [{ path: args.file_path, line: args.line }] }
      : {}),
  }
}
