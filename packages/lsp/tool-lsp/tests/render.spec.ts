import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  formatSymbols,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from '@deepseek-ai/dsh-tool-lsp'
import type { LspLocation, LspSymbol } from '@deepseek-ai/dsh-lsp'

const WS = resolve('/home/u/proj')
const WS_URI = pathToFileURL(WS).href

function loc(uri: string, line: number, character = 0): LspLocation {
  return { uri, range: { start: { line, character }, end: { line, character: character + 1 } } }
}

function sym(name: string, kind: string, location: LspLocation | null, containerName?: string): LspSymbol {
  return { name, kind, location, ...containerName === undefined ? {} : { containerName } }
}

describe('parseLspArgs', () => {
  it('accepts the four position operations and converts one-based to zero-based', () => {
    for (const operation of LSP_OPERATIONS) {
      const input = parseLspArgs({ operation, file_path: 'a.ts', line: 3, character: 5 })
      expect(input.operation).toBe(operation)
      if (input.operation !== 'workspaceSymbol') {
        expect(input.position).toEqual({ line: 2, character: 4 })
      }
    }
  })

  it('accepts workspaceSymbol with a query and no coordinates', () => {
    expect(parseLspArgs({ operation: 'workspaceSymbol', query: 'answer' }))
      .toEqual({ operation: 'workspaceSymbol', query: 'answer' })
  })

  it('accepts an optional seed file_path for workspaceSymbol and drops a blank one', () => {
    expect(parseLspArgs({ operation: 'workspaceSymbol', query: 'answer', file_path: 'a.ts' }))
      .toEqual({ operation: 'workspaceSymbol', query: 'answer', seedFilePath: 'a.ts' })
    expect(parseLspArgs({ operation: 'workspaceSymbol', query: 'answer', file_path: '  ' }))
      .toEqual({ operation: 'workspaceSymbol', query: 'answer' })
  })

  it('rejects workspaceSymbol without a query or with a blank one', () => {
    expect(() => parseLspArgs({ operation: 'workspaceSymbol' })).toThrow(/query/)
    expect(() => parseLspArgs({ operation: 'workspaceSymbol', query: '  ' })).toThrow(/query/)
  })

  it('rejects an unknown operation', () => {
    expect(() => parseLspArgs({ operation: 'rename', file_path: 'a.ts', line: 1, character: 1 }))
      .toThrow(/operation must be one of/)
  })

  it('rejects a blank file_path', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: '   ', line: 1, character: 1 }))
      .toThrow(/file_path/)
  })

  it('rejects a position operation with missing coordinates', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts' })).toThrow(/line/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1 })).toThrow(/character/)
  })

  it('rejects non-positive or non-integer coordinates', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 0, character: 1 })).toThrow(/line/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1, character: 0 })).toThrow(/character/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1.5, character: 1 })).toThrow(/line/)
  })
})

