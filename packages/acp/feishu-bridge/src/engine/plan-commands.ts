/**
 * /plan: switch the calling chat's session into or out of plan mode. Slash
 * dispatch belongs to the bridge's own command table (the native
 * `dsh-commands` surface is not composed in this deployment), so the native
 * `/plan` command is unreachable from Feishu; this module forwards one
 * selection to the session's PlanModeSwitcher capability instead.
 *
 * Registration lives here (not in engine/commands.ts) so this domain cannot
 * collide with parallel work on that file; {@link registerPlanCommands}
 * merges into whatever command table the engine already carries.
 *
 * @module dsh-feishu-bridge/plan-commands
 */

import type { Message, Platform } from '../core/types.ts'
import { asPlanModeSwitcher } from '../core/types.ts'
import { Msg, type MsgKey } from '../i18n/index.ts'
import type { Engine } from './engine.ts'

/**
 * Register /plan on an engine through the {@link Engine.registerCommand} seam.
 * Requires the session command table (registerSessionCommands) to be
 * installed first.
 * @param e - The engine whose command table and resolver to install on.
 * @returns The disposer removing the handler and restoring the resolver.
 */
export function registerPlanCommands(e: Engine): () => void {
  return e.registerCommand({
    id: 'plan',
    handler: (p, msg, args) => cmdPlan(e, p, msg, args),
    match: cmd => cmd === 'plan' || (cmd.length >= 2 && 'plan'.startsWith(cmd)) ? 'plan' : '',
    group: 'session',
  })
}

/**
 * /plan [off|<task>]: switch the chat's live session into plan mode, or out of
 * it with `off`. A task text switches plan mode and then falls through as an
 * ordinary message, so the task opens (or joins) a turn through the normal
 * delivery path instead of a private send.
 * @param e - The engine owning the session state.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 * @param args - The command's whitespace-split arguments.
 * @returns Whether the command consumed the message.
 */
function cmdPlan(e: Engine, p: Platform, msg: Message, args: string[]): boolean {
  const session = e.interactiveStates.get(msg.sessionKey)?.agentSession
  const live = session !== undefined && session.alive() ? session : undefined
  const leaving = args[0] === 'off'
  const task = leaving ? '' : args.join(' ').trim()
  if (task !== '') {
    if (live === undefined) {
      // No live session to switch: arm the one-shot override the message
      // itself will start the session with. Never the adapter's global
      // setSessionMode — that override is consumed by whichever chat starts
      // a session next.
      msg.modeOverride = 'plan'
    } else {
      const key = ackKey(true, asPlanModeSwitcher(live)?.setPlanMode(true) ?? '')
      if (key === Msg.PlanEnteredPending || key === Msg.PlanUnavailable) {
        void e.reply(p, msg.replyCtx, e.i18n.t(key))
      }
    }
    msg.content = task
    return false
  }
  if (live === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(leaving ? Msg.PlanColdOff : Msg.PlanColdHint))
    return true
  }
  const outcome = asPlanModeSwitcher(live)?.setPlanMode(!leaving) ?? ''
  void e.reply(p, msg.replyCtx, e.i18n.t(ackKey(!leaving, outcome)))
  return true
}

/**
 * Acknowledgement key for one switch outcome.
 * @param entering - Whether the command asked for plan mode to be active.
 * @param outcome - The capability's outcome ('' when unavailable, including
 *   a chat with no live session).
 * @returns The message key describing what happened.
 */
function ackKey(entering: boolean, outcome: string): MsgKey {
  if (outcome === '') return Msg.PlanUnavailable
  if (outcome === 'queued') return entering ? Msg.PlanEnteredPending : Msg.PlanExitedPending
  if (outcome === 'noop') return Msg.PlanAlready
  // `committed` logged the selection now; `cancelled` cleared an opposite
  // pending selection, so the logged state already sits at the requested one.
  return entering ? Msg.PlanEntered : Msg.PlanExited
}
