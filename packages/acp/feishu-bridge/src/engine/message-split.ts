/**
 * Message splitting and NO_REPLY stripping shared by the engine send path
 * and the streaming preview (Go core/engine.go constants, engine_relay.go
 * SplitMessage, engine_cmd_misc.go stripTrailingSilent). Extracted so the
 * streaming module can use them without importing the engine.
 *
 * @module dsh-feishu-bridge/engine-message-split
 */

/** Max message length per platform send (Go MaxPlatformMessageLen, runes). */
export const MaxPlatformMessageLen = 4000

/**
 * Split a message into rune-safe chunks of at most maxLen code points,
 * preferring a newline boundary in the back half of each window.
 *
 * @param text - Message text to split; text within the limit is returned as-is.
 * @param maxLen - Maximum chunk length in Unicode code points.
 * @returns The chunks in order; never empty.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  const runes = Array.from(text)
  if (runes.length <= maxLen) return [text]
  const chunks: string[] = []
  let rest = runes
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest.join(''))
      break
    }
    let end = maxLen
    const candidate = rest.slice(0, end).join('')
    const idx = candidate.lastIndexOf('\n')
    if (idx > 0) {
      const runeIdx = Array.from(candidate.slice(0, idx)).length
      if (runeIdx >= Math.floor(end / 2)) end = runeIdx + 1
    }
    chunks.push(rest.slice(0, end).join(''))
    rest = rest.slice(end)
  }
  return chunks
}

/**
 * Remove a trailing NO_REPLY marker; returns [strippedText, occurred].
 *
 * @param text - Message text that may end with a NO_REPLY marker.
 * @returns The text with the marker and trailing whitespace removed, and whether a marker was present.
 */
export function stripTrailingSilent(text: string): [string, boolean] {
  const stripped = text.replace(/(?:^|\s+|\*+)NO_REPLY\s*$/i, '')
  if (stripped === text) return [text, false]
  return [stripped.replace(/[ \t\r\n]+$/, ''), true]
}
