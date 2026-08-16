/**
 * cc-connect bridge plugin over stdio. A deployment `cordis.patch.yml` (or
 * the profile bundle list) decides whether to load it; stdout is reserved
 * for protocol frames, so the tree must not load a stdout logger.
 *
 * Besides wiring the JSON-RPC transport, the plugin mounts the cc-connect
 * system-prompt contribution from the environment:
 * - `DSH_CC_APPEND_SYSTEM_PROMPT` — appended as an extra prompt section
 *   (the `--append-system-prompt` equivalent).
 * - `DSH_CC_SYSTEM_PROMPT_COMPLETE` — when non-empty, replaces the whole
 *   system prompt (the chatroom bare-persona equivalent).
 *
 * @module dsh-cc-connect-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { Readable, Writable } from 'node:stream'
import { registerEnterPlanMode } from './enter-plan-mode.js'
import { scratchpadContextText } from './scratchpad.js'
import { CcConnectBridgeServer } from './server.js'

export * from './server.js'
export * from './types.js'
export * from './enter-plan-mode.js'
export * from './scratchpad.js'

export const name = 'cc-connect-bridge'
// Only the agent factory is required; the LLM seam and prompt sections are
// read lazily at initialize()/assembly time.
export const inject = ['agents']

/** Deployment config plus runtime-only test hooks. */
export interface BridgeConfig {
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
}

export const Config: Schema<BridgeConfig> = Schema.object({})

/**
 * Serve bridge requests over the configured streams. Effect disposal shuts
 * down bridge-owned sessions and closes the transport. A `shutdown` response
 * is flushed before the root runtime is disposed and the process exits 0;
 * stdin EOF (the client died) takes the same path so no orphan remains.
 */
export function apply(ctx: Context, config: BridgeConfig): void {
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  transport.start()
  const server = new CcConnectBridgeServer(ctx, transport)

  const rootFiber = ctx.root.fiber
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
    return exitTask
  }

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes,
      // disposes, and exits.
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })
  // The Go client always sends `shutdown` before closing, but a crashed or
  // killed client manifests as stdin EOF — take the same clean exit.
  input.on('end', () => { void disposeAndExit() })

  // cc-connect's system-prompt contribution, injected via env at spawn time.
  const complete = process.env.DSH_CC_SYSTEM_PROMPT_COMPLETE
  const append = process.env.DSH_CC_APPEND_SYSTEM_PROMPT
  ctx.inject(['systemPrompt'], (promptCtx) => {
    if (complete !== undefined && complete !== '') {
      promptCtx.systemPrompt.section({ name: 'cc-connect', order: 0, text: complete, complete: true })
    } else if (append !== undefined && append !== '') {
      promptCtx.systemPrompt.section({ name: 'cc-connect', order: 45, text: append })
    }
    // Session scratchpad announcement rides the runtime context (per-session
    // path; empty when the Go backend did not provision one).
    const scratchpad = scratchpadContextText(process.env.CC_SCRATCHPAD)
    if (scratchpad !== '') {
      promptCtx.systemPrompt.context({ name: 'cc-connect:scratchpad', order: 50, text: scratchpad })
    }
  })

  // Agent-initiated plan-mode entry, mirrored against dsh-plan-mode's exit tool.
  registerEnterPlanMode(ctx)

  ctx.effect(() => () => { transport.close() }, 'cc-connect-bridge: close transport')
}
