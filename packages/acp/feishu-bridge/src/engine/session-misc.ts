/**
 * Session-domain misc ported from cc-connect (M7-c):
 * reset_on_idle (Go maybeAutoResetSessionOnIdle — rotate a chat to a fresh
 * session after prolonged inactivity), auto_compress (Go SetAutoCompressConfig
 * + cmdCompress + the turn-end trigger, re-based on dsh's ctx.compaction
 * compactNow instead of a "/compact" message round-trip), and the
 * filter_external_sessions setter surface. session_cleanup_days is owned by
 * SessionManager (setCleanupDays prunes idle sessions on the full save;
 * wired from the project's sessionCleanupDays config, default 30 days).
 *
 * @module dsh-feishu-bridge/session-misc
 */

import type { Message, Platform } from '../core/types.ts'
import { asContextSnapshotReader, asSessionCompressor } from '../core/types.ts'
import { Msg } from '../i18n/index.ts'
import type { Engine, InteractiveState } from './engine.ts'
import type { Session } from './session.ts'

/** Default minimum gap between auto compressions (Go 30min). */
export const defaultAutoCompressMinGapMs = 30 * 60_000

/**
 * Provider-anchored occupancy of a chat's next request, read from the live
 * agent session's token-meter `contextPressure` projection — the same
 * `projectedTokens` anchor the /context card headline uses. The value is the
 * newest usage sample's prompt-side pressure plus the heuristic surface
 * movement since it was taken, so a compaction shrinks it immediately and
 * the compression trigger rides the same source as the card and the upstream
 * meter instead of a local chars-per-rune estimate.
 *
 * Absent until a provider reports usage or without a snapshot-capable live
 * agent; the caller treats absence as below the cap — a session with no
 * usage sample has no provider-anchored context to compress.
 *
 * @param e - Engine whose agent serves the snapshot.
 * @param sessionKey - Interactive-state slot key of the chat.
 * @param session - The bridge session the read belongs to.
 * @returns the projected occupancy, or undefined when unreadable.
 */
export function projectedContextTokens(e: Engine, sessionKey: string, session: Session): number | undefined {
  try {
    return asContextSnapshotReader(e.agent)?.contextSnapshot(e.activeAgentSessionID(sessionKey, session))?.pressure?.projectedTokens
  } catch (error) {
    // A registering plugin's view parse failed inside the registry's
    // snapshot; the check degrades to "below the cap" instead of failing
    // the turn-end path (the /context card degrades the same way).
    console.warn(`auto-compress: projection snapshot read failed (${sessionKey}): ${String(error)}`)
    return undefined
  }
}

/**
 * Rotate a chat to a fresh session when the active one went stale (Go
 * maybeAutoResetSessionOnIdle). A session with neither a backend id nor a
 * conversation window is never rotated; the old session keeps its agent id
 * for /switch back; its updatedAt is left untouched.
 *
 * @param e - Engine carrying the resetOnIdle threshold.
 * @param p - The platform the inbound message arrived on.
 * @param msg - The inbound message triggering the check.
 * @param session - The locked active session for the chat.
 * @returns the new locked session, or undefined to keep the current one.
 */
export async function maybeAutoResetSessionOnIdle(
  e: Engine,
  p: Platform,
  msg: Message,
  session: Session,
): Promise<Session | undefined> {
  if (e.resetOnIdle <= 0) return undefined
  const hasBackend = session.getAgentSessionID() !== ''
  const hasHistory = (await e.recentTurnsOf(msg.sessionKey, session, 1)).length > 0
  if (!hasBackend && !hasHistory) return undefined

  const last = Date.parse(session.getUpdatedAt())
  if (!Number.isFinite(last) || Date.now() - last < e.resetOnIdle) return undefined

  const state = e.interactiveStates.get(msg.sessionKey)
  const hasAgent = state?.agentSession !== undefined && state.agentSession.alive()
  if (hasAgent) {
    // The close can take up to two minutes (stop hooks); tell the user
    // before blocking (Go cmdNew's same rationale).
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.SessionClosingGraceful))
  }

  e.stopInteractiveSession(msg.sessionKey)
  session.unlockWithoutUpdate()
  const fresh = e.sessions.newSession(msg.sessionKey, '')
  void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.SessionAutoResetIdle, Math.round(e.resetOnIdle / 60_000)))
  return fresh
}

/**
 * Run one context compression on the live session (Go runCompress, minus
 * the event-drain loop: dsh's compactNow owns the summarization turn).
 * Auto-triggered runs notify the user about the compaction with the
 * projected occupancy and suppress the completion chatter; manual runs
 * (/compress) report the outcome. The session lock stays with the caller.
 *
 * @param e - Engine carrying the i18n surface.
 * @param state - The interactive state holding the live agent session.
 * @param p - Platform to notify on.
 * @param replyCtx - Reply context for notices.
 * @param auto - True when triggered by the token threshold.
 */
export async function runCompress(
  e: Engine,
  state: InteractiveState,
  p: Platform | undefined,
  replyCtx: unknown,
  auto: boolean,
): Promise<void> {
  if (p === undefined) return
  const compressor = asSessionCompressor(state.agentSession)
  if (compressor === undefined) {
    if (!auto) await e.reply(p, replyCtx, e.i18n.t(Msg.CompressNotSupported))
    return
  }

  if (auto) {
    let notice = e.i18n.t(Msg.Compressing)
    if (state.lastAutoCompressTokens > 0) {
      notice += ` (~${Math.round(state.lastAutoCompressTokens / 1000)}k tokens)`
    }
    await e.send(p, replyCtx, notice)
  }

  try {
    await compressor.compress()
    state.compactionCount++
    if (!auto) await e.reply(p, replyCtx, e.i18n.t(Msg.CompressDone))
  } catch (error) {
    if (!auto) {
      await e.reply(p, replyCtx, e.i18n.tf(Msg.Error, String(error)))
    } else {
      console.error(`auto-compress: failed: ${String(error)}`)
    }
  }
}

/**
 * Register the /compress command on an engine. Returns the disposer.
 *
 * @param e - the engine to register the command and resolver prefix on.
 * @returns the disposer removing the handler and restoring the resolver.
 */
export function registerSessionMiscCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('compress', (p, msg) => { void cmdCompress(e, p, msg); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'compress' || cmd === 'compact' || (cmd.length >= 2 && 'compress'.startsWith(cmd))) return 'compress'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('compress')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/** /compress: manually compact the live session's context (Go cmdCompress). */
async function cmdCompress(e: Engine, p: Platform, msg: Message): Promise<void> {
  const state = e.interactiveStates.get(msg.sessionKey)
  if (state?.agentSession === undefined || !state.agentSession.alive()) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.CompressNoSession))
    return
  }
  const session = e.sessions.getOrCreateActive(msg.sessionKey)
  if (!session.tryLock()) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.PreviousProcessing))
    return
  }
  await e.send(p, msg.replyCtx, e.i18n.t(Msg.Compressing))
  try {
    await runCompress(e, state, p, msg.replyCtx, false)
  } finally {
    session.unlock()
  }
}
