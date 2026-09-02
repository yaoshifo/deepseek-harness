/**
 * The `/reload` command: rebuild the host face and restart the daemon — the
 * chat-side entry to reload.sh (TS-native; no Go counterpart). The handler
 * spawns the script detached so it survives the daemon teardown it itself
 * causes — directly with setsid on macOS, and through a `systemd-run --user
 * --scope` sibling unit on Linux, where setsid alone stays in the daemon
 * unit's cgroup and dies to the restart's control-group kill (2026-08-22).
 * FB_RELOAD_FROM_DAEMON=1 skips only the script's ppid-walk guard (which
 * would otherwise false-positive on the live daemon ancestor); the
 * DSH_SESSION_JSONL guard still refuses daemon-hosted agent sessions that
 * reach for the variable manually.
 *
 * Completion notice: the handler drops a pending-marker file before the
 * spawn, and the restarted daemon calls {@link completePendingReload} once
 * its platforms are live — the notice is delivered by the new process, whose
 * ability to send it is itself the proof the restart landed. Ceiling: a
 * failure that only appears after the restart (e.g. the WS probe timing out)
 * still cannot produce a chat failure reply — only
 * feishu-bridge-reload.log records it.
 *
 * Registration lives here (not in engine/commands.ts) so this domain cannot
 * collide with parallel work on that file; {@link registerReloadCommands}
 * merges into whatever command table the engine already carries.
 *
 * @module dsh-feishu-bridge/reload-commands
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Msg } from '../i18n/index.ts'
import { mcpToolCounts } from '../core/mcp-health.ts'
import type { Message, Platform } from '../core/types.ts'
import type { Engine } from './engine.ts'

/**
 * Register the /reload command on an engine through the
 * {@link Engine.registerCommand} seam. Requires the session command table
 * (registerSessionCommands) to be installed first.
 * @param e - The engine whose command table and resolver to install on.
 * @returns The disposer removing the handler and restoring the resolver.
 */
export function registerReloadCommands(e: Engine): () => void {
  return e.registerCommand({
    id: 'reload',
    handler: (p, msg, args) => { void cmdReload(e, p, msg, args); return true },
    // Exact match only: '/re' and '/rel' collide with /rename and /relay in
    // the chained resolver, so prefix resolution would shadow them.
    match: cmd => cmd === 'reload' ? 'reload' : '',
  })
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

/** Resolve the daemon's log directory for reload artifacts ($LOG_DIR, default ~/.dsh). */
function reloadLogDir(): string {
  return process.env.LOG_DIR ?? join(process.env.HOME ?? '', '.dsh')
}

/** On-disk record of an in-flight /reload, consumed by the restarted daemon. */
interface ReloadPendingMarker {
  /** PID of the daemon that started the reload — the notice fires only when it differs (a real restart, not an HMR re-apply). */
  pid: number
  /** Name of the engine (project) that handled the command — disambiguates platforms, which all default to 'feishu' when untagged. */
  engine: string
  /** Name of the platform that delivered the /reload command (Platform.name()). */
  platform: string
  /** The triggering message's reply context, round-tripped so the notice lands as a reply to the /reload message. */
  replyCtx: unknown
  /** Epoch ms when the reload started. */
  at: number
}

/** Marker freshness window: the build takes minutes, the restart seconds; a marker older than this is stale. */
const PENDING_TTL_MS = 15 * 60_000

/**
 * MCP tool-count line above which the completion notice is followed by a
 * surface reminder. Evidence (2026-09-02 session-log scan of the live
 * daemon): resident servers carry 5 tools; 13 were carried for days without
 * complaint; one server mounting 71 tools pushed requests to ~25k tokens of
 * tool schema across 115 sessions before being unmounted by hand.
 */
const MCP_SURFACE_REMINDER_ABOVE_TOOLS = 20

/** The process-global tool view the reminder counts; only `name` is read. */
export interface GlobalToolView {
  /** Tool schemas in the global view (mcp-client rows register at profile root). */
  schemas(): Array<{ name: string }>
}

/**
 * Follow the completion notice with an MCP surface reminder when the global
 * tool view carries more than {@link MCP_SURFACE_REMINDER_ABOVE_TOOLS}
 * mcp-client tools: the total plus the per-server breakdown, heaviest first.
 * Any failure — registry read or send — is contained: the reminder must
 * never affect the completion notice or the marker cleanup.
 *
 * @param platform - The platform that delivered the /reload command.
 * @param engine - The engine whose i18n renders the reminder.
 * @param replyCtx - The recorded reply context of the /reload message.
 * @param tools - The process-global tool view.
 */
async function sendMcpSurfaceReminder(
  platform: Platform,
  engine: Engine,
  replyCtx: unknown,
  tools: GlobalToolView,
): Promise<void> {
  try {
    const counts = mcpToolCounts(tools.schemas().map(schema => schema.name))
    if (counts.total <= MCP_SURFACE_REMINDER_ABOVE_TOOLS) return
    const breakdown = [...counts.byServer].map(([server, count]) => `${server} ${String(count)}`).join(' · ')
    await platform.send(replyCtx, engine.i18n.tf(Msg.ReloadMcpSurfaceReminder, String(counts.total), breakdown))
  } catch (error) {
    console.warn(`/reload: MCP surface reminder failed: ${String(error)}`)
  }
}

function pendingPath(): string {
  return join(reloadLogDir(), 'feishu-bridge-reload-pending.json')
}

/**
 * Deliver the completion notice for a /reload that restarted this process.
 * Called once per daemon start, after every engine's platforms are live:
 * with no marker it is a plain start; with the current process's own marker
 * it is an HMR re-apply while the reload is still in flight (leave the
 * marker for the real restart); any other fresh marker means this process is
 * the reload's replacement — send the notice through the recorded engine's
 * platform and clear the marker. Every consumed path deletes it, so one
 * daemon start produces at most one notice. Known gap: an unrelated
 * crash-restart during a reload's build also delivers the notice (the daemon
 * did restart; the wording claims nothing beyond that — details stay in the
 * reload log).
 *
 * @param engines - The daemon's live engines; the recorded (engine,
 * platform) pair is looked up among them — both names, because tagless
 * deployments name every platform 'feishu'.
 * @param tools - The process-global tool view for the MCP surface reminder.
 */
export async function completePendingReload(engines: readonly Engine[], tools: GlobalToolView): Promise<void> {
  const path = pendingPath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return // no marker: a plain daemon start
  }
  let marker: ReloadPendingMarker
  try {
    // Durable-boundary validation: only the primitives are checked; the
    // opaque replyCtx is validated by Platform.send's requireReplyCtx.
    const parsed = JSON.parse(raw) as Partial<ReloadPendingMarker>
    if (typeof parsed.pid !== 'number' || typeof parsed.engine !== 'string' || typeof parsed.platform !== 'string' || typeof parsed.at !== 'number') {
      throw new Error('marker field shape mismatch')
    }
    marker = { pid: parsed.pid, engine: parsed.engine, platform: parsed.platform, replyCtx: parsed.replyCtx, at: parsed.at }
  } catch (error) {
    console.warn(`/reload: dropping unreadable completion marker ${path}: ${String(error)}`)
    rmSync(path, { force: true })
    return
  }
  if (marker.pid === process.pid) return // HMR re-apply mid-reload; the restart (and the notice) is still ahead
  try {
    if (Date.now() - marker.at > PENDING_TTL_MS) {
      console.warn(`/reload: dropping stale completion marker ${path} (started ${String(marker.at)})`)
    } else {
      // Two-level lookup (engine name, then platform name): the handler ran
      // with p ∈ engine.platforms and that bot is in the chat, so this
      // reproduces the exact sender of the "started" reply. A name-only
      // platform match picks the first 'feishu' platform in a tagless
      // multi-project deployment — a bot outside the chat, which Feishu
      // rejects with 230002 (2026-08-22 dev incident).
      const engine = engines.find(e => e.name === marker.engine)
      const platform = engine?.platforms.find(p => p.name() === marker.platform)
      if (engine === undefined || platform === undefined) {
        console.warn(`/reload: completion marker names unknown engine ${marker.engine} or platform ${marker.platform}; dropping it`)
      } else {
        await platform.send(marker.replyCtx, engine.i18n.tf(Msg.ReloadCompleted, join(reloadLogDir(), 'feishu-bridge-reload.log')))
        await sendMcpSurfaceReminder(platform, engine, marker.replyCtx, tools)
      }
    }
  } catch (error) {
    // A failed send (e.g. the /reload message was withdrawn) must not
    // resurrect the notice on the next daemon start.
    console.warn(`/reload: completion notice failed: ${String(error)}`)
  }
  rmSync(path, { force: true })
}

