/**
 * Session-domain misc ported from cc-connect (M7-c):
 * reset_on_idle (Go maybeAutoResetSessionOnIdle — rotate a chat to a fresh
 * session after prolonged inactivity) and the filter_external_sessions
 * setter surface. session_cleanup_days is owned by SessionManager
 * (setCleanupDays prunes idle sessions on the full save; wired from the
 * project's sessionCleanupDays config, default 30 days).
 *
 * @module dsh-feishu-bridge/session-misc
 */

import type { Message, Platform } from '../core/types.ts'
import { Msg } from '../i18n/index.ts'
import type { Engine } from './engine.ts'
import type { Session } from './session.ts'

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
