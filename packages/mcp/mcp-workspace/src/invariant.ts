/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mcp-workspace`.
 * @module @deepseek-ai/dsh-mcp-workspace/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-workspace'

/** Cordis companion plugin name. */
export const name = 'mcp-workspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: directory mounts register tools through the per-agent
 * tool-registry scope, and the service holds no independent server-to-tool
 * state beyond what that registry and the session header already record.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