describe('renderUri', () => {
  it('relativizes a file: URI inside the workspace with forward slashes', () => {
    const uri = pathToFileURL(join(WS, 'src', 'a.ts')).href
    expect(renderUri(uri, WS_URI)).toBe('src/a.ts')
  })

  it('returns an absolute path for a file: URI outside the workspace', () => {
    const outside = resolve(WS, '..', 'other', 'lib', 'b.ts')
    const uri = pathToFileURL(outside).href
    expect(renderUri(uri, WS_URI)).toBe(outside.replaceAll('\\', '/'))
  })

  it('renders the workspace root itself as "."', () => {
    expect(renderUri(WS_URI, WS_URI)).toBe('.')
  })

  it('keeps an in-workspace path whose first segment starts with dots relative', () => {
    // `..generated` is a real in-workspace dir, not a parent escape; only a `..` segment is external.
    const uri = pathToFileURL(join(WS, '..generated', 'a.ts')).href
    expect(renderUri(uri, WS_URI)).toBe('..generated/a.ts')
  })

  it('relativizes Windows execution-world URIs on a non-Windows host', () => {
    expect(renderUri('file:///C:/WORKSPACE/src/a.ts', 'file:///c:/workspace')).toBe('src/a.ts')
    expect(renderUri('file:///D:/lib/b.ts', 'file:///C:/workspace')).toBe('D:/lib/b.ts')
  })

  it('renders remote file authorities without host path conversion', () => {
    expect(renderUri('file://server/share/workspace/a.ts', 'file://server/share/workspace')).toBe('a.ts')
    expect(renderUri('file://SERVER/share/workspace/src/A.ts', 'file://server/Share/Workspace')).toBe('src/A.ts')
    expect(renderUri('file://other/share/b.ts', 'file://server/share/workspace')).toBe('//other/share/b.ts')
    expect(renderUri('file:///D:/lib/a.ts', 'file://server/share/workspace')).toBe('D:/lib/a.ts')
    expect(renderUri('file:///a.ts', 'file://server/')).toBe('/a.ts')
    expect(renderUri('file:///a.ts', 'file:///')).toBe('a.ts')
  })

  it('preserves backslashes as ordinary POSIX filename characters', () => {
    expect(renderUri('file:///home/u/proj/dir%5Cname/a.ts', 'file:///home/u/proj')).toBe('dir\\name/a.ts')
  })

  it('keeps malformed or mismatched URI coordinates verbatim', () => {
    expect(renderUri('file://[', WS_URI)).toBe('file://[')
    expect(renderUri('file:///a.ts', 'https://example.com/workspace')).toBe('file:///a.ts')
    expect(renderUri('file:///a.ts', 'file:///bad%ZZ')).toBe('file:///a.ts')
    expect(renderUri('file:///C:/workspace/bad%5Cpath', 'file:///C:/workspace')).toBe('file:///C:/workspace/bad%5Cpath')
    expect(renderUri('file:///short', 'file:///short/deeper')).toBe('/short')
    expect(renderUri('file:///', 'file:///C:/workspace')).toBe('/')
  })

  it('keeps a non-file URI verbatim', () => {
    expect(renderUri('untitled:Untitled-1', WS_URI)).toBe('untitled:Untitled-1')
    expect(renderUri('jdt://contents/Foo.class', WS_URI)).toBe('jdt://contents/Foo.class')
  })

  it('keeps a malformed file: URI verbatim when it cannot be parsed to a path', () => {
    // An encoded path separator is invalid on every platform and must remain verbatim.
    expect(renderUri('file:///bad%2Fpath', WS_URI)).toBe('file:///bad%2Fpath')
    expect(renderUri('file:///bad%00path', WS_URI)).toBe('file:///bad%00path')
  })
})

