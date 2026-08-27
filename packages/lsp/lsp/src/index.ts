/**
 * Service Definition for the LSP capability seam (`ctx.lsp`): a language-server provider registry and per-query,
 * order-independent selection over normalized goToDefinition/findReferences/goToImplementation/
 * hover queries, plus a name-based workspace symbol lookup that routes by a seed file's
 * extension and falls back to a merged fan-out when the caller has no seed.
 *
 * A provider reserves a branded id and an exclusive set of file extensions atomically:
 * {@link Lsp.registerProvider} validates and conflict-checks everything before mutating, so an
 * invalid or conflicting registration publishes nothing, and its disposer releases every
 * reservation together. Selection routes a query by the file's final extension; it never depends on
 * registration order. The seam exposes exactly the four operations, the workspace symbol lookup,
 * and no JSON-RPC escape hatch.
 * @module @deepseek-ai/dsh-lsp
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LspProviderId } from './brand.ts'
import type {
  LspProvider,
  LspQueryRequest,
  LspQueryResult,
  LspService,
  LspSymbolProviderFailure,
  LspSymbolRequest,
  LspSymbolResult,
  LspSymbolsMerged,
} from './types.ts'

export { LspProviderId } from './brand.ts'
export type {
  LspHover,
  LspLocation,
  LspOperation,
  LspPosition,
  LspProvider,
  LspProviderQuery,
  LspQueryRequest,
  LspQueryResult,
  LspRange,
  LspService,
  LspSymbol,
  LspSymbolProviderFailure,
  LspSymbolRequest,
  LspSymbolResult,
  LspSymbolsMerged,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lsp: LspService
  }
}

/**
 * Structured LSP failure. Extends {@link HarnessError} with a stable `code`
 * (`LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`, `LSP_DISPOSED`,
 * `LSP_UNSUPPORTED_OPERATION`, `LSP_MALFORMED_RESPONSE`, …) that callers route on instead of
 * parsing `message`.
 */
export class LspError extends HarnessError {}

/**
 * Extract a file's final extension as a normalized, lowercase, leading-dot key (e.g. `Foo.TS` →
 * `.ts`, `foo.d.ts` → `.ts`). Returns `''` for a name with no extension or a leading-dot dotfile
 * (`.bashrc`), which no route ever matches. Splits on both `/` and `\` so a caller's path separator
 * does not change the result.
 * @param filePath - the source path to inspect.
 * @returns the normalized extension, or `''` when there is none.
 */
