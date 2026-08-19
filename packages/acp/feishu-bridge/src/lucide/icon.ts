/**
 * Lucide icon lookup by name, ported from cc-connect
 * core/engine_plan_render.go (LucideIconSVG + arc-flag normalization). Used
 * to render Lucide icons into Feishu group-avatar PNGs.
 *
 * @module dsh-feishu-bridge/lucide-icon
 */

import { absLen, fuzzyThreshold, levenshtein, wrapIconSVG } from './fuzzy.js'
import { iconsSpriteFull } from './sprite.js'

// (?s) in the Go symbolRe becomes [\s\S] here; ids are [\w-].
const symbolRe = /<symbol\s+id="([\w-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g

let iconIDCache: string[] | undefined

/**
 * All symbol ids in the Lucide sprite, lowercased (Go loadLucideIconIDs).
 * Scans the sprite once and caches; group-name icon sampling reads this.
 * @returns The cached id list.
 */
export function lucideIconIDs(): string[] {
  if (iconIDCache === undefined) {
    iconIDCache = []
    for (const sm of iconsSpriteFull.matchAll(symbolRe)) {
      iconIDCache.push((sm[1] ?? '').toLowerCase())
    }
  }
  return iconIDCache
}

// Matches a single numeric token in an SVG path: integer, decimal, negative,
// leading-dot decimal (.092), scientific notation (1e-5).
const arcNumRe = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g

/**
 * Normalize arc-flag separation inside every `d="..."` attribute so the
 * rasterizer can parse compact arc notation. See {@link normalizeArcFlags}.
 * @param inner - Symbol inner markup.
 * @returns Markup with each path's arc flags spaced.
 */
function normalizeArcFlagsInPaths(inner: string): string {
  return inner.replace(/\bd="([^"]*)"/gi, (_attr, d: string) => `d="${normalizeArcFlags(d)}"`)
}

/**
 * Apply {@link splitRepeatedArcs} to every `d="..."` attribute, without
 * touching letters elsewhere in the path tag (e.g. the "a" in "path").
 * @param inner - Symbol inner markup.
 * @returns Markup with repeated arcs split into standalone commands.
 */
function splitRepeatedArcsInPaths(inner: string): string {
  return inner.replace(/\bd="([^"]*)"/gi, (_attr, d: string) => `d="${splitRepeatedArcs(d)}"`)
}

/**
 * Whether a character is an SVG path command letter. 'e'/'E' belong to
 * scientific notation and do not count.
 * @param c - Single character.
 * @returns True when `c` starts a new path command.
 */
function isPathCmdLetter(c: string): boolean {
  switch (c) {
    case 'M': case 'm': case 'L': case 'l': case 'H': case 'h': case 'V': case 'v':
    case 'C': case 'c': case 'S': case 's': case 'Q': case 'q': case 'T': case 't':
    case 'A': case 'a': case 'Z': case 'z':
      return true
  }
  return false
}

/**
 * Split a single a/A command carrying more than 7 parameters (SVG implicit
 * arc repetition) into standalone a/A commands.
 *
 * Background (from the Go source): the rasterizer's AddArc reads the
 * large-arc/sweep/end-point from the first parameter group only, so an
 * implicitly repeated arc degenerates to zero length and does not draw
 * (message-circle-warning's bubble arc disappeared this way). One command
 * per group restores correct drawing; relative commands keep their geometry
 * because group 2 stays relative to group 1's end point. Only splits when
 * the parameter count is >7 and a multiple of 7; anything else passes
 * through unchanged.
 * @param d - Path data attribute value.
 * @returns Transformed path data.
 */
export function splitRepeatedArcs(d: string): string {
  if (!/[aA]/.test(d)) {
    return d
  }
  let b = ''
  let i = 0
  const n = d.length
  while (i < n) {
    const c = d.charAt(i)
    if (c !== 'a' && c !== 'A') {
      b += c
      i++
      continue
    }
    // This a/A command's parameter segment ends at the next path command
    // letter or end of string ('e'/'E' do not count as commands).
    let j = i + 1
    while (j < n && !isPathCmdLetter(d.charAt(j))) {
      j++
    }
    b += c
    const tokens = d.slice(i + 1, j).match(arcNumRe) ?? []
    if (tokens.length > 7 && tokens.length % 7 === 0) {
      for (const [k, tok] of tokens.entries()) {
        if (k > 0 && k % 7 === 0) {
          b += ' '
          b += c // re-emit the command letter before each new group
        }
        b += ' '
        b += tok
      }
    } else {
      b += d.slice(i + 1, j) // not a multi-group arc: keep original spacing
    }
    i = j
  }
  return b
}

