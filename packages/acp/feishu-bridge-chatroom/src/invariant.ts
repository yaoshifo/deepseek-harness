/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-feishu-bridge-chatroom`.
 * @module @deepseek-ai/dsh-feishu-bridge-chatroom/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-feishu-bridge-chatroom'

/** Cordis companion plugin name. */
export const name = 'feishu-bridge-chatroom-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the skeleton owns no event stream or mutable data —
 * the chatroom state (role groups, armed pickers) stays owned by the
 * feishu-bridge engine until the migration moves it here, and this companion
 * is re-evaluated when that ownership actually transfers.
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