/**
 * Spawn command and argv for a detached reload.sh on the given platform.
 *
 * On Linux, `spawn(detached: true)` only setsids the child — it stays in the
 * daemon unit's cgroup, and `systemctl --user restart` (KillMode=control-group)
 * kills the whole cgroup, taking the script down mid-restart (the 2026-08-22
 * dev outage: the restart landed but the script died before its WS probe and
 * reported a false failure). A transient scope unit is a sibling of the daemon
 * unit, outside its cgroup; `systemd-run` waits for the command, so exit-code
 * reporting is unchanged. `--collect` garbage-collects the scope on exit; no
 * fixed `--unit` name, so a leftover scope cannot collide. On macOS, launchd
 * teardown leaves a setsid child alone, so the script spawns directly.
 *
 * @param platform - The platform to build the spawn for (the daemon's own).
 * @param scriptPath - The located reload.sh path.
 * @param scriptArgs - Arguments to pass through (e.g. --skip-build).
 * @returns The command and its full argument list for `spawn`.
 */
export function reloadSpawnArgv(platform: NodeJS.Platform, scriptPath: string, scriptArgs: string[]): { cmd: string; args: string[] } {
  if (platform === 'linux') {
    return { cmd: 'systemd-run', args: ['--user', '--scope', '--collect', 'sh', scriptPath, ...scriptArgs] }
  }
  return { cmd: 'sh', args: [scriptPath, ...scriptArgs] }
}

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

  const logPath = join(reloadLogDir(), 'feishu-bridge-reload.log')
  // Reply before spawning: --skip-build restarts the daemon within seconds,
  // and a post-restart reply would never arrive.
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ReloadStarted, logPath))

  reloading = true
  // The restarted daemon reads this marker to deliver the completion notice
  // (completePendingReload); a failure reply here clears it.
  const marker: ReloadPendingMarker = { pid: process.pid, engine: e.name, platform: p.name(), replyCtx: msg.replyCtx, at: Date.now() }
  try {
    writeFileSync(pendingPath(), JSON.stringify(marker))
  } catch (error) {
    // The reload is worth more than its notice; continue without one.
    console.warn(`/reload: cannot write ${pendingPath()}; completion will not be notified: ${String(error)}`)
  }
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
  const spawnArgv = reloadSpawnArgv(process.platform, scriptPath, scriptArgs)
  const child = spawn(spawnArgv.cmd, spawnArgv.args, {
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
    // The daemon survived, so no new process will ever consume the pending
    // marker — clear it or the next unrelated daemon start would notify.
    rmSync(pendingPath(), { force: true })
    void e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ReloadFailed, code, logPath))
  }
  child.on('exit', (code) => { finish(code ?? -1) })
  child.on('error', () => { finish(-1) })
}
