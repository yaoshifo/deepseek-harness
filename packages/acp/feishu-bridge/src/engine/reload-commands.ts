/**
 * The `/reload` command: rebuild the host face and restart the daemon — the
 * chat-side entry to reload.sh (TS-native; no Go counterpart). The handler
 * spawns the script detached (setsid) so it survives the daemon teardown it
 * itself causes, with FB_RELOAD_FROM_DAEMON=1 skipping only the script's
 * ppid-walk guard (which would otherwise false-positive on the live daemon
 * ancestor); the DSH_SESSION_JSONL guard still refuses daemon-hosted agent
 * sessions that reach for the variable manually.
 *
 * Ceiling: when the script fails after the daemon has already restarted
 * (e.g. the Feishu WS probe times out), this process is gone and only
 * feishu-bridge-reload.log records the failure — no chat reply is possible
 * for that window.
 *
 * Registration lives here (not in engine/commands.ts) so this domain cannot
 * collide with parallel work on that file; {@link registerReloadCommands}
 * merges into whatever command table the engine already carries.
 *
 * @module dsh-feishu-bridge/reload-commands
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Msg } from '../i18n/index.js'
import type { Message, Platform } from '../core/types.js'
import type { Engine } from './engine.js'

/**
 * Register the /reload command on an engine. Returns the disposer.
 * @param e - The engine whose command table and resolver to install on.
 * @returns The disposer removing the handler and restoring the resolver.
 */
export function registerReloadCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('reload', (p, msg, args) => { void cmdReload(e, p, msg, args); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  // Exact match only: '/re' and '/rel' collide with /rename and /relay in
  // the chained resolver, so prefix resolution would shadow them.
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'reload') return 'reload'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('reload')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/** reload.sh candidate locations across build layouts: '../../reload.sh' for
 * the source/tsc layout (src/engine/<file>), '../reload.sh' for the tsdown
 * bundle (lib/index.js inlines every engine module, so import.meta.url is the
 * bundle file itself). */
const scriptCandidates = ['../../reload.sh', '../reload.sh']

/**
 * Locate reload.sh from a module URL across the package's build layouts.
 * @param fromURL - Module URL to resolve against (defaults to this module's).
 * @returns The existing script path, or the last candidate when no layout
 * matches (an installed bundle without the script — the path reported in the
 * error reply; under the bundle layout it names the package root).
 */
export function resolveReloadScript(fromURL: string | URL = import.meta.url): string {
  let miss = ''
  for (const rel of scriptCandidates) {
    const path = fileURLToPath(new URL(rel, fromURL))
    if (existsSync(path)) return path
    miss = path
  }
  return miss
}

/** In-flight reload: set at spawn, cleared on script exit; a daemon restart resets it with the process. */
let reloading = false

/**
 * /reload [--skip-build]: spawn reload.sh detached and restart the daemon on
 * the latest build (the same effect as running the script from a plain
 * terminal).
 * @param e - The engine (replies and i18n only; the script self-locates).
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message.
 * @param args - Optional --skip-build, passed through to the script.
 */
async function cmdReload(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const scriptPath = resolveReloadScript()
  const scriptArgs: string[] = []
  for (const a of args) {
    if (a === '--skip-build') {
      scriptArgs.push(a)
      continue
    }
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ReloadUsage))
    return
  }

  if (!existsSync(scriptPath)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ReloadScriptMissing, scriptPath))
    return
  }
  if (reloading) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ReloadInProgress))
    return
  }

  const logPath = join(process.env.LOG_DIR ?? join(process.env.HOME ?? '', '.dsh'), 'feishu-bridge-reload.log')
  // Reply before spawning: --skip-build restarts the daemon within seconds,
  // and a post-restart reply would never arrive.
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ReloadStarted, logPath))

  reloading = true
  let logFd: number | undefined
  try {
    logFd = openSync(logPath, 'a')
    const who = msg.userName !== '' ? msg.userName : msg.userID
    writeSync(logFd, `\n==> /reload by ${who} at ${new Date().toISOString()}\n`)
  } catch (error) {
    // The reload is worth more than its log; continue with output discarded.
    logFd = undefined
    console.warn(`/reload: cannot open ${logPath}; continuing with output discarded: ${String(error)}`)
  }
  const child = spawn('sh', [scriptPath, ...scriptArgs], {
    detached: true,
    stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    env: { ...process.env, FB_RELOAD_FROM_DAEMON: '1' },
  })
  if (logFd !== undefined) closeSync(logFd)
  child.unref()

  const finish = (code: number): void => {
    reloading = false
    // A non-zero exit reaches this listener only when the script died before
    // unloading the daemon (build error, missing plist, spawn failure);
    // after a restart the listener died with the old process and the log is
    // the only record.
    if (code === 0) return
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ReloadFailed, code, logPath))
  }
  child.on('exit', (code) => { finish(code ?? -1) })
  child.on('error', () => { finish(-1) })
}
