/**
 * Local wall-clock prefixes for the daemon's console lines: launchd captures
 * stdout/stderr without any timing, so incident triage (2026-08-28
 * oc_b20512) had to cross-reference message IDs against session logs to
 * reconstruct when a card was sent or patched.
 *
 * @module dsh-feishu-bridge/log-timestamps
 */

/** Marker guarding against double installation across HMR reloads. */
const installed = Symbol('dsh-feishu-bridge/log-timestamps')

/** Local `YYYY-MM-DD HH:MM:SS` for the log prefix. */
function localTimestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Prefix every console.log/info/warn/error/debug line with the local
 * wall-clock timestamp. Idempotent: a plugin reload re-running apply()
 * must not stack a second prefix. Test spies installed after this wrapper
 * replace it wholesale and keep recording bare caller arguments.
 */
export function installLogTimestamps(): void {
  const c = console as typeof console & { [installed]?: boolean }
  if (c[installed] === true) return
  c[installed] = true
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(localTimestamp(), ...args)
    }
  }
}
