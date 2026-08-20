/**
 * The `/monitor` command family ported from cc-connect
 * core/engine_monitor_cmd.go: add/remove/list the current chat in the monitor
 * list at runtime plus `/monitor mode [dispatch|monitor]` (dispatch switches
 * brand the hub as the Mailroom). Registration lives here (not in
 * engine/commands.ts) so the M6b monitor domain cannot collide with parallel
 * work on that file; {@link registerMonitorCommands} merges into whatever
 * command table the engine already carries.
 *
 * @module dsh-feishu-bridge/monitor-commands
 */

import { Msg } from '../i18n/index.js'
import type { Message, Platform } from '../core/types.js'
import type { Engine } from './engine.js'
import { chatIDFromSessionKey } from './engine.js'
import {
  addMonitorChat,
  containsMonitorChat,
  removeMonitorChat,
  splitMonitorChats,
} from './monitor.js'

/**
 * Register the `/monitor` command family on an engine. Merges into an
 * existing command table (registerSessionCommands) instead of replacing it,
 * and chains the prefix resolver so `/monitor` and its ≥2-char prefixes
 * resolve while every other command keeps its current resolution. Returns
 * the disposer.
 */
export function registerMonitorCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('monitor', (p, msg, args) => { void cmdMonitor(e, p, msg, args); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'monitor' || (cmd.length >= 2 && 'monitor'.startsWith(cmd))) return 'monitor'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('monitor')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/** `/monitor mode [dispatch|monitor]` (Go cmdMonitorMode). */
async function cmdMonitorMode(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const tr = e.i18n
  if (args.length === 0) {
    let cur = e.monitor.modeVal()
    if (cur === '') cur = 'monitor'
    await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorModeCurrent, cur))
    return
  }
  const val = (args[0] ?? '').trim().toLowerCase()
  if (val !== 'dispatch' && val !== 'monitor') {
    await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorModeBad, val))
    return
  }
  const err = e.monitor.persistAndApplyMonitorMode(val)
  if (err !== undefined) {
    await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorSaveFailed, err))
    return
  }
  if (val === 'dispatch') {
    // dispatch hub one-liner: add the current chat to the monitor list and
    // brand it as the Mailroom. p2p / no chatID only switches the mode.
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    if (msg.chatType === 'p2p' || chatID === '') {
      await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorModeSet, val))
    } else {
      if (e.monitor.chatsVal() !== '*' && !containsMonitorChat(e.monitor.chatsVal(), chatID)) {
        const chatErr = e.monitor.persistAndApplyMonitorChats(addMonitorChat(e.monitor.chatsVal(), chatID))
        if (chatErr !== undefined) {
          await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorSaveFailed, chatErr))
          return
        }
      }
      e.monitor.brandDispatchChat(p, msg.sessionKey)
      await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorModeSetDispatchHub))
    }
    if (e.monitor.dirs.length === 0) {
      await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorModeNoDirs))
    }
    return
  }
  await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorModeSet, val))
}

/** `/monitor` dispatcher (Go cmdMonitor). */
export async function cmdMonitor(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const tr = e.i18n
  if (!e.monitor.enabled) {
    await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorDisabled))
    return
  }
  let sub = ''
  if (args.length > 0) sub = (args[0] ?? '').trim().toLowerCase()

  if (sub === 'list') {
    await replyMonitorList(e, p, msg)
    return
  }
  if (sub === 'mode') {
    await cmdMonitorMode(e, p, msg, args.slice(1))
    return
  }

  let chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
  if (msg.chatType === 'p2p') chatID = '' // p2p has no group chat to monitor
  switch (sub) {
    case '': case 'on': {
      if (chatID === '') {
        await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorNoChat))
        return
      }
      if (e.monitor.chatsVal() === '*') {
        await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorStarMode))
        return
      }
      if (containsMonitorChat(e.monitor.chatsVal(), chatID)) {
        await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorAlready))
        return
      }
      const newChats = addMonitorChat(e.monitor.chatsVal(), chatID)
      const err = e.monitor.persistAndApplyMonitorChats(newChats)
      if (err !== undefined) {
        await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorSaveFailed, err))
        return
      }
      await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorAdded))
      if (e.monitor.modeVal() === 'dispatch') {
        e.monitor.brandDispatchChat(p, msg.sessionKey)
      }
      return
    }
    case 'off': {
      if (chatID === '') {
        await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorNoChat))
        return
      }
      if (e.monitor.chatsVal() === '*') {
        await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorStarMode))
        return
      }
      if (!containsMonitorChat(e.monitor.chatsVal(), chatID)) {
        await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorNotInList))
        return
      }
      const newChats = removeMonitorChat(e.monitor.chatsVal(), chatID)
      const err = e.monitor.persistAndApplyMonitorChats(newChats)
      if (err !== undefined) {
        await e.reply(p, msg.replyCtx, tr.tf(Msg.MonitorSaveFailed, err))
        return
      }
      await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorRemoved))
      return
    }
    default:
      await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorUsage))
  }
}

/** The current monitor chats list (or "*" mode) as plain text (Go replyMonitorList). */
async function replyMonitorList(e: Engine, p: Platform, msg: Message): Promise<void> {
  const tr = e.i18n
  const chats = e.monitor.chatsVal()
  if (chats === '') {
    await e.reply(p, msg.replyCtx, tr.t(Msg.MonitorListEmpty))
    return
  }
  if (chats === '*') {
    await e.reply(p, msg.replyCtx, `${tr.t(Msg.MonitorListTitle)}: *`)
    return
  }
  const sb: string[] = [tr.t(Msg.MonitorListTitle), ':\n']
  splitMonitorChats(chats).forEach((c, i) => { sb.push(`${i + 1}. ${c}\n`) })
  await e.reply(p, msg.replyCtx, sb.join(''))
}
