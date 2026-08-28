/**
 * Claude Code project-directory slug encoding.
 *
 * Claude Code derives each `~/.claude/projects/<slug>` directory name from the
 * session working directory by replacing every path separator and every dot
 * with a dash, preserving case and all other characters. Verified against
 * on-disk layouts such as `-home-hm--dsh-profiles-cc-connect`.
 *
 * @module @deepseek-ai/dsh-memory
 */

/** Path characters Claude Code folds into one dash each in project slugs. */
const SLUG_DASH = /[/.]/g

/**
 * Encode one absolute working directory as its Claude Code project slug.
 *
 * @param cwd - the session working directory; must be absolute POSIX.
 * @returns the slug naming the `~/.claude/projects` directory.
 */
export function claudeProjectSlug(cwd: string): string {
  if (cwd.length === 0) throw new TypeError('claude memory cwd must be a non-empty string')
  if (cwd.includes('\\') || !cwd.startsWith('/')) {
    throw new TypeError(`claude memory cwd must be an absolute POSIX path, got ${JSON.stringify(cwd)}`)
  }
  return cwd.replace(SLUG_DASH, '-')
}
