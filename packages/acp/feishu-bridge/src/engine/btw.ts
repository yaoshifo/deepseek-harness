/**
 * /btw ported from cc-connect core/engine_predict.go (Go cmdBtw): a side
 * question asked through a fork of the live session without polluting the
 * main conversation.
 *
 * @module dsh-feishu-bridge/btw
 */

import { asForkQuerierWithProvider, type Message, type Platform } from '../core/types.ts'
import { Msg } from '../i18n/index.ts'
import type { Engine } from './engine.ts'

/** /btw fork deadline (Go cmdBtw's 300s context). */
const btwTimeoutMs = 300_000

/**
 * Register the /btw command on an engine. Returns the disposer.
 *
 * @param e - Engine to register the command and resolver on.
 * @returns Disposer removing the handler and restoring the previous resolver.
 */
export function registerBtwCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('btw', (p, msg, args) => cmdBtw(e, p, msg, args))
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'btw' || (cmd.length >= 2 && 'btw'.startsWith(cmd))) return 'btw'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('btw')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/**
 * /btw: a side question forked off the session's transcript — the answer
 * never enters the main conversation (Go cmdBtw). Resolves the fork target
 * from the live session, falling back to the persisted session id so /btw
 * works after a restart or idle-reap; the fork runs in the session's
 * workdir (worktree, /spawn --dir override, or the project default).
 *
 * @param e - Engine carrying the sessions and interactive states.
 * @param p - Platform to reply on.
 * @param msg - The /btw command message.
 * @param args - Command arguments after /btw; the side question text.
 * @returns True (the command is always consumed).
 */
export function cmdBtw(e: Engine, p: Platform, msg: Message, args: string[]): boolean {
  let text = args.join(' ')
  if (msg.extraContent !== '') {
    text = text === '' ? msg.extraContent : `${msg.extraContent}\n${text}`
  }
  if (text === '') {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwEmpty))
    return true
  }

  const state = e.interactiveStates.get(msg.sessionKey)
  let sessionID = ''
  if (state?.agentSession !== undefined && state.agentSession.alive()) {
    sessionID = state.agentSession.currentSessionID()
  }
  if (sessionID === '') {
    const sid = e.sessions.activeSessionID(msg.sessionKey)
    if (sid !== '') {
      const sess = e.sessions.findByID(sid)
      if (sess !== undefined) sessionID = sess.getAgentSessionID()
    }
  }
  if (sessionID === '') {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwNoSession))
    return true
  }

  const fq = asForkQuerierWithProvider(e.agent)
  if (fq === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwNoSession))
    return true
  }
  // The session's workdir: worktree path, per-chat override, or ''.
  const active = e.sessions.getOrCreateActive(msg.sessionKey)
  const [wtPath] = active.getWorktreeInfo()
  const workDir = wtPath !== '' ? wtPath : e.perChatWorkDir(e.dirOverrideKey(msg.sessionKey))
  void (async () => {
    try {
      const resp = await Promise.race([
        fq.forkQuery(sessionID, text, workDir),
        new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, btwTimeoutMs) }),
      ])
      if (resp === 'timeout') {
        await e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwTimeout))
      } else if (resp !== '') {
        await e.reply(p, msg.replyCtx, resp)
      }
    } catch (error) {
      console.error(`btw: fork query failed: ${String(error)}`)
      await e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwSendFailed))
    }
  })()
  return true
}