describe('formatLocations', () => {
  it('renders a no-result line for an empty list', () => {
    expect(formatLocations([], WS_URI, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('No results.')
  })

  it('renders one-based path:line:character grouped by file', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatLocations([loc(a, 0, 0), loc(a, 4, 2)], WS_URI, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('a.ts:1:1\na.ts:5:3')
  })

  it('caps at maxLocations and marks the omission', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const many = Array.from({ length: 5 }, (_, i) => loc(a, i))
    const text = formatLocations(many, WS_URI, 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('a.ts:1:1')
    expect(text).toContain('3 more locations omitted (limit 2).')
  })

  it('uses the singular omission marker for exactly one extra', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatLocations([loc(a, 0), loc(a, 1)], WS_URI, 1, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('1 more location omitted (limit 1).')
  })

  it('caps the complete location text even when one URI is enormous', () => {
    const maxResultChars = 80
    const text = formatLocations([loc(`custom:${'x'.repeat(1_000_000)}`, 0)], WS_URI, 1, maxResultChars)
    expect(text).toHaveLength(maxResultChars)
    expect(text).toContain('locations truncated')
  })
})

describe('formatHover', () => {
  it('renders a no-result line for null', () => {
    expect(formatHover(null, DEFAULT_MAX_RESULT_CHARS)).toBe('No hover information.')
  })

  it('returns short hover verbatim', () => {
    expect(formatHover({ contents: '```ts\nx: number\n```' }, DEFAULT_MAX_RESULT_CHARS)).toBe('```ts\nx: number\n```')
  })

  it('caps the complete hover text including its truncation marker', () => {
    const text = formatHover({ contents: 'a'.repeat(100) }, 60)
    expect(text).toHaveLength(60)
    expect(text).toContain('hover truncated (limit 60 characters).')
  })

  it('still honors a cap smaller than the truncation marker', () => {
    expect(formatHover({ contents: 'a'.repeat(100) }, 10)).toHaveLength(10)
  })
})

describe('formatSymbols', () => {
  it('renders a no-result line when every group is empty', () => {
    expect(formatSymbols([{ symbols: [], resolvedWorkspaceUri: WS_URI }], [], undefined, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS))
      .toBe('No symbols found.')
    expect(formatSymbols([], [], undefined, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('No symbols found.')
  })

  it('renders name, kind, container, and one-based location', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatSymbols([{ symbols: [sym('answer', 'function', loc(a, 2, 6), 'Math'), sym('x', 'variable', loc(a, 0))], resolvedWorkspaceUri: WS_URI }], [], undefined, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('answer (function) in Math — a.ts:3:7\nx (variable) — a.ts:1:1')
  })

  it('renders a no-location symbol without a position suffix', () => {
    const text = formatSymbols([{ symbols: [sym('answer', 'function', null)], resolvedWorkspaceUri: WS_URI }], [], undefined, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('answer (function) — no location')
  })

  it('caps across groups in provider order and marks the omission', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const b = pathToFileURL(join(WS, 'b.ts')).href
    const text = formatSymbols([
      { symbols: [sym('a', 'function', loc(a, 0))], resolvedWorkspaceUri: WS_URI },
      { symbols: [sym('b', 'function', loc(b, 1)), sym('c', 'function', loc(b, 2))], resolvedWorkspaceUri: WS_URI },
    ], [], undefined, 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('a (function) — a.ts:1:1\nb (function) — b.ts:2:1\n… 1 more symbol omitted (limit 2).')
  })

  it('caps the complete symbol text even when one name is enormous', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatSymbols([{ symbols: [sym('n'.repeat(1_000_000), 'function', loc(a, 0))], resolvedWorkspaceUri: WS_URI }], [], undefined, 1, 80)
    expect(text).toHaveLength(80)
    expect(text).toContain('symbols truncated')
  })

  it('renders one-line failure notes after the symbol lines', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatSymbols(
      [{ symbols: [sym('x', 'function', loc(a, 0))], resolvedWorkspaceUri: WS_URI }],
      [{ provider: 'typescript', message: 'Error: No Project.\n    at Object.ThrowNoProject (…)' }],
      undefined,
      DEFAULT_MAX_LOCATIONS,
      DEFAULT_MAX_RESULT_CHARS,
    )
    expect(text).toBe('x (function) — a.ts:1:1\n⚠ typescript provider failed: Error: No Project.')
  })

  it('renders failure notes after the no-result line', () => {
    const text = formatSymbols([], [{ provider: 'gopls', message: 'crashed' }], undefined, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('No symbols found.\n⚠ gopls provider failed: crashed')
  })

  it('renders the install suggestion for an uncovered seed extension instead of a no-result line', () => {
    const known = formatSymbols([], [], '.py', DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(known).toBe('⚠ No language server is configured for .py files — suggest installing pyright and adding it to the lsp-stdio servers config so lsp can cover the language.')
    const unknown = formatSymbols([], [], '.ml', DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(unknown).toBe('⚠ No language server is configured for .ml files — ask the user to install one and add it to the lsp-stdio servers config so lsp can cover the language.')
  })
})

describe('presentLspCall', () => {
  it('is a generic search card with an operation/cursor title and a line location', () => {
    expect(presentLspCall({ operation: 'findReferences', file_path: 'a.ts', line: 3, character: 7 })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'LSP findReferences a.ts:3:7',
      locations: [{ path: 'a.ts', line: 3 }],
    })
  })

  it('is a generic search card with a quoted-query title for workspaceSymbol', () => {
    expect(presentLspCall({ operation: 'workspaceSymbol', query: 'answer' })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'LSP workspaceSymbol "answer"',
    })
  })
})
