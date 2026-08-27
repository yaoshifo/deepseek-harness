/**
 * The chatroom policy listeners: the chatroom halves of every
 * `feishuBridge/*` event the engine and adapter dispatch. One process-wide
 * registration (apply wires it once) — the listeners are payload functions,
 * so per-project wiring would double-fire them. Kept out of chatroom.ts so
 * the ask-approval listener can consume chatroom-pick without an import
 * cycle (chatroom-pick already imports runtime symbols from chatroom.ts).
 *
 * @module dsh-feishu-bridge/chatroom-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Engine } from './engine.js'
import type { Session } from './session.js'
import { armResearchManualAskTimeout, maybeAutoRelayRole, recoverChatroomBarriers, routePendingHumanReply } from './chatroom.js'
import { chatroomPickActive } from './chatroom-pick.js'
import { chatroomLedgerDir } from './chatroom-ledger.js'
import type { SessionStartOptions } from '../core/types.js'

/**
 * Register the chatroom halves of the `feishuBridge/*` events:
 * - the role/direct-role permission bypass and the moderator plan downgrade
 *   (approval prompts there stall on nobody who can answer),
 * - the fixed group-name exemption (chatroom role, research, and
 *   direct-role groups),
 * - the hub auto-render suppression (roles relay to the hub, so a local
 *   HTML overview is redundant),
 * - the hard-cap exemption for research sessions (their long turns are the
 *   product),
 * - the pending ask-human reply routing (consumed replies outrank command
 *   dispatch and permission handling),
 * - the research-manual whole-ask auto-default timer on parked asks,
 * - the assistant-dispatch marking on subtask dispatches,
 * - the "assistant" child-alias resolution,
 * - the gather-round metadata stamp at turn start,
 * - the role-reply relay at turn end,
 * - the moderator role-pick plan-review auto-approval,
 * - barrier recovery once platforms are live,
 * - the persona block and shared research venv on session-start options.
 *
 * @param ctx - Plugin context carrying the event bus.
 * @returns Disposer removing all listeners.
 */
