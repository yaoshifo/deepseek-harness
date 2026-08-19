/**
 * The `/bind` command family ported from cc-connect core/engine_cmd_relay.go
 * and the cmdBind block of engine_cmd_workspace.go: bind/remove/-project/
 * setup/status. Registration lives here (not engine/commands.ts) to keep the
 * M6 relay domain free of collisions with parallel work on that file.
 *
 * @module dsh-feishu-bridge/relay-commands
 */

import {
  MsgRelayBindNotFound,
  MsgRelayBindRemoved,
  MsgRelayBindSelf,
  MsgRelayBindSuccess,
  MsgRelayBound,
  MsgRelayNoBinding,
  MsgRelayNoTarget,
  MsgRelayNotAvailable,
  MsgRelayNotFound,
  MsgRelayUnbound,
  MsgRelayUsage,
  MsgSetupNative,
} from '../i18n/index.js'
import type { Message, Platform } from '../core/types.js'
import type { Engine } from './engine.js'
import { parseSessionKeyParts } from './relay.js'

/**
 * Register the `/bind` command family on an engine. Merges into an existing
 * command table instead of replacing it, and chains the prefix resolver the
 * way registerCronCommands does. Returns the disposer.
 */
export function registerRelayCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('bind', (p, msg, args) => { void cmdBind(e, p, msg, args); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'bind' || (cmd.length >= 2 && 'bind'.startsWith(cmd))) return 'bind'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('bind')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/**
 * `/bind` — establish a relay binding between bots in a group chat
 * (Go cmdBind):
 *
 * - `/bind <project>` — bind the current bot with another project in this chat
 * - `/bind remove` — remove all bindings for the group
 * - `/bind -<project>` — remove one project from the binding
 * - `/bind` — show the current binding status
 */
export async function cmdBind(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const rm = e.relayManager
  if (rm === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgRelayNotAvailable))
    return
  }

  let chatID: string
  try {
    chatID = parseSessionKeyParts(msg.sessionKey)[1]
  } catch {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgRelayNotAvailable))
    return
  }

  if (args.length === 0) {
    await cmdBindStatus(e, p, msg.replyCtx, chatID)
    return
  }

  const otherProject = args[0] ?? ''

  if (otherProject === 'remove' || otherProject === 'rm' || otherProject === 'unbind' || otherProject === 'del' || otherProject === 'clear') {
    rm.unbind(chatID)
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgRelayUnbound))
    return
  }

  if (otherProject === 'setup') {
    // The dsh agent receives its bridge instructions through the per-agent
    // setup hook (plan D3) rather than a memory file, so setup is native.
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgSetupNative))
    return
  }

  if (otherProject === 'help' || otherProject === '-h' || otherProject === '--help') {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgRelayUsage))
    return
  }

  if (otherProject.startsWith('-')) {
    const projectToRemove = otherProject.slice(1)
    if (rm.removeFromBind(chatID, projectToRemove)) {
      await e.reply(p, msg.replyCtx, e.i18n.tf(MsgRelayBindRemoved, projectToRemove))
    } else {
      await e.reply(p, msg.replyCtx, e.i18n.tf(MsgRelayBindNotFound, projectToRemove))
    }
    return
  }

  if (otherProject === e.name) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgRelayBindSelf))
    return
  }

  // Validate the target project exists.
  if (!rm.hasEngine(otherProject)) {
    const others = rm.listEngineNames().filter(n => n !== e.name)
    if (others.length === 0) {
      await e.reply(p, msg.replyCtx, e.i18n.tf(MsgRelayNoTarget, otherProject))
    } else {
      await e.reply(p, msg.replyCtx, e.i18n.tf(MsgRelayNotFound, otherProject, others.join(', ')))
    }
    return
  }

  // Add the current project and the target project to the binding.
  rm.addToBind(p.name(), chatID, e.name)
  rm.addToBind(p.name(), chatID, otherProject)

  const binding = rm.getBinding(chatID)
  const boundProjects = Object.keys(binding?.bots ?? {})

  await e.reply(p, msg.replyCtx, e.i18n.tf(MsgRelayBindSuccess, boundProjects.join(' ↔ '), otherProject, otherProject))
}

/** `/bind` with no args — the current binding status (Go cmdBindStatus). */
async function cmdBindStatus(e: Engine, p: Platform, replyCtx: unknown, chatID: string): Promise<void> {
  const rm = e.relayManager
  if (rm === undefined) return
  const binding = rm.getBinding(chatID)
  if (binding === undefined) {
    await e.reply(p, replyCtx, e.i18n.t(MsgRelayNoBinding))
    return
  }
  const parts = Object.keys(binding.bots)
  await e.reply(p, replyCtx, e.i18n.tf(MsgRelayBound, parts.join(' ↔ ')))
}
