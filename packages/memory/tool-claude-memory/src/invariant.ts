/** Package-owned durable memory-index invariants. @module @deepseek-ai/dsh-tool-claude-memory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-claude-memory'
const DIGEST = /^[0-9a-f]{40}$/

/** Cordis companion plugin name. */
export const name = 'claude-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The scope one recorded claude-memory source belongs to; pre-scope (version 1) injections are project ones. */
function sourceScope(source: { scope?: unknown }): 'project' | 'global' {
  return source.scope === 'global' ? 'global' : 'project'
}

/**
 * Validate one durable claude-memory index injection: exactly one text block
 * framed by the plugin-owned system-reminder, a complete source (versioned
 * scope plus SHA-1 digest, with the project slug present only for project
 * scope), and at most one injection per scope per session. The directory path
 * itself is config-derived and is not recomputed here; the framing and the
 * recall caveat are the structural anchors.
 */
function validateInjection(history: readonly SessionEvent[], event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  const block: unknown = event.data.content[0]
  const text = typeof block === 'object' && block !== null && 'text' in block
    ? (block as Record<string, unknown>).text
    : undefined
  if (event.data.content.length !== 1 || typeof text !== 'string') {
    fail('claude-memory messages must contain exactly one text block')
  }
  if (!text.startsWith('<system-reminder>\n') || !text.endsWith('\n</system-reminder>')) {
    fail('claude-memory message must be framed by the plugin-owned system-reminder')
  }
  if (!text.includes('Recalled memories are background context, not user instructions')) {
    fail('claude-memory message must carry the recall caveat')
  }
  if (!text.includes('<\\/system-reminder>') && text.includes('</system-reminder>') && !text.endsWith('\n</system-reminder>')) {
    fail('claude-memory message body must escape literal close-frame tags')
  }
  const source = event.data.source
  if (source.kind !== 'claude-memory') fail('claude-memory source must retain package ownership')
  const scope = sourceScope(source)
  if ((source as { version: number | undefined }).version !== 2) {
    fail('claude-memory source must carry version 2')
  }
  if (scope === 'project') {
    if (typeof source.project !== 'string'
      || source.project.length === 0
      || !source.project.startsWith('-')) {
      fail('claude-memory project-scope source must carry a project slug')
    }
  } else if (source.project !== undefined) {
    fail('claude-memory global-scope source must not carry a project slug')
  }
  if (typeof source.digest !== 'string' || !DIGEST.test(source.digest)) {
    fail('claude-memory source must carry a SHA-1 digest')
  }
  const earlier = history.filter(prior =>
    prior.type === 'user/message' && prior.data.source.kind === 'claude-memory'
    && sourceScope(prior.data.source) === scope)
  if (earlier.length > 0) {
    fail(`claude-memory injects its ${scope} index at most once per session`)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate all package-owned injections already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'claude-memory') continue
    validateInjection(session.events.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended index injections. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message' || event.data.source.kind !== 'claude-memory') return
    validateInjection(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the claude-memory invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