/**
 * Normalize the separation of the A/a (arc) command's flag parameters in a
 * path `d` value.
 *
 * SVG allows compact flags — large-arc-flag and sweep-flag are single
 * characters that may be glued to adjacent digits, as in "A2 2 0 0022 17".
 * The rasterizer cannot parse that form and drops the whole path, which
 * turned book-open's avatar into a lone vertical bar. Reads each A/a's 7
 * parameters (rx ry rot flag flag x y), flags as single characters, and
 * re-emits one space between parameters. Non-arc commands pass through.
 * @param d - Path data attribute value.
 * @returns Transformed path data.
 */
export function normalizeArcFlags(d: string): string {
  let b = ''
  let i = 0
  const n = d.length
  const isSep = (c: string): boolean => c === ' ' || c === ',' || c === '\t' || c === '\n' || c === '\r'
  const isDigit = (c: string): boolean => c >= '0' && c <= '9'
  const isNumStart = (c: string): boolean => isDigit(c) || c === '+' || c === '-' || c === '.'
  const readNumber = (): string => {
    while (i < n && isSep(d.charAt(i))) {
      i++
    }
    const start = i
    if (i < n && (d.charAt(i) === '+' || d.charAt(i) === '-')) {
      i++
    }
    while (i < n && isDigit(d.charAt(i))) {
      i++
    }
    if (i < n && d.charAt(i) === '.') {
      i++
      while (i < n && isDigit(d.charAt(i))) {
        i++
      }
    }
    if (i < n && (d.charAt(i) === 'e' || d.charAt(i) === 'E')) {
      i++
      if (i < n && (d.charAt(i) === '+' || d.charAt(i) === '-')) {
        i++
      }
      while (i < n && isDigit(d.charAt(i))) {
        i++
      }
    }
    return d.slice(start, i)
  }
  while (i < n) {
    const c = d.charAt(i)
    if (c === 'A' || c === 'a') {
      b += c
      i++
      for (let set = 0; set < 7; set++) {
        while (i < n && isSep(d.charAt(i))) {
          i++
        }
        if (i >= n) {
          break
        }
        if (set === 3 || set === 4) {
          // flag: single character 0 or 1
          if (d.charAt(i) !== '0' && d.charAt(i) !== '1') {
            break
          }
          b += ' '
          b += d.charAt(i)
          i++
        } else {
          if (!isNumStart(d.charAt(i))) {
            break
          }
          b += ' '
          b += readNumber()
        }
      }
    } else {
      b += c
      i++
    }
  }
  return b
}

/**
 * Look up an icon by name in the full Lucide sprite, wrap its symbol inner
 * into a standalone SVG (fill=none / stroke / stroke-width / line cap+join
 * applied — symbols carry only path data), and normalize arc flags. Used to
 * rasterize Lucide icons for Feishu group avatars.
 *
 * On exact miss, a restricted edit-distance fuzzy fallback corrects
 * misspelled names (missing letters/transpositions) to the nearest valid id;
 * beyond the threshold or with too-large length difference it gives up (the
 * caller keeps the default avatar). The Go source logged debug lines for
 * both outcomes; logging moves to the caller when the engine lands.
 * @param name - Icon name (case-insensitive, trimmed).
 * @param strokeColor - Stroke color; empty uses the default #1f2329 (dark
 * grey, visible on Feishu's light UI).
 * @returns The SVG document, or undefined when no icon matches.
 */
export function lucideIconSVG(name: string, strokeColor: string): string | undefined {
  const key = name.trim().toLowerCase()
  if (key === '') {
    return undefined
  }
  const stroke = strokeColor === '' ? '#1f2329' : strokeColor
  for (const sm of iconsSpriteFull.matchAll(symbolRe)) {
    if ((sm[1] ?? '').toLowerCase() === key) {
      return wrapIconSVG(splitRepeatedArcsInPaths(normalizeArcFlagsInPaths(sm[3] ?? '')), stroke)
    }
  }
  // Exact miss: fuzzy fallback.
  const threshold = fuzzyThreshold(key)
  let bestInner = ''
  let bestDist = threshold + 1
  for (const sm of iconsSpriteFull.matchAll(symbolRe)) {
    const id = (sm[1] ?? '').toLowerCase()
    if (absLen(id, key) > threshold) {
      continue // length gap alone already exceeds the budget; skip the work
    }
    const dist = levenshtein(key, id)
    if (dist < bestDist) {
      bestDist = dist
      bestInner = sm[3] ?? ''
    }
  }
  if (bestDist <= threshold) {
    return wrapIconSVG(splitRepeatedArcsInPaths(normalizeArcFlagsInPaths(bestInner)), stroke)
  }
  return undefined
}
