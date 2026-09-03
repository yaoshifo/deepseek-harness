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
import type { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Session } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { armResearchManualAskTimeout, maybeAutoRelayRole, recoverChatroomBarriers, routePendingHumanReply } from './chatroom.ts'
import { chatroomPickActive } from './chatroom-pick.ts'
import { chatroomLedgerDir } from './chatroom-ledger.ts'
import { buildChatroomSystemPrompt } from './chatroom-persona.ts'
import type { SessionStartOptions } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomState } from '../chatroom-state.ts'
import { chatroomConfig } from '../chatroom-config.ts'

/**
 * Register the chatroom halves of the `feishuBridge/*` events:
 * - the role/direct-role permission bypass and the moderator plan downgrade
 *   (approval prompts there stall on nobody who can answer),
 * - the fixed group-name exemption (chatroom role, research, and
 *   direct-role groups),
 * - the hub auto-render suppression (roles relay to the hub, so a local
 *   HTML overview is redundant) and the hub background-session marking for
 *   the human-takeover auto-render re-enable,
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
 * - the research-assistant flag, the persona block (precomputed prompt,
 *   permission bypass, plan downgrade), and the shared research venv on
 *   session-start options.
 *
 * @param ctx - Plugin context carrying the event bus.
 * @returns Disposer removing all listeners.
 */
