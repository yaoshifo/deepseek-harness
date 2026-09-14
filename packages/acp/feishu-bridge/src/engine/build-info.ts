/**
 * Daemon build identity: what the running process loaded (start time, lib
 * mtimes, HEAD at start), captured once per daemon boot, and the drift lines
 * computed against the live disk/git state. The /status build row and the
 * /reload completion notice both render from here, so a daemon left behind by
 * a rebuild or new commits is visible without assembling evidence by hand
 * (2026-09-14: a daemon two days stale passed as reloaded).
 *
 * @module dsh-feishu-bridge/engine-build-info
 */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { I18n } from '../i18n/index.ts'
import { Msg } from '../i18n/index.ts'

const execFileP = promisify(execFile)

/** Git probe timeout: local rev-parse runs in milliseconds; the bound only caps a wedged git. */
const gitTimeoutMs = 2000

/** Directory git probes run in: this module's own directory (a repo checkout or worktree). */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** Build identity captured once per daemon boot. */
export interface BuildInfo {
  /** Epoch ms when the capture ran (≈ daemon start). */
  startedAt: number
  /** mtime of the loaded plugin dist file at capture time; undefined when unstatable. */
  libMtime: number | undefined
  /** mtime of the daemon entry (process.argv[1]) at capture time; undefined when unstatable. */
  entryMtime: number | undefined
  /** HEAD sha at capture time; '' when the package is not a git checkout. */
  headSha: string
}

/**
 * Live-state probe the drift lines read. Injectable white-box so specs stay
 * deterministic; the default reads the real disk and git.
 */
export interface BuildProbe {
  /** mtimes of the watched files right now. */
  statWatched: () => { lib: number | undefined; entry: number | undefined }
  /** Current HEAD sha; '' when git is unavailable. */
  gitHead: () => Promise<string>
  /** Commits in {@link BuildInfo.headSha}..HEAD; undefined when not computable. */
  countBetween: (fromSha: string, toSha: string) => Promise<number | undefined>
}

/** @internal White-box: captured state (tests inject). */
let captured: BuildInfo | undefined
/** @internal White-box: live probe (tests inject). */
let probe: BuildProbe | undefined

/**
 * @internal White-box test injection for the captured build identity;
 * undefined restores the uncaptured state (startup before capture).
 */
export function setBuildInfoForTest(info: BuildInfo | undefined): void {
  captured = info
}

/**
 * @internal White-box test injection for the live-state probe; undefined
 * restores the real disk/git probe.
 */
export function setBuildProbeForTest(p: BuildProbe | undefined): void {
  probe = p
}

/**
 * Capture the daemon's build identity once per boot: mtimes of the files this
 * process actually loaded and the git HEAD beside them. Best-effort — a
 * missing file or unusable git degrades that field, never the daemon.
 */
export async function captureBuildInfo(): Promise<void> {
  const modulePath = fileURLToPath(import.meta.url)
  captured = {
    startedAt: Date.now(),
    libMtime: mtimeOf(modulePath),
    entryMtime: process.argv[1] !== undefined ? mtimeOf(process.argv[1]) : undefined,
    headSha: await gitHeadIn(moduleDir),
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return Math.round(statSync(path).mtimeMs)
  } catch {
    return undefined
  }
}

async function gitHeadIn(cwd: string): Promise<string> {
  try {
    return (await execFileP('git', ['rev-parse', 'HEAD'], { cwd, timeout: gitTimeoutMs })).stdout.trim()
  } catch {
    return ''
  }
}

/** Default probe reading the same paths and repo the capture saw. */
const realProbe: BuildProbe = {
  statWatched: () => {
    const modulePath = fileURLToPath(import.meta.url)
    return {
      lib: mtimeOf(modulePath),
      entry: process.argv[1] !== undefined ? mtimeOf(process.argv[1]) : undefined,
    }
  },
  gitHead: () => gitHeadIn(moduleDir),
  countBetween: async (fromSha, toSha) => {
    try {
      const out = await execFileP('git', ['rev-list', '--count', `${fromSha}..${toSha}`],
        { cwd: moduleDir, timeout: gitTimeoutMs })
      return Number.parseInt(out.stdout.trim(), 10)
    } catch {
      return undefined
    }
  },
}

function shortSha(sha: string): string {
  return sha === '' ? '-' : sha.slice(0, 10)
}

/** `9-12 16:03` — local wall-clock, day-precision is enough for build age. */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Build/drift lines for /status and the reload completion notice. The summary
 * line names the loaded build; drift lines appear only when the disk build is
 * newer than the loaded one or HEAD moved since the capture.
 *
 * @param i18n - Locale renderer for the line templates.
 * @returns Rendered lines; empty when no build identity was captured.
 */
export async function buildStatusLines(i18n: I18n): Promise<string[]> {
  if (captured === undefined) return []
  const lines = [i18n.tf(Msg.StatusBuild, fmtTime(captured.startedAt),
    captured.libMtime === undefined ? '-' : fmtTime(captured.libMtime), shortSha(captured.headSha))]
  const liveProbe = probe ?? realProbe
  const live = liveProbe.statWatched()
  const watched: Array<[number | undefined, number | undefined]> = [
    [captured.libMtime, live.lib],
    [captured.entryMtime, live.entry],
  ]
  if (watched.some(([loaded, now]) => loaded !== undefined && now !== undefined && now > loaded + 1000)) {
    const newest = Math.max(live.lib ?? 0, live.entry ?? 0)
    lines.push(i18n.tf(Msg.StatusBuildDiskNewer, fmtTime(newest)))
  }
  if (captured.headSha !== '') {
    const currentSha = await liveProbe.gitHead()
    if (currentSha !== '' && currentSha !== captured.headSha) {
      const count = await liveProbe.countBetween(captured.headSha, currentSha)
      lines.push(i18n.tf(Msg.StatusBuildHeadMoved, shortSha(currentSha), count === undefined ? '?' : String(count)))
    }
  }
  return lines
}
