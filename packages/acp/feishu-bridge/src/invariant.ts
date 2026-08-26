/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-feishu-bridge`.
 * @module @deepseek-ai/dsh-feishu-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-feishu-bridge'

/** Cordis companion plugin name. */
export const name = 'feishu-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge owns no durable package-local event stream —
 * it projects engine messages onto its in-memory EventChannel and the caller's
 * dsh session already owns the durable log it appends to. The opt-in
 * `mcpHealth` runtime context derives its text from the live tool registry at
 * each assembly (a view, not owned state), so it has no event relation to
 * check either.
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
