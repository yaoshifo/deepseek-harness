/**
 * Active-tag naming, ported from cc-connect core/interfaces.go (ActiveTagName
 * / ActiveTagNamer / activeTagNameFor). The full Platform interface lands
 * with the engine in M1; this module carries only the tag-name contract.
 *
 * @module dsh-feishu-bridge/active-tag
 */

/**
 * Default tenant tag applied to spawned groups to indicate they are in use.
 * Platforms that derive a per-app tag name (Feishu tenant tags are
 * name-unique per tenant and bound per-app) report theirs via
 * {@link ActiveTagNamer}.
 */
export const ACTIVE_TAG_NAME = '❤️'

/**
 * Implemented by platforms whose active-tag name is not the global default
 * (e.g. Feishu, where each bot owns a distinct heart variant because a
 * tenant can only have one app own the literal "❤️").
 */
export interface ActiveTagNamer {
  /** Return this platform's active-tag name. */
  activeTagName(): string
}

/**
 * Return the platform's own active-tag name, falling back to the global
 * default for platforms that do not implement {@link ActiveTagNamer}. Go's
 * interface type-assertion maps to this structural optional-method check.
 * @param p - Platform object (full Platform type arrives in M1).
 * @returns The effective active-tag name.
 */
export function activeTagNameFor(p: { activeTagName?: () => string }): string {
  if (typeof p.activeTagName === 'function') {
    const name = p.activeTagName()
    if (name !== '') {
      return name
    }
  }
  return ACTIVE_TAG_NAME
}
