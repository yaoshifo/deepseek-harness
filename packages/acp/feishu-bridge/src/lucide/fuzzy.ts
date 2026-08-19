/**
 * Fuzzy-matching helpers for Lucide icon names, ported from cc-connect
 * core/lucide_fuzzy.go. Icon ids are ASCII (`[\w-]`), so UTF-16 string
 * lengths match the Go source's byte lengths.
 *
 * @module dsh-feishu-bridge/lucide-fuzzy
 */

/**
 * Return the edit-distance budget for an icon name: max(1, len(name)/4).
 * Short names (like `api`) tolerate one character to avoid correcting
 * invented words onto unrelated icons; long names (like `file-terminal`)
 * relax to 2-3 for common transpositions and omissions.
 * @param name - Requested icon id.
 * @returns Maximum tolerated Levenshtein distance.
 */
export function fuzzyThreshold(name: string): number {
  const n = Math.floor(name.length / 4)
  return n > 1 ? n : 1
}

/**
 * Standard Levenshtein edit distance (insert/delete/substitute), two-row
 * rolling implementation.
 * @param a - First string.
 * @param b - Second string.
 * @returns Edit distance between `a` and `b`.
 */
export function levenshtein(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j)
  let curr: number[] = new Array<number>(lb + 1).fill(0)
  for (let i = 1; i <= la; i++) {
    curr[0] = i
    for (let j = 1; j <= lb; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1
      let m = (prev[j] ?? 0) + 1 // deletion
      const ins = (curr[j - 1] ?? 0) + 1 // insertion
      if (ins < m) m = ins
      const sub = (prev[j - 1] ?? 0) + cost // substitution
      if (sub < m) m = sub
      curr[j] = m
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[lb] ?? 0
}

/**
 * Wrap a (arc-flag-normalized) Lucide symbol inner into a standalone,
 * rasterizable SVG. stroke-width 14 (not the Lucide default 2): on a 256px
 * canvas with the icon occupying the central 60%, a heavier stroke stays
 * legible.
 * @param inner - The symbol's inner markup.
 * @param strokeColor - Stroke (and currentColor replacement) color.
 * @returns Complete SVG document string.
 */
/**
 * Avatar stroke width in 24-unit viewBox coordinates. Go used 14 with its
 * oksvg rasterizer; librsvg (sharp) lays out materially thicker strokes, and
 * 14 fills the icon area into a solid white square (~95% coverage vs oksvg's
 * ~70%). oksvg-14 equivalence measured 6, but the user found that still too
 * chunky; 3 is the user-picked value (comparison strip sent in chat, 2026-08-19).
 */
const avatarStrokeWidth = 3

export function wrapIconSVG(inner: string, strokeColor: string): string {
  // currentColor in Lucide semantics is the icon foreground color — same as
  // the stroke — so replacing it keeps hole/dot fills (e.g. tag) rendering.
  const colored = inner.replaceAll('currentColor', strokeColor)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${strokeColor}" stroke-width="${avatarStrokeWidth}" stroke-linecap="round" stroke-linejoin="round">${colored}</svg>`
}

/**
 * Return abs(len(a) - len(b)).
 * @param a - First string.
 * @param b - Second string.
 * @returns Absolute difference of the two string lengths.
 */
export function absLen(a: string, b: string): number {
  const d = a.length - b.length
  return d < 0 ? -d : d
}
