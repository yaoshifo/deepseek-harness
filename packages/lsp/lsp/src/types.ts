/**
 * LSP seam vocabulary: the normalized request, provider, and result contracts. Types only — the
 * {@link LspError} taxonomy and the {@link LspProviderId} brand factory are runtime and live in
 * `index.ts`. Positions and ranges are zero-based UTF-16, matching the protocol; the model-facing
 * tool owns the one-based cursor convention. The seam exposes no protocol types, process or document
 * controls, or generic JSON-RPC escape hatch — only the four semantic operations and the name-based
 * workspace symbol lookup.
 * @module @deepseek-ai/dsh-lsp/types
 */

import type { LspProviderId } from './brand.ts'

/**
 * The four semantic queries the seam and model expose. A closed union: adding an operation is a
 * compile-enforced change across the seam, providers, and the tool. Symbols and call hierarchy are
 * not operations here; they need different schemas.
 */
export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'

/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
export interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}

/** A zero-based UTF-16 half-open range `[start, end)`. */
export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/**
 * A caller's normalized query. Every field is required: `workspaceRoot` is caller-supplied,
 * `languageId` comes from the provider registration (not here), and consumers own timeouts and
 * result limits — so no field needs implementation defaulting and there is no `resolve()` step.
 */
export interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
}

/**
 * A request as a provider receives it: the caller's {@link LspQueryRequest} plus the `languageId`
 * the seam derived from the provider's extension mapping. The language id only synchronizes the
 * transient document; it does not participate in selection.
 */
export interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}

/** One resolved location: a document URI and the range within it. */
export interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}

/** Normalized hover content, or `null` for no hover at the position. */
export interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}

/**
 * The closed result union. Navigation operations (`goToDefinition`, `findReferences`,
 * `goToImplementation`) normalize to `locations`; `hover` normalizes to content or `null`.
 * Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled.
 *
 * The `locations` variant carries `resolvedWorkspaceUri`: the provider's canonical `file:` URI for
 * the request's workspace root. A caller that relativizes location URIs MUST use this, not parse the
 * request's possibly symlinked process path with host-platform rules; the execution platform may
 * differ from the caller's.
 */
export type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }

/**
 * A workspace-wide symbol lookup by name. No file or cursor: the provider's server matches `query`
 * against the symbols it indexes for the workspace, so this is the seam's name-based entry point
 * alongside the four position operations.
 */
export interface LspSymbolRequest {
  /** The partial symbol name to match; matching semantics belong to the server. */
  readonly query: string
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
  /**
   * A workspace file to open transiently for servers that index symbols only per loaded project
   * (tsserver's navto answers `No Project` without an open document). Omitted when the caller has
   * no file; the provider may also seed from the last document it opened.
   */
  readonly seedFilePath?: string
}

/**
 * One resolved workspace symbol. `kind` is the symbol kind name (e.g. `'function'`, `'class'`);
 * providers map the protocol's numeric kinds. `location` is `null` when the server returned an
 * unresolved `WorkspaceSymbol` (its `location` carries only the empty-uri marker).
 */
export interface LspSymbol {
  /** The symbol's declared name. */
  readonly name: string
  /** The symbol kind name (e.g. `'function'`, `'class'`, `'variable'`). */
  readonly kind: string
  /** The enclosing symbol's name, when the server reported one. */
  readonly containerName?: string
  /** The declaration location, or `null` for an unresolved `WorkspaceSymbol`. */
  readonly location: LspLocation | null
}

/**
 * One provider's contribution to a workspace symbol lookup, in the provider's own relevance
 * order. Carries `resolvedWorkspaceUri` with the same rendering obligation as the `locations`
 * variant of {@link LspQueryResult}.
 */
export interface LspSymbolResult {
  /** The matched symbols, in the server's relevance order. */
  readonly symbols: readonly LspSymbol[]
  /** The provider's canonical `file:` URI for the request's workspace root. */
  readonly resolvedWorkspaceUri: string
}

/**
 * A language-server backend registered on `ctx.lsp`. Each provider owns a stable {@link
 * LspProviderId} and an extension-to-language-id map (lowercase, leading-dot keys).
 * `findReferences` always includes declarations — the provider enforces this internally; callers
 * get no flag.
 */
export interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The seam has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query (caller request + derived language id).
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
  /**
   * Run one workspace-wide symbol lookup. Unlike `query` no document is synchronized, so the
   * request carries no file or position.
   * @param request - the name-based symbol lookup request.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns this provider's matched symbols with its canonical workspace URI.
   */
  symbol(request: LspSymbolRequest, signal?: AbortSignal): Promise<LspSymbolResult>
}

/**
 * The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query
 * execution; exposes exactly the four position operations plus the name-based workspace symbol
 * lookup, and no protocol escape hatch.
 */
export interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict
   * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
   * reservations. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's extension and run one query. Selection is per-query and
   * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
  /**
   * Fan out one name-based symbol lookup to every registered provider and merge their groups in
   * registration order — a symbol query has no file extension to route on. A provider whose server
   * lacks the `workspaceSymbolProvider` capability contributes nothing; if every provider lacks it,
   * throws `LspError` `LSP_UNSUPPORTED_OPERATION`. No provider registered throws `LSP_UNAVAILABLE`.
   * @param request - the name-based symbol lookup request.
   * @param signal - optional cancellation forwarded to every provider.
   * @returns each supporting provider's symbols and canonical workspace URI, in registration order.
   */
  symbol(request: LspSymbolRequest, signal?: AbortSignal): Promise<readonly LspSymbolResult[]>
}
