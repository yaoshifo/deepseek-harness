/**
 * Pure protocol translation for the local host: what the server's capabilities allow, and how its
 * `Location`/`LocationLink`/`Hover`/`workspace/symbol` payloads normalize into the seam's result
 * types. No I/O or process state — every function here is a pure transform, which the fake-stdio
 * tests pin exactly.
 * @module @deepseek-ai/dsh-lsp-stdio/translate
 */

import type {
  LspHover,
  LspLocation,
  LspOperation,
  LspRange,
  LspSymbol,
} from '@deepseek-ai/dsh-lsp'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  WireHover,
  WireLocation,
  WireLocationLink,
  WireMarkedString,
  WireProviderCapability,
  WireRange,
  WireServerCapabilities,
  WireTextDocumentSyncKind,
} from './protocol.ts'

/**
 * The `textDocument/*` request method for each LSP operation.
 * @param operation - the LSP operation to map.
 * @returns the LSP request method name.
 */
export function requestMethod(operation: LspOperation): string {
  switch (operation) {
    case 'goToDefinition': return 'textDocument/definition'
    case 'findReferences': return 'textDocument/references'
    case 'goToImplementation': return 'textDocument/implementation'
    case 'hover': return 'textDocument/hover'
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'requestMethod')
  }
}

/** The `ServerCapabilities` provider field backing each operation. */
function capabilityValue(capabilities: WireServerCapabilities, operation: LspOperation): WireProviderCapability {
  switch (operation) {
    case 'goToDefinition': return capabilities.definitionProvider
    case 'findReferences': return capabilities.referencesProvider
    case 'goToImplementation': return capabilities.implementationProvider
    case 'hover': return capabilities.hoverProvider
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'capabilityValue')
  }
}

/** A provider capability is present when the server sent `true` or an options object (not `false`/absent). */
function supportsCapability(value: WireProviderCapability): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

/**
 * Whether the server advertises the requested operation.
 * @param capabilities - the server's `initialize` capabilities.
 * @param operation - the LSP operation to check.
 * @returns true when the corresponding provider capability is present.
 */
export function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean {
  return supportsCapability(capabilityValue(capabilities, operation))
}

/**
 * Whether the server advertises `workspace/symbol`.
 * @param capabilities - the server's `initialize` capabilities.
 * @returns true when the `workspaceSymbolProvider` capability is present.
 */
export function supportsWorkspaceSymbol(capabilities: WireServerCapabilities): boolean {
  return supportsCapability(capabilities.workspaceSymbolProvider)
}

/**
 * Whether a `textDocumentSync` value permits the transient `didOpen`/`didClose` this host relies on.
 * The legacy enum form implies open/close for `Full`/`Incremental`; the options form requires an
 * explicit `openClose: true`, because the protocol defaults an omitted `openClose` to false.
 * @param sync - the server's advertised `textDocumentSync` capability.
 * @returns true when transient open/close is supported.
 */
export function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true
}

/** Legacy enum: `Full` (1) or `Incremental` (2) imply open/close support; `None` (0) does not. */
function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

/**
 * Normalize the negotiated position encoding. An omitted encoding defaults to `utf-16`; any value
 * other than `utf-16` is a protocol error this host does not support.
 * @param encoding - the server's advertised `positionEncoding`, if any.
 * @returns the string `'utf-16'`.
 * @throws Error for any non-`utf-16` encoding.
 */
export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

/** Convert a wire range to the seam's range (structurally identical, but re-shaped as `readonly`). */
function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/** Whether a record is a `LocationLink` (has `targetUri` + `targetSelectionRange`). */
function isLocationLink(value: Record<string, unknown>): boolean {
  return typeof value.targetUri === 'string' && isRange(value.targetSelectionRange)
}

/** Whether a record is a `Location` (has string `uri` + a range). */
function isLocation(value: Record<string, unknown>): boolean {
  return typeof value.uri === 'string' && isRange(value.range)
}

/** Structural range guard used by both location shapes. */
function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return isPosition(range.start) && isPosition(range.end)
}

/** Structural position guard. */
function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return isProtocolCoordinate(position.line) && isProtocolCoordinate(position.character)
}

/** Whether a wire coordinate is a valid nonnegative integer. */
function isProtocolCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Normalize a navigation result (`Location`, `Location[]`, `LocationLink[]`, or `null`) to the seam's
 * locations. `Location` maps directly; `LocationLink` maps `targetUri` + `targetSelectionRange`.
 * @param payload - the raw `textDocument/definition|references|implementation` result.
 * @returns the normalized locations (empty for `null`/`[]`).
 * @throws Error when an element is neither a `Location` nor a `LocationLink`.
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP navigation result was missing')
  const elements = Array.isArray(payload) ? payload : [payload]
  const locations: LspLocation[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP navigation result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (isLocationLink(record)) {
      const link = record as unknown as WireLocationLink
      locations.push({ uri: link.targetUri, range: toRange(link.targetSelectionRange) })
    } else if (isLocation(record)) {
      const location = record as unknown as WireLocation
      locations.push({ uri: location.uri, range: toRange(location.range) })
    } else {
      throw malformedResponse('LSP navigation result contained neither a Location nor a LocationLink')
    }
  }
  return locations
}

