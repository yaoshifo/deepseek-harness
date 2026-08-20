/**
 * Misc commands ported from cc-connect core: /help (Go cmdHelp) and /ps (Go
 * handleCommand's "ps" case). The /help command list is generated from the
 * engine's registered command handlers with their i18n one-liners — Go's
 * hand-maintained message_help blob drifted into advertising commands that
 * do not exist here, so the blob (message_help and the help_*_section
 * entries) was deleted instead of ported. Go's button-driven help-card
 * family (renderHelpGroupCard + nav: help navigation) is not ported: /help
 * renders one markdown card / text reply.
 *
 * /ps appends text to a running task: mid-turn it is sent straight into the
 * live agent session (queued instead when the turn is blocked on a
 * permission, where a direct write would sit behind the CLI input queue);
 * when the agent is idle the command falls through as a normal message.
 *
 * Registration lives here (not in engine/commands.ts) so this domain cannot
 * collide with parallel work on that file; {@link registerMiscCommands}
 * merges into whatever command table the engine already carries.
 *
 * @module dsh-feishu-bridge/misc-commands
 */

import { Msg, type MsgKey } from '../i18n/index.js'
import type { Message, Platform } from '../core/types.js'
import { asReactionAdder } from '../core/types.js'
import type { Engine } from './engine.js'

/** One-line description lookup key per canonical command id. */
const oneLinerKey = (cmdID: string): MsgKey => cmdID as MsgKey

/** Detailed usage lookup key per canonical command id (Go cmdID + "_usage"). */
const usageKey = (cmdID: string): MsgKey => `${cmdID}_usage` as MsgKey

/**
 * Register /help and /ps on an engine. Returns the disposer.
 * @param e - The engine whose command table and resolver to install on.
 * @returns The disposer removing the handlers and restoring the resolver.
 */
export function registerMiscCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('help', (p, msg, args) => { void cmdHelp(e, p, msg, args); return true })
  handlers.set('ps', (p, msg, args) => cmdPs(e, p, msg, args))
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'help' || (cmd.length >= 2 && 'help'.startsWith(cmd))) return 'help'
    if (cmd === 'ps') return 'ps'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('help')
    handlers.delete('ps')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/**
 * Build the full help text from the registered command handlers, each with
 * its i18n one-liner, plus the provider-shortcut line and prefix tip.
 * @param e - The engine whose registered commands are listed.
 * @returns The assembled help markdown.
 */
function helpText(e: Engine): string {
  const lines: string[] = []
  for (const cmdID of e.commandHandlers?.keys() ?? []) {
    const desc = e.i18n.t(oneLinerKey(cmdID))
    // A missing one-liner returns the key itself; show the bare command then.
    lines.push(desc === cmdID ? `**/${cmdID}**` : `**/${cmdID}** — ${desc}`)
  }
  let text = lines.join('\n')
  const shortcuts = Object.keys(e.providerShortcuts)
  if (shortcuts.length > 0) {
    shortcuts.sort()
    text += `\n\n${e.i18n.tf(Msg.HelpShortcuts, shortcuts.map(s => `/${s}`).join(', '))}`
  }
  text += `\n\n${e.i18n.t(Msg.HelpPrefixTip)}`
  return text
}

/**
 * /help [command]: show the full command list, or one command's detailed
 * usage (Go cmdHelp; the list is generated from registered handlers).
 */
async function cmdHelp(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  if (args.length > 0) {
    const raw = args[0]?.replace(/^\//, '') ?? ''
    const cmdID = e.commandResolver?.(raw) ?? (e.commandHandlers?.has(raw) ? raw : '')
    if (cmdID !== '') {
      const usageKeyFor = usageKey(cmdID)
      let text = e.i18n.t(usageKeyFor)
      if (text === usageKeyFor) {
        // No usage entry: fall back to the one-line description.
        text = `**/${cmdID}** — ${e.i18n.t(oneLinerKey(cmdID))}\n${e.i18n.t(Msg.HelpNoUsage)}`
      }
      await e.reply(p, msg.replyCtx, text)
      return
    }
    // Unknown / ambiguous: hint, then fall through to the full help.
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.HelpUnknownCmd, args[0] ?? ''))
  }
  await e.sendAsCard(p, msg.replyCtx, helpText(e), { title: e.i18n.t(Msg.HelpListTitle), color: 'blue' })
}

/**
 * /ps <message>: append text to the currently running task (Go handleCommand
 * "ps" case). Mid-turn the text goes straight into the live agent session —
 * unless the turn is blocked on a permission, where it is queued as the next
 * turn. When the agent is idle the command returns false so the message
 * falls through to normal processing with the /ps prefix stripped.
 * @returns Whether the command consumed the message.
 */
function cmdPs(e: Engine, p: Platform, msg: Message, args: string[]): boolean {
  const text = args.join(' ').trim()
  if (text === '') {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.PsEmpty))
    return true
  }
  const state = e.interactiveStates.get(msg.sessionKey)
  if (state === undefined || state.agentSession === undefined || !state.agentSession.alive() || state.activeTurns <= 0) {
    // Agent is idle or no session: strip the /ps prefix and fall through to
    // normal message processing.
    msg.content = text
    return false
  }
  // A turn blocked on a permission/plan approval would swallow a direct
  // write behind the CLI's input queue; queue it as the next turn instead.
  if (state.pending !== undefined) {
    msg.content = text
    if (e.queueMessageForBusySession(p, msg, msg.sessionKey)) return true
  }
  void state.agentSession.send(text, [], [])
    .then(() => {
      asReactionAdder(p)?.addReaction(msg.replyCtx, 'Done')
    })
    .catch((error: unknown) => {
      console.error(`ps: send failed: ${String(error)}`)
      void e.reply(p, msg.replyCtx, e.i18n.t(Msg.PsSendFailed))
    })
  return true
}