export function finalExtension(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
  const dot = base.lastIndexOf('.')
  // dot <= 0 covers both "no dot" (-1) and a leading-dot dotfile (0): neither has an extension.
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/** A well-formed normalized extension: a dot followed by one or more non-dot, non-separator chars. */
const EXTENSION_PATTERN = /^\.[^./\\]+$/

/** One selection route: the provider to run plus the language id to synchronize the document with. */
interface Route {
  readonly provider: LspProvider
  readonly languageId: string
}

/**
 * `ctx.lsp`. Holds the id reservations, the extension→route table, and the registration-ordered
 * provider list; all are populated and cleared together per provider so a route always has a live
 * provider.
 */
export class Lsp extends Service implements LspService {
  private readonly providerIds = new Set<LspProviderId>()
  private readonly routes = new Map<string, Route>()
  /** Providers in registration order; `symbol()` fans out over this list. */
  private readonly providers: LspProvider[] = []

  constructor(ctx: Context) {
    super(ctx, 'lsp')
  }

  registerProvider(provider: LspProvider): () => void {
    // Validate and conflict-check everything BEFORE any mutation: an invalid or conflicting
    // registration must publish nothing (fail-loud, all-or-nothing).
    const id = provider.id
    if (id.trim() === '') {
      throw new LspError('an LSP provider id must be a non-empty string', 'LSP_INVALID_PROVIDER')
    }
    if (this.providerIds.has(id)) {
      throw new LspError(`an LSP provider with id "${id}" is already registered`, 'LSP_CONFLICT')
    }

    const entries = Object.entries(provider.extensionToLanguage)
    if (entries.length === 0) {
      throw new LspError(`LSP provider "${id}" registers no file extensions`, 'LSP_INVALID_PROVIDER')
    }

    // Normalize into this provider's route set, catching intra-provider duplicates (e.g. `.TS` and
    // `.ts`) before checking cross-provider conflicts.
    const pending = new Map<string, Route>()
    for (const [rawExt, languageId] of entries) {
      const ext = normalizeExtension(rawExt)
      if (!EXTENSION_PATTERN.test(ext)) {
        throw new LspError(`LSP provider "${id}" maps an invalid extension "${rawExt}"`, 'LSP_INVALID_PROVIDER')
      }
      if (languageId.trim() === '') {
        throw new LspError(`LSP provider "${id}" maps extension "${ext}" to an empty language id`, 'LSP_INVALID_PROVIDER')
      }
      if (pending.has(ext)) {
        throw new LspError(`LSP provider "${id}" maps extension "${ext}" more than once`, 'LSP_INVALID_PROVIDER')
      }
      pending.set(ext, { provider, languageId })
    }
    for (const ext of pending.keys()) {
      if (this.routes.has(ext)) {
        throw new LspError(`extension "${ext}" is already handled by another LSP provider`, 'LSP_CONFLICT')
      }
    }

    // All checks passed: reserve id and every extension in one lifecycle controller so disposal
    // releases them together.
    const dispose = this.ctx.effect(function* (this: Lsp) {
      this.providerIds.add(id)
      this.providers.push(provider)
      for (const [ext, route] of pending) this.routes.set(ext, route)
      yield () => {
        this.providerIds.delete(id)
        this.providers.splice(this.providers.indexOf(provider), 1)
        for (const ext of pending.keys()) this.routes.delete(ext)
      }
    }.bind(this), 'lsp.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous
    // fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    const route = this.routes.get(finalExtension(request.filePath))
    if (route === undefined) {
      throw new LspError(`no LSP provider handles "${request.filePath}"`, 'LSP_UNAVAILABLE')
    }
    return route.provider.query({ ...request, languageId: route.languageId }, signal)
  }

  async symbol(request: LspSymbolRequest, signal?: AbortSignal): Promise<LspSymbolsMerged> {
    if (this.providers.length === 0) {
      throw new LspError('no LSP provider is registered', 'LSP_UNAVAILABLE')
    }
    if (request.seedFilePath !== undefined) {
      // Route by the seed's extension, mirroring query(): the seed declares the symbol's language.
      const route = this.routes.get(finalExtension(request.seedFilePath))
      if (route === undefined) {
        return { groups: [], uncoveredSeedExtension: finalExtension(request.seedFilePath) }
      }
      return { groups: [await route.provider.symbol(request, signal)] }
    }
    // Seedless: a symbol name carries no language, so ask every provider. One failing provider
    // (e.g. a cold tsserver answering "No Project") must not sink the answers of the others.
    const providers = [...this.providers]
    const attempts = await Promise.all(providers.map(async (provider) => {
      try {
        return await provider.symbol(request, signal)
      } catch (error) {
        // A server without the workspaceSymbolProvider capability is an expected mixed-language
        // gap, not a failure: it contributes nothing.
        if (error instanceof LspError && error.code === 'LSP_UNSUPPORTED_OPERATION') return { unsupported: true }
        return { failed: error }
      }
    }))
    const groups: LspSymbolResult[] = []
    const failures: LspSymbolProviderFailure[] = []
    const errors: unknown[] = []
    for (const [index, attempt] of attempts.entries()) {
      if ('failed' in attempt) {
        failures.push({ provider: String(providers[index]?.id), message: errorMessage(attempt.failed) })
        errors.push(attempt.failed)
      } else if (!('unsupported' in attempt)) {
        groups.push(attempt)
      }
    }
    if (groups.length > 0) {
      return { groups, ...(failures.length > 0 ? { failures } : {}) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'every LSP provider failed the workspace symbol lookup')
    throw new LspError('no LSP provider supports workspace symbol lookup', 'LSP_UNSUPPORTED_OPERATION')
  }
}

/** Extract a message from an unknown thrown value for a model-visible failure note. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lowercase an extension and ensure it carries a leading dot; `EXTENSION_PATTERN` rejects the rest. */
function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase()
  return lower.startsWith('.') ? lower : `.${lower}`
}

export default Lsp
