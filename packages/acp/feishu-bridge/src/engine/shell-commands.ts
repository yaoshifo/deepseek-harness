/**
 * The `/shell` command ported from cc-connect core/engine_cmd_workspace.go
 * cmdShell plus the "!" prefix shortcut from engine.go: run a shell command
 * in the session's working directory and reply the combined output. The
 * disabled_commands / user-role DisabledCmds gate and the multi-workspace
 * shared-binding work dir are not ported (MIGRATION.md E 群 C 类裁定);
 * the admin gate goes through the engine's privileged-command table.
 *
 * Registration lives here (not in engine/commands.ts) so this domain cannot
 * collide with parallel work on that file; {@link registerShellCommands}
 * merges into whatever command table the engine already carries.
 *
 * @module dsh-feishu-bridge/shell-commands
 */

import { spawn } from 'node:child_process'
import type { Message, Platform } from '../core/types.js'
import { Msg } from '../i18n/index.js'
import { gatePrivilegedCommand } from './commands.js'
import type { Engine } from './engine.js'

/** Go default: 60 * time.Second. */
const defaultShellTimeoutMs = 60_000

/** Go truncation: runes[:3997] + '...'. */
const shellOutputMaxRunes = 4000

/** Canonical names for the shell command (Go builtinCommands entry). */
const shellAliases = ['shell', 'sh', 'exec', 'run']

/**
 * Register the /shell command on an engine. Returns the disposer.
 * @param e - The engine whose command table and resolver to install on.
 * @returns The disposer removing the handler and restoring the resolver.
 */
export function registerShellCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('shell', (p, msg) => { void cmdShell(e, p, msg); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (shellAliases.some(n => n === cmd || (n.startsWith(cmd) && cmd.length >= 2))) return 'shell'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('shell')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/**
 * The "!" prefix shortcut: admin-gate then run the command like /shell
 * (Go engine.go "!" branch). Called after permission handling so "!yes"
 * answers a pending permission instead of reaching the shell.
 * @param e - The engine carrying the admin allowlist.
 * @param p - The platform that delivered the message.
 * @param msg - The triggering chat message.
 * @param shellCmd - The command text after the "!" prefix.
 */
export function runBangShell(e: Engine, p: Platform, msg: Message, shellCmd: string): void {
  if (gatePrivilegedCommand(e, 'shell', p, msg)) return
  void runShellCommand(e, p, msg, shellCmd, defaultShellTimeoutMs)
}

/**
 * /shell [--timeout <seconds>] <command>: run a shell command and reply the
 * output (Go cmdShell).
 * @param e - The engine owning the working directory resolution.
 * @param p - The platform that delivered the command.
 * @param msg - The triggering chat message; its content carries the raw line.
 */
async function cmdShell(e: Engine, p: Platform, msg: Message): Promise<void> {
  // msg.content keeps the raw line: the whitespace-split args the dispatcher
  // passes would collapse quoted spaces inside the command.
  let shellCmd = msg.content.replace(/^\S+\s*/, '').trim()
  if (shellCmd === '') {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ShellUsage))
    return
  }

  // Optional leading --timeout <seconds>; a failing parse leaves the flag in
  // the command (Go behavior).
  let timeoutMs = defaultShellTimeoutMs
  if (shellCmd.startsWith('--timeout ')) {
    const rest = shellCmd.slice('--timeout '.length)
    const idx = rest.indexOf(' ')
    if (idx > 0) {
      const secs = Number.parseInt(rest.slice(0, idx), 10)
      if (Number.isInteger(secs) && secs > 0) {
        timeoutMs = secs * 1000
        shellCmd = rest.slice(idx + 1).trim()
      }
    }
  }

  await runShellCommand(e, p, msg, shellCmd, timeoutMs)
}

/**
 * Execute the command via sh -c in the session working directory and reply
 * the combined output.
 * @param e - The engine providing commandWorkDir and the i18n catalog.
 * @param p - The platform the reply is sent to.
 * @param msg - The triggering chat message (reply context).
 * @param shellCmd - The shell command line to execute.
 * @param timeoutMs - Kill the process after this many milliseconds.
 */
async function runShellCommand(e: Engine, p: Platform, msg: Message, shellCmd: string, timeoutMs: number): Promise<void> {
  const workDir = e.commandWorkDir(msg)

  const ac = new AbortController()
  const timer = setTimeout(() => { ac.abort() }, timeoutMs)
  timer.unref()
  try {
    const outcome = await new Promise<{ out: string; err: string | undefined }>((resolve) => {
      let out = ''
      const child = spawn('sh', ['-c', shellCmd], { cwd: workDir === '' ? undefined : workDir, signal: ac.signal })
      child.stdout.on('data', (d: Buffer) => { out += d.toString() })
      child.stderr.on('data', (d: Buffer) => { out += d.toString() })
      child.on('error', (err: Error) => { resolve({ out, err: err.message }) })
      child.on('close', (code, signal) => {
        if (ac.signal.aborted) {
          resolve({ out, err: 'timed out' })
          return
        }
        resolve({ out, err: code === 0 ? undefined : `exit status ${code ?? signal}` })
      })
    })
    if (ac.signal.aborted) {
      // The message text keeps Go's frozen "(60s)" wording even for custom
      // --timeout values.
      await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.CommandTimeout, shellCmd))
      return
    }
    let result = outcome.out.trim()
    if (outcome.err !== undefined && result === '') result = outcome.err
    if (result === '') result = '(no output)'
    const runes = Array.from(result)
    if (runes.length > shellOutputMaxRunes) result = `${runes.slice(0, shellOutputMaxRunes - 3).join('')}...`
    await e.reply(p, msg.replyCtx, `$ ${shellCmd}\n\`\`\`\n${result}\n\`\`\``)
  } finally {
    clearTimeout(timer)
  }
}
