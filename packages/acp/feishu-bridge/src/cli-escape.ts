/**
 * CLI text unescaping, ported from cc-connect core/cli_escape.go.
 *
 * @module dsh-feishu-bridge/cli-escape
 */

/**
 * Restore the backslash escapes agents commonly leave in CLI arguments.
 * Agents passing multi-line text as one shell argument often write "\n" for
 * newline — bash double quotes do not interpret it, and without restoration
 * ledger files / chat messages keep a literal `\n`. Handles \n \t \r \\;
 * unrecognized escapes (like `\*`) pass through unchanged.
 *
 * Ceiling: text that genuinely needs a literal backslash followed by a
 * letter (vanishingly rare in markdown prose) must escape as `\\`.
 * @param s - Raw CLI text.
 * @returns Text with recognized escapes restored.
 */
export function unescapeCLIText(s: string): string {
  let b = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '\\' && i + 1 < s.length) {
      switch (s.charAt(i + 1)) {
        case 'n':
          b += '\n'
          i++
          continue
        case 't':
          b += '\t'
          i++
          continue
        case 'r':
          b += '\r'
          i++
          continue
        case '\\':
          b += '\\'
          i++
          continue
      }
    }
    b += c
  }
  return b
}
