/**
 * The `/bind` command family ported from cc-connect core/engine_cmd_relay.go
 * and the cmdBind block of engine_cmd_workspace.go: bind/remove/-project/
 * setup/status. Registration lives here (not engine/commands.ts) to keep the
 * M6 relay domain free of collisions with parallel work on that file.
 *
 * @module dsh-feishu-bridge/relay-commands
 */

import { Msg } from '../i18n/index.js'
import type { Message, Platform } from '../core/types.js'
import type { Engine } from './engine.js'
import { parseSessionKeyParts } from './relay.js'

/**
 * Register the `/bind` command family on an engine through the
 * {@link Engine.registerCommand} seam (handler entry + chained prefix
 * resolver), the way registerCronCommands does. Requires the session command
 * table (registerSessionCommands) to be installed first.
 *
 * @param e - Engine whose command table and resolver receive the `/bind` family.
 * @returns Disposer that unregisters the commands and restores the previous resolver.
 */
export function registerRelayCommands(e: Engine): () => void {
  return e.registerCommand({
    id: 'bind',
    handler: (p, msg, args) => { void cmdBind(e, p, msg, args); return true },
    match: cmd => (cmd === 'bind' || ('bind'.startsWith(cmd) && cmd.length >= 2)) ? 'bind' : '',
  })
}

/**
 * `/bind` — establish a relay binding between bots in a group chat
 * (Go cmdBind):
 *
 * - `/bind <project>` — bind the current bot with another project in this chat
 * - `/bind remove` — remove all bindings for the group
 * - `/bind -<project>` — remove one project from the binding
 * - `/bind` — show the current binding status
 *
 * @param e - Engine whose relay manager holds the bindings.
 * @param p - Platform that received the command.
 * @param msg - The command message; its session key identifies the chat.
 * @param args - Command arguments after `/bind`.
 */
export async function cmdBind(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const rm = e.relayManager
  if (rm === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.RelayNotAvailable))
    return
  }

  let chatID: string
  try {
    chatID = parseSessionKeyParts(msg.sessionKey)[1]
  } catch {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.RelayNotAvailable))
    return
  }

  if (args.length === 0) {
    await cmdBindStatus(e, p, msg.replyCtx, chatID)
    return
  }

  const otherProject = args[0] ?? ''

  if (otherProject === 'remove' || otherProject === 'rm' || otherProject === 'unbind' || otherProject === 'del' || otherProject === 'clear') {
    rm.unbind(chatID)
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.RelayUnbound))
    return
  }

  if (otherProject === 'setup') {
    // The dsh agent receives its bridge instructions through the per-agent
    // setup hook (plan D3) rather than a memory file, so setup is native.
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.SetupNative))
    return
  }

  if (otherProject === 'help' || otherProject === '-h' || otherProject === '--help') {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.RelayUsage))
    return
  }

  if (otherProject.startsWith('-')) {
    const projectToRemove = otherProject.slice(1)
    if (rm.removeFromBind(chatID, projectToRemove)) {
      await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RelayBindRemoved, projectToRemove))
    } else {
      await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RelayBindNotFound, projectToRemove))
    }
    return
  }

  if (otherProject === e.name) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.RelayBindSelf))
    return
  }

  // Validate the target project exists.
  if (!rm.hasEngine(otherProject)) {
    const others = rm.listEngineNames().filter(n => n !== e.name)
    if (others.length === 0) {
      await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RelayNoTarget, otherProject))
    } else {
      await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RelayNotFound, otherProject, others.join(', ')))
    }
    return
  }

  // Add the current project and the target project to the binding.
  rm.addToBind(p.name(), chatID, e.name)
  rm.addToBind(p.name(), chatID, otherProject)

  const binding = rm.getBinding(chatID)
  const boundProjects = Object.keys(binding?.bots ?? {})

  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.RelayBindSuccess, boundProjects.join(' ↔ '), otherProject, otherProject))
}

/** `/bind` with no args — the current binding status (Go cmdBindStatus). */
async function cmdBindStatus(e: Engine, p: Platform, replyCtx: unknown, chatID: string): Promise<void> {
  const rm = e.relayManager
  if (rm === undefined) return
  const binding = rm.getBinding(chatID)
  if (binding === undefined) {
    await e.reply(p, replyCtx, e.i18n.t(Msg.RelayNoBinding))
    return
  }
  const parts = Object.keys(binding.bots)
  await e.reply(p, replyCtx, e.i18n.tf(Msg.RelayBound, parts.join(' ↔ ')))
}