export function registerChatroomPolicyListeners(ctx: Context): () => void {
  const disposers = [
    ctx.on('feishuBridge/permission-policy', (payload, next) =>
      next() || payload.options?.chatroom?.role === true || payload.options?.chatroom?.directRole === true),
    ctx.on('feishuBridge/mode-policy', (payload, next) =>
      payload.mode === 'plan' && payload.options?.chatroom?.moderator === true ? 'default' : next()),
    ctx.on('feishuBridge/rename-exemption', (payload, next) =>
      next() || payload.session.getChatroomHubKey() !== '' || payload.session.getChatroomDirectRole() || payload.session.getResearchAssistant()),
    ctx.on('feishuBridge/auto-render-policy', (payload, next) =>
      next() || payload.session.getChatroomHubKey() !== ''),
    ctx.on('feishuBridge/hard-cap-exemption', (payload, next) =>
      next() || isResearchExemptSession(payload.engine, payload.session)),
    ctx.on('feishuBridge/route-human-reply', (payload, next) =>
      next() || routePendingHumanReply(payload.engine, payload.platform, payload.sessionKey, payload.content)),
    ctx.on('feishuBridge/ask-parked', (payload) => {
      // Research-manual hub only: arm the whole-ask auto-default so the
      // card cannot hang forever when the user never replies (feature #57).
      armResearchManualAskTimeout(payload.engine, payload.platform, payload.sessionKey, payload.replyCtx, payload.pending)
    }),
    ctx.on('feishuBridge/subtask-dispatched', (payload) => {
      // Research-mode role that dispatched its assistant this turn (Go
      // markResearchDispatch): one-shot flag, persisted with the registry.
      const parent = payload.engine.sessions.getOrCreateActive(payload.parentSessionKey)
      if (parent.getChatroomHubKey() === '' || !parent.getResearchAwaitingAssistant()) return
      parent.setResearchDispatched(true)
      payload.engine.sessions.save()
    }),
    ctx.on('feishuBridge/resolve-child-alias', (payload, next) => {
      // The "assistant" sentinel addresses the caller's pre-provisioned
      // research assistant; an unprovisioned one fails loudly here so it
      // cannot degrade into a mistyped-key error.
      if (payload.alias !== 'assistant') return next()
      const provisioned = payload.engine.sessions.getOrCreateActive(payload.callerSessionKey).getResearchAssistantKey()
      if (provisioned === '') {
        throw new Error('subtask: no pre-provisioned assistant on this session — spawn one first (action: spawn)')
      }
      return provisioned
    }),
    ctx.on('feishuBridge/turn-start', (payload) => {
      // Go stampChatroomAskOnTurnStart: consume the gather-round metadata at
      // the moment the turn actually starts. The stamp persists whenever the
      // session is chatroom-bound, even when both values are no-ops.
      const { engine, session, metadata } = payload
      if (session.getChatroomHubKey() === '') return
      const askSeq = typeof metadata?.chatroomAskSeq === 'number' ? metadata.chatroomAskSeq : 0
      const awaitAssistant = metadata?.chatroomAwaitAssistant === true
      if (askSeq !== 0) session.setChatroomAskSeq(askSeq)
      if (awaitAssistant) session.setResearchAwaitingAssistant(true)
      engine.sessions.save()
    }),
    ctx.on('feishuBridge/turn-end', (payload, next) => {
      maybeAutoRelayRole(payload.engine, payload.state, payload.session, payload.response, payload.isSilent)
      next()
    }),
    ctx.on('feishuBridge/ask-approval', async (payload, next) => {
      // The moderator's plan review is a formality (priming pre-bakes a
      // trivial plan): auto-approve so the user isn't prompted just to
      // green-light reading role files + pick-roles. Only in the pick window.
      if (chatroomPickActive(payload.engine, payload.sessionKey)) {
        console.info(`auto-approving plan review (chatroom role-pick) (${payload.sessionKey})`)
        return { outcome: 'allowed-once' }
      }
      return await next()
    }),
    ctx.on('feishuBridge/platforms-ready', (payload) => {
      // Barriers restored from disk close here, once platforms can deliver
      // the wakes: every reply they awaited died with the old process.
      recoverChatroomBarriers(payload.engine)
    }),
    ctx.on('feishuBridge/session-start-options', (payload, next) => {
      decorateSessionStartOptions(payload.engine, payload.session, payload.options)
      next()
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Whether a session's long turns are the product and lift the per-turn hard
 * cap (Go isResearchSession): research assistants and roles bound to a
 * research-driven chatroom hub.
 * @param engine - The engine owning the session registry (hub lookup).
 * @param session - The session the turn runs under.
 * @returns True when the session is exempt from the hard cap.
 */
function isResearchExemptSession(engine: Engine, session: Session): boolean {
  if (session.getResearchAssistant()) return true
  const hubKey = session.getChatroomHubKey()
  if (hubKey !== '') {
    const hub = engine.sessions.findActive(hubKey)
    if (hub !== undefined && hub.getChatroomResearch()) return true
  }
  return false
}

/**
 * Fill the chatroom persona block and the shared research venv on session
 * start options (moved from the engine's buildSessionStartOptions; Go
 * buildSessionEnv). The hub lookup is non-creating: a dangling hub key must
 * not mint a phantom hub whose empty flags silently strip the research
 * contract from this role.
 * @param engine - The engine owning the session registry.
 * @param session - Session whose chatroom flags expand the options.
 * @param options - The options object to mutate in place.
 */
function decorateSessionStartOptions(engine: Engine, session: Session, options: SessionStartOptions): void {
  const hubKey = session.getChatroomHubKey()
  if (hubKey !== '') {
    const ledger = engine.chatroomModeratorDir()
    options.chatroom = {
      role: true,
      directRole: false,
      moderator: session.getChatroomModerator(),
      ledgerDir: ledger.ok ? chatroomLedgerDir(ledger.dir, hubKey) : '',
      // Research mode: the hub flagged this chatroom as research-driven.
      // Tell the role so its contract knows to drive a full-CC assistant
      // subgroup instead of answering from memory. The assistant is
      // addressed with the "assistant" sentinel (sendToSubtask resolves it
      // from this session's researchAssistantKey).
      research: engine.sessions.findActive(hubKey)?.getChatroomResearch() === true,
    }
  } else if (session.getChatroomDirectRole() || session.getChatroomModerator()) {
    // 1:1 direct role chat (no hub, no relay): the lightweight direct-role
    // contract instead of the multi-role one.
    options.chatroom = {
      role: false,
      directRole: session.getChatroomDirectRole(),
      moderator: session.getChatroomModerator(),
      ledgerDir: '',
      research: false,
    }
  }
  // Shared research venv (Go buildSessionEnv research path: VIRTUAL_ENV
  // plus <venv>/bin prepended to the child PATH).
  const venv = session.getResearchVenv()
  if (venv !== '') options.venv = { virtualEnv: venv }
}