export function registerChatroomPolicyListeners(ctx: Context): () => void {
  const disposers = [
    ctx.on('feishuBridge/permission-policy', (payload, next) =>
      next() || payload.options?.persona?.bypassPermissions === true),
    ctx.on('feishuBridge/mode-policy', (payload, next) => {
      // A persona that never implements must not stall on a plan approval
      // nobody needs to give: its forced mode overrides an inherited plan.
      const forced = payload.options?.persona?.forceMode
      return forced !== undefined && payload.mode === 'plan' ? forced : next()
    }),
    ctx.on('feishuBridge/rename-exemption', (payload, next) =>
      next() || chatroomState(payload.session).chatroomHubKey !== '' || chatroomState(payload.session).chatroomDirectRole || chatroomState(payload.session).researchAssistant),
    ctx.on('feishuBridge/auto-render-policy', (payload, next) =>
      next() || chatroomState(payload.session).chatroomHubKey !== ''),
    ctx.on('feishuBridge/background-session-policy', (payload, next) =>
      next() || chatroomState(payload.session).chatroomHubKey !== ''),
    ctx.on('feishuBridge/hard-cap-exemption', (payload, next) =>
      next() || isResearchExemptSession(payload.engine, payload.session)),
    ctx.on('feishuBridge/route-human-reply', (payload, next) =>
      // A machine wake (moderator wake, subtask report) is never the human's
      // answer: claiming it would clear the pending flag and feed the role a
      // bogus self-answer while the hub never sees the wake. Fall through
      // (false) so the message continues on the normal agent path.
      payload.machine ? false : next() || routePendingHumanReply(payload.engine, payload.platform, payload.sessionKey, payload.content)),
    ctx.on('feishuBridge/ask-parked', (payload) => {
      // Research-manual hub only: arm the whole-ask auto-default so the
      // card cannot hang forever when the user never replies (feature #57).
      armResearchManualAskTimeout(payload.engine, payload.platform, payload.sessionKey, payload.replyCtx, payload.pending)
    }),
    ctx.on('feishuBridge/subtask-dispatched', (payload) => {
      // Research-mode role that dispatched its assistant this turn (Go
      // markResearchDispatch): one-shot flag, persisted with the registry.
      const parent = payload.engine.sessions.getOrCreateActive(payload.parentSessionKey)
      if (chatroomState(parent).chatroomHubKey === '' || !chatroomState(parent).researchAwaitingAssistant) return
      chatroomState(parent).researchDispatched = true
      payload.engine.sessions.save()
    }),
    ctx.on('feishuBridge/resolve-child-alias', (payload, next) => {
      // The "assistant" sentinel addresses the caller's pre-provisioned
      // research assistant; an unprovisioned one fails loudly here so it
      // cannot degrade into a mistyped-key error.
      if (payload.alias !== 'assistant') return next()
      const provisioned = chatroomState(payload.engine.sessions.getOrCreateActive(payload.callerSessionKey)).researchAssistantKey
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
      if (chatroomState(session).chatroomHubKey === '') return
      const askSeq = typeof metadata?.chatroomAskSeq === 'number' ? metadata.chatroomAskSeq : 0
      const awaitAssistant = metadata?.chatroomAwaitAssistant === true
      if (askSeq !== 0) chatroomState(session).chatroomAskSeq = askSeq
      if (awaitAssistant) chatroomState(session).researchAwaitingAssistant = true
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
  if (chatroomState(session).researchAssistant) return true
  const hubKey = chatroomState(session).chatroomHubKey
  if (hubKey !== '') {
    const hub = engine.sessions.findActive(hubKey)
    if (hub !== undefined && chatroomState(hub).chatroomResearch) return true
  }
  return false
}

/**
 * Fill the research-assistant flag, the chatroom persona block, and the
 * shared research venv on session start options (moved from the engine's
 * buildSessionStartOptions; Go buildSessionEnv). The persona prompt is
 * precomputed here — flattened from the session's effective workdir (the
 * per-chat /dir override, else the agent base dir), the same directory the
 * adapter would start the session in. The hub lookup is non-creating: a
 * dangling hub key must not mint a phantom hub whose empty flags silently
 * strip the research contract from this role.
 * @param engine - The engine owning the session registry.
 * @param session - Session whose chatroom flags expand the options.
 * @param options - The options object to mutate in place.
 */
function decorateSessionStartOptions(engine: Engine, session: Session, options: SessionStartOptions): void {
  // Research assistants are subtask children: their flag rides the subtask
  // section (the engine fills attended/no-report only; the flag appears
  // only when the session is a research assistant).
  if (options.subtask !== undefined && chatroomState(session).researchAssistant) options.subtask.researchAssistant = true
  const hubKey = chatroomState(session).chatroomHubKey
  if (hubKey !== '') {
    const ledger = chatroomConfig(engine).moderatorDir()
    const moderator = chatroomState(session).chatroomModerator
    // Research mode: the hub flagged this chatroom as research-driven.
    // Tell the role so its contract knows to drive a full-CC assistant
    // subgroup instead of answering from memory. The assistant is
    // addressed with the "assistant" sentinel (the resolve-child-alias
    // listener resolves it from this session's researchAssistantKey).
    const researchHub = engine.sessions.findActive(hubKey)
    const research = researchHub !== undefined && chatroomState(researchHub).chatroomResearch
    options.persona = {
      prompt: buildChatroomSystemPrompt({
        // Resolve through the SESSION KEY: the per-chat workdir overrides
        // (startChatroom's role persona dirs) are keyed by interactive keys,
        // while session.id is the internal `s${n}` registry id and never
        // matches — a miss here silently strips every role's persona
        // (08e1428c75 regression).
        workDir: engine.sessionWorkDir(options.sessionKey),
        isRole: true,
        isDirect: false,
        isModerator: moderator,
        research,
        ledgerDir: ledger.ok ? chatroomLedgerDir(ledger.dir, hubKey) : '',
        userProfilePath: chatroomConfig(engine).userProfile(),
        platformPrompt: '',
      }),
      bypassPermissions: true,
      forceMode: moderator ? 'default' : undefined,
    }
  } else if (chatroomState(session).chatroomDirectRole || chatroomState(session).chatroomModerator) {
    // 1:1 direct role chat (no hub, no relay): the lightweight direct-role
    // contract instead of the multi-role one.
    const directRole = chatroomState(session).chatroomDirectRole
    const moderator = chatroomState(session).chatroomModerator
    options.persona = {
      prompt: buildChatroomSystemPrompt({
        // Session key, not the internal registry id — see the role branch
        // above for the override-key mismatch this avoids.
        workDir: engine.sessionWorkDir(options.sessionKey),
        isRole: false,
        isDirect: directRole,
        isModerator: moderator,
        research: false,
        ledgerDir: '',
        userProfilePath: chatroomConfig(engine).userProfile(),
        platformPrompt: '',
      }),
      bypassPermissions: directRole,
      forceMode: moderator ? 'default' : undefined,
    }
  }
  // Shared research venv (Go buildSessionEnv research path: VIRTUAL_ENV
  // plus <venv>/bin prepended to the child PATH).
  const venv = chatroomState(session).researchVenv
  if (venv !== '') options.venv = { virtualEnv: venv }
}