/** Render one `MarkedString` (string form verbatim; object form as a language-tagged fenced block). */
function renderMarkedString(value: WireMarkedString): string {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * The `SymbolKind` names for the protocol's numeric values 1–26, indexed by `kind - 1`.
 */
const SYMBOL_KIND_NAMES: readonly string[] = [
  'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor',
  'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array',
  'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter',
]

/**
 * Name one numeric `SymbolKind`. Values outside the current protocol range render as
 * `symbol kind N` so a newer server's kinds stay visible instead of failing the whole result.
 * @param kind - the wire `SymbolKind` number.
 * @returns the kind name.
 */
export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind - 1] ?? `symbol kind ${kind}`
}

/**
 * Normalize a `workspace/symbol` result (`SymbolInformation[]`/`WorkspaceSymbol[]`, or `null`) to
 * the seam's symbols. An unresolved `WorkspaceSymbol` (its `location` is the empty-uri marker)
 * keeps the entry with `location: null`.
 * @param payload - the raw `workspace/symbol` result.
 * @returns the normalized symbols (empty for `null`/`[]`).
 * @throws Error when the payload is not an array or an entry lacks a name, a numeric kind, or a
 *   structurally valid location.
 */
export function normalizeSymbols(payload: unknown): LspSymbol[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP symbol result was missing')
  if (!Array.isArray(payload)) throw malformedResponse('LSP symbol result was not an array')
  const symbols: LspSymbol[] = []
  for (const element of payload) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP symbol result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.kind !== 'number') {
      throw malformedResponse('LSP symbol result contained an entry without a name or kind')
    }
    symbols.push({
      name: record.name,
      kind: symbolKindName(record.kind),
      location: normalizeSymbolLocation(record.location),
      ...typeof record.containerName === 'string' ? { containerName: record.containerName } : {},
    })
  }
  return symbols
}

/**
 * Normalize one symbol entry's location: a full `Location` maps its range, the unresolved marker
 * `{ uri: '' }` (or an absent location) becomes `null`, and anything else is malformed.
 * @param location - the untrusted wire location.
 * @returns the normalized location, or `null` for the unresolved marker.
 */
function normalizeSymbolLocation(location: unknown): LspSymbol['location'] {
  if (location === undefined) return null
  if (location === null || typeof location !== 'object') {
    throw malformedResponse('LSP symbol entry contained a malformed location')
  }
  const record = location as Record<string, unknown>
  if (record.uri === '') return null
  if (!isLocation(record)) {
    throw malformedResponse('LSP symbol entry contained a malformed location')
  }
  const resolved = record as unknown as WireLocation
  return { uri: resolved.uri, range: toRange(resolved.range) }
}

/**
 * Normalize a `Hover` (or `null`) to the seam's hover. `MarkupContent` uses its `value`; a string
 * `MarkedString` is verbatim; a language-tagged `MarkedString` becomes a fenced code block; an array
 * joins its rendered parts with one blank line. The model-facing tool owns the complete result cap.
 * @param payload - the raw `textDocument/hover` result.
 * @returns the normalized hover, or `null` when there is no content.
 * @throws Error when the payload is a non-null, non-object, or structurally invalid hover.
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null) return null
  if (payload === undefined) throw malformedResponse('LSP hover result was missing')
  if (typeof payload !== 'object') throw malformedResponse('LSP hover result was not an object')
  const hover = payload as unknown as WireHover
  const contents = renderHoverContents(hover.contents)
  if (contents === '') return null
  const range = hover.range
  if (range === undefined) return { contents }
  if (!isRange(range)) throw malformedResponse('LSP hover result contained a malformed range')
  return { contents, range: toRange(range) }
}

/** Render the three `Hover.contents` encodings into one string (input is untrusted wire data). */
function renderHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) {
    throw malformedResponse('LSP hover result had no contents')
  }
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((value) => {
      if (isMarkedString(value)) return renderMarkedString(value)
      throw malformedResponse('LSP hover contents contained a malformed MarkedString')
    }).join('\n\n')
  }
  if (typeof contents !== 'object') {
    throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
  }
  const record = contents as Record<string, unknown>
  if (record.kind === 'markdown' || record.kind === 'plaintext') {
    if (typeof record.value !== 'string') {
      throw malformedResponse('LSP hover MarkupContent value was not a string')
    }
    return record.value
  }
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    return renderMarkedString({ language: record.language, value: record.value })
  }
  throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
}

/** Whether an untrusted value is either form of `MarkedString`. */
function isMarkedString(value: unknown): value is WireMarkedString {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.language === 'string' && typeof record.value === 'string'
}

/** Create the stable structured error used for malformed server result payloads. */
function malformedResponse(message: string): LspError {
  return new LspError(message, 'LSP_MALFORMED_RESPONSE')
}
