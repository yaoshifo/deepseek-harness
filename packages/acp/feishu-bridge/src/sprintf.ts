/**
 * Minimal Go `fmt.Sprintf` replacement for ported format strings.
 *
 * @module dsh-feishu-bridge/sprintf
 */

/**
 * Format a Go-style template. Supports the verbs the ported message tables
 * and builders use — %s, %d, %v, %q (string quoting), %w (treated as %s),
 * and %% — consuming args left to right.
 *
 * Simplification vs Go: a bare `%` not followed by a known verb passes
 * through unchanged (Go would print `%!(NOVERB)`); verb/type mismatches are
 * not diagnosed. Ported tables use literal `%` only as percent signs, where
 * pass-through is the intended reading.
 * @param template - Format string with Go verbs.
 * @param args - Values to substitute.
 * @returns The formatted string.
 */
export function sprintf(template: string, ...args: unknown[]): string {
  if (args.length === 0) {
    return template
  }
  let argIdx = 0
  return template.replace(/%([sdvqw%])/g, (_m, verb: string) => {
    if (verb === '%') {
      return '%'
    }
    if (argIdx >= args.length) {
      return `%!${verb}(MISSING)`
    }
    const arg = args[argIdx]
    argIdx++
    switch (verb) {
      case 'd':
        return String(Math.trunc(Number(arg)))
      case 'q':
        return JSON.stringify(String(arg))
      default:
        return String(arg)
    }
  })
}
