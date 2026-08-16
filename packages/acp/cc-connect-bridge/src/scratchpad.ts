/**
 * The scratchpad runtime-context contribution: names the session-specific
 * temporary directory the Go backend provisions via `CC_SCRATCHPAD`, so
 * ad-hoc /tmp paths stop colliding across sessions and projects.
 *
 * @module cc-connect-bridge/scratchpad
 */

/**
 * Render the runtime-context text for the scratchpad directory.
 *
 * @param dir - the `CC_SCRATCHPAD` value as spawned (unset or empty
 * contributes nothing — older cc-connect backends do not set it).
 * @returns the context text, or `''` when there is no scratchpad to announce.
 */
export function scratchpadContextText(dir: string | undefined): string {
  if (dir === undefined || dir === '') return ''
  return `Scratchpad directory for this session: ${dir}\n`
    + 'Use it for ALL temporary files (intermediate results, one-off scripts, working outputs) '
    + 'instead of ad-hoc /tmp paths or the user\u2019s project directory. It is session-specific, '
    + 'isolated from the project, and disposable.'
}
