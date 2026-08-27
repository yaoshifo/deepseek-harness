/**
 * Model-facing `lsp` tool over `ctx.lsp`. One read-only tool with five operations: the name-based
 * `workspaceSymbol` lookup plus the four position operations
 * (`goToDefinition`/`findReferences`/`goToImplementation`/`hover`); position operations convert
 * one-based UTF-16 cursor coordinates to the seam's zero-based positions, the tool requires the
 * session workspace with no fallback, caps and renders results, and attaches a configurable timeout
 * budget for `dsh-tool-call-timeout-policy` to enforce. It runtime-injects only `tools`, `lsp`, and
 * `systemPrompt` and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-lsp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { LspError } from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  formatSymbols,
  LSP_TOOL_OPERATIONS,
  parseLspArgs,
  presentLspCall,
} from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatHover,
  formatLocations,
  formatSymbols,
  LSP_OPERATIONS,
  LSP_TOOL_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from './render.ts'
export type { LspSymbolGroupInput, LspToolOperation } from './render.ts'
export { sessionCwd } from './session-cwd.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-lsp'

/** Services required by this plugin. */
export const inject = ['tools', 'lsp', 'systemPrompt']

/** Default tool-call timeout budget (ms), covering the queued open/query/close lifecycle. */
export const DEFAULT_LSP_TOOL_TIMEOUT_MS = 60_000

/** The stable system-prompt guidance positioning workspaceSymbol as the entry point. */
export const LSP_PROMPT_TEXT =
  'Use lsp workspaceSymbol to find functions, classes, types, and other symbols by name — it needs no coordinates (a file_path helps some servers load the project) and returns path:line:character you can pass to goToDefinition/findReferences/goToImplementation/hover. Use those four position operations when textual search matches are ambiguous or before a change requires precise definitions, implementations, or references; their line and character are one-based UTF-16 coordinates at the symbol, and an off-symbol position may return no results. findReferences always includes the declaration. Fall back to grep when no language server handles the workspace.'

/** Plugin configuration: result caps and the timeout budget. */
export interface Config {
  /** Largest number of rendered locations or symbols before an omission marker (default 100). */
  maxLocations?: number
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxLocations: z.number().default(DEFAULT_MAX_LOCATIONS),
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_LSP_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

const LSP_POSITION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    character: { type: 'integer', required: true },
  },
} as const

const LSP_RANGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
    end: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
  },
} as const

const LSP_LOCATION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    uri: { type: 'string', required: true },
    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
  },
} as const

/**
 * Register the `lsp` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `lsp`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLocations', resolved.maxLocations)
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:lsp', order: 112, text: LSP_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'lsp',
    description:
      'Query a language server for precise code navigation. workspaceSymbol finds symbols by name across the workspace — no coordinates needed; pass file_path (any file in the project) when a cold query errors, because some servers index symbols only while a project file is open. It returns path:line:character you can pass directly to goToDefinition, findReferences, goToImplementation, or hover, which take one-based UTF-16 line and character on the symbol. findReferences includes the declaration.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...LSP_TOOL_OPERATIONS],
        description: 'workspaceSymbol (by name), or goToDefinition/findReferences/goToImplementation/hover (at a position).',
      },
      query: { type: 'string', description: 'The symbol name to search for. Required for workspaceSymbol; ignored otherwise.' },
      file_path: { type: 'string', description: 'The source file to query, relative to the workspace or absolute. Required for the position operations; optional for workspaceSymbol, where any project file seeds servers that need one open.' },
      line: { type: 'number', description: 'One-based line of the cursor. Required unless operation is workspaceSymbol.' },
      character: { type: 'number', description: 'One-based UTF-16 column of the cursor. Required unless operation is workspaceSymbol.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'locations' },
              locations: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uri: { type: 'string', required: true },
                    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'hover' },
              hover: {
                required: true,
                oneOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      contents: { type: 'string', required: true },
                      range: LSP_RANGE_OUTPUT_SCHEMA,
                    },
                  },
                ],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'symbols' },
              groups: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    resolvedWorkspaceUri: { type: 'string', required: true },
                    symbols: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          name: { type: 'string', required: true },
                          kind: { type: 'string', required: true },
                          containerName: { type: 'string' },
                          location: {
                            required: true,
                            oneOf: [
                              { type: 'null' },
                              LSP_LOCATION_OUTPUT_SCHEMA,
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => {
        switch (value.kind) {
          case 'locations':
            return [{ type: 'text', text: formatLocations(value.locations, value.resolvedWorkspaceUri, resolved.maxLocations, resolved.maxResultChars) }]
          case 'hover':
            return [{ type: 'text', text: formatHover(value.hover, resolved.maxResultChars) }]
          case 'symbols':
            return [{ type: 'text', text: formatSymbols(value.groups, resolved.maxLocations, resolved.maxResultChars) }]
          /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
          default:
            return assertNever(value, 'tool-lsp output')
        }
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseLspArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new LspError('the lsp tool requires a session workspace cwd', 'LSP_WORKSPACE_REQUIRED')
      }
      if (input.operation === 'workspaceSymbol') {
        const groups = await ctx.lsp.symbol({
          query: input.query,
          workspaceRoot,
          ...input.seedFilePath === undefined ? {} : { seedFilePath: input.seedFilePath },
        }, exec.signal)
        return {
          kind: 'symbols' as const,
          groups: groups.map(group => ({
            resolvedWorkspaceUri: group.resolvedWorkspaceUri,
            symbols: group.symbols.map(symbol => ({
              name: symbol.name,
              kind: symbol.kind,
              ...symbol.containerName === undefined ? {} : { containerName: symbol.containerName },
              location: symbol.location === null
                ? null
                : {
                  uri: symbol.location.uri,
                  range: {
                    start: { line: symbol.location.range.start.line, character: symbol.location.range.start.character },
                    end: { line: symbol.location.range.end.line, character: symbol.location.range.end.character },
                  },
                },
            })),
          })),
        }
      }
      const result = await ctx.lsp.query({
        operation: input.operation,
        filePath: input.filePath,
        position: input.position,
        workspaceRoot,
      }, exec.signal)
      switch (result.kind) {
        case 'locations':
          return {
            kind: 'locations' as const,
            locations: result.locations.map(location => ({
              uri: location.uri,
              range: {
                start: { line: location.range.start.line, character: location.range.start.character },
                end: { line: location.range.end.line, character: location.range.end.character },
              },
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'hover':
          return {
            kind: 'hover' as const,
            hover: result.hover === null
              ? null
              : {
                contents: result.hover.contents,
                ...result.hover.range === undefined
                  ? {}
                  : {
                    range: {
                      start: { line: result.hover.range.start.line, character: result.hover.range.start.character },
                      end: { line: result.hover.range.end.line, character: result.hover.range.end.character },
                    },
                  },
              },
          }
        /* v8 ignore next -- exhaustive over the closed LspQueryResult union; unreachable. */
        default:
          return assertNever(result, 'tool-lsp result')
      }
    },
    presentCall: presentLspCall,
  }))
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-lsp: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-lsp: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
