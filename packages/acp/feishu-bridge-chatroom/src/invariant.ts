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
 * No runtime invariant: the chatroom's mutable state (the featureState
 * section, armed barriers, pickers) lives inside the feishu-bridge engine's
 * session registry and is asserted where it is exercised — the codec
 * projection/carry specs and the gather/end/recovery suites pin it on every
 * save and reset path. The package observes no event stream of its own at
 * runtime (its `feishuBridge/*` listeners are payload functions whose
 * effects are the specs' subjects), so there is no authoritative stream this
 * companion could cross-check at boot.
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
