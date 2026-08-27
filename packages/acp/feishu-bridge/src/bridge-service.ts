/**
 * The feishu-bridge service face: the live project registry, caller routing,
 * and the `feishuBridge/*` dispatch seam sibling plugins extend bridge
 * behavior through. Engines and adapters dispatch policy decisions through
 * {@link BridgeDispatch} so features like chatroom can live in a sibling
 * plugin instead of inline engine branches.
 *
 * @module dsh-feishu-bridge
 */

import { Service, type Context, type Events } from '@deepseek-ai/cordis'
import type { Promisify } from '@deepseek-ai/cosmokit'
import type { DshAgentAdapter } from './agent-dsh/adapter.js'
import type { Engine, InteractiveState } from './engine/engine.js'
import type { Session } from './engine/session.js'
import type { AskDecision, AskRequest, Platform, SessionStartOptions } from './core/types.js'
import { agentIDOf, type SubtaskRoute } from './tools/subtask.js'

/** One live project: its engine plus the adapter that owns its agents. */
export interface LiveProject {
  readonly engine: Engine
  readonly adapter: DshAgentAdapter
}

/** The `feishuBridge/*` keys of the merged cordis event map. */
export type FeishuBridgeEventName = Extract<keyof Events, `feishuBridge/${string}`>

/**
 * The event-bus face injected into engine-side decision points: cordis
 * dispatch narrowed to `feishuBridge/*` events, so engine modules never hold
 * a Cordis context. Waterfall events take the built-in base behavior as the
 * innermost `next` (the final dispatch argument); with no listener
 * registered the base runs unchanged.
 */
export interface BridgeDispatch {
  emit<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): void
  waterfall<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
  serial<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
}

/**
 * A dispatch face with no listeners, for engines constructed outside a
 * Cordis tree (unit tests): waterfall dispatches run the built-in base (the
 * innermost `next` is the last dispatch argument), serial dispatches settle
 * with no bail value, and emits drop. Production engines always receive the
 * {@link FeishuBridgeService} face; a production path constructing engines
 * without it silently disables every `feishuBridge/*` extension.
 *
 * @returns The listener-less dispatch face.
 */
export function bareBridgeDispatch(): BridgeDispatch {
  const base = <K extends FeishuBridgeEventName>(_name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]> =>
    (args[args.length - 1] as () => ReturnType<Events[K]>)()
  return {
    emit: () => undefined,
    waterfall: base,
    serial: <K extends FeishuBridgeEventName>(): Promisify<ReturnType<Events[K]>> =>
      Promise.resolve(undefined) as Promisify<ReturnType<Events[K]>>,
  }
}

/**
 * A dispatch face bound to a plain Cordis context, without mounting the
 * service: listeners registered on the context (e.g.
 * `registerChatroomPolicyListeners`) answer the dispatches. Partial
 * assemblies and unit tests that exercise the event path wire engines with
 * this; production engines receive the mounted {@link FeishuBridgeService}
 * itself.
 *
 * @param ctx - The context whose event bus carries the dispatches.
 * @returns The context-bound dispatch face.
 */
export function ctxBridgeDispatch(ctx: Context): BridgeDispatch {
  return {
    emit: (name, ...args) => { ctx.emit(name, ...args) },
    waterfall: (name, ...args) => ctx.waterfall(name, ...args),
    serial: (name, ...args) => ctx.serial(name, ...args),
  }
}

/**
 * The feishu-bridge service: live projects, caller routing, and the
 * `feishuBridge/*` dispatch face. Mounted by the plugin's `apply()` before
 * any engine is built; engines dispatch through the service instance, and
 * sibling plugins reach it as `ctx.feishuBridge` (via
 * `inject: ['feishuBridge']`).
 */
export class FeishuBridgeService extends Service implements BridgeDispatch {
  private readonly live: LiveProject[] = []

  constructor(ctx: Context) {
    super(ctx, 'feishuBridge')
  }

  /** The live projects, in mount order. */
  get projects(): ReadonlyArray<LiveProject> {
    return this.live
  }

  /**
   * Register one live project. The returned disposer removes it again.
   *
   * @param project - The engine/adapter pair of one configured project.
   * @returns Disposer dropping the project from the registry.
   */
  registerProject(project: LiveProject): () => void {
    this.live.push(project)
    return () => {
      const index = this.live.indexOf(project)
      if (index >= 0) this.live.splice(index, 1)
    }
  }

  /**
   * Resolve the calling dsh agent to its engine session (plan D4: one
   * process-wide tool family per domain, routed by CALLER agent).
   *
   * @param caller - The value claiming to be a dsh agent.
   * @returns The engine and engine session key, or undefined when the caller
   *   is not a feishu-bridge-owned agent.
   */
  route(caller: unknown): SubtaskRoute | undefined {
    const id = agentIDOf(caller)
    if (id === '') return undefined
    for (const { engine, adapter } of this.live) {
      const sessionKey = adapter.engineKeyForAgentID(id)
      if (sessionKey !== undefined) return { engine, sessionKey }
    }
    return undefined
  }

  /**
   * Resolve a native continuable child (de-baggage B4) to the engine that
   * spawned it. Only the subtask family consumes this — a native child
   * calling cron/relay/chatroom/send has no engine chat to act on.
   *
   * @param caller - The value claiming to be a dsh agent.
   * @returns The owning engine keyed by the native child id, or undefined.
   */
  nativeRoute(caller: unknown): SubtaskRoute | undefined {
    const id = agentIDOf(caller)
    if (id === '') return undefined
    for (const { engine } of this.live) {
      if (engine.ownsNativeChild(id)) return { engine, sessionKey: id, nativeChildId: id }
    }
    return undefined
  }

  emit<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): void {
    this.ctx.emit(name, ...args)
  }

  waterfall<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]> {
    return this.ctx.waterfall(name, ...args)
  }

  serial<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>> {
    return this.ctx.serial(name, ...args)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The feishu-bridge service face (live projects, routing, dispatch). */
    feishuBridge: FeishuBridgeService
  }

  interface Events {
    /**
     * Decide whether tool-permission requests auto-approve for a session
     * start. The built-in base covers unattended subtask children; a
     * listener short-circuits with `true` for role personas nobody can
     * answer approvals for.
     * @param payload.options - The session-start options the adapter built.
     * @mode waterfall
     */
    'feishuBridge/permission-policy'(payload: { options: SessionStartOptions | undefined }, next: () => boolean): boolean
    /**
     * Adjust the effective mode for a session start (a moderator drives a
     * running discussion, never an implementation: an inherited plan default
     * would stall the chatroom on an ExitPlanMode approval nobody needs to
     * give). The built-in base returns the adapter-computed mode unchanged.
     * @param payload.options - The session-start options the adapter built.
     * @param payload.mode - The mode the adapter computed (bypass /
     *   override / project default).
     * @mode waterfall
     */
    'feishuBridge/mode-policy'(payload: { options: SessionStartOptions | undefined; mode: string }, next: () => string): string
    /**
     * Decide whether a session's group keeps a fixed name that
     * first-message spawn renaming must not clobber. The built-in base
     * exempts nothing; a listener short-circuits with `true` for
     * feature-owned group names (chatroom role, research, and direct-role
     * groups).
     * @param payload.session - The spawned chat's session.
     * @mode waterfall
     */
    'feishuBridge/rename-exemption'(payload: { session: Session }, next: () => boolean): boolean
    /**
     * Decide whether auto-render is suppressed for a session: features
     * whose sessions relay their output elsewhere skip the local HTML
     * overview. The built-in base covers subtask children; a listener adds
     * feature sessions (chatroom roles relay to the hub). The caller
     * applies the monitor-child exemption and the user-interjection
     * re-enable around this decision.
     * @param payload.session - The session being considered.
     * @mode waterfall
     */
    'feishuBridge/auto-render-policy'(payload: { session: Session }, next: () => boolean): boolean
    /**
     * Decide whether a session is exempt from the per-turn hard cap (a turn
     * whose events keep trickling in would otherwise reset the idle timer
     * forever). The built-in base exempts nothing; a listener short-circuits
     * with `true` for sessions whose long turns are the product (research
     * assistants and research-hub chatroom roles).
     * @param payload.engine - The engine owning the session registry (hub lookup).
     * @param payload.session - The session the turn runs under.
     * @mode waterfall
     */
    'feishuBridge/hard-cap-exemption'(payload: { engine: Engine; session: Session }, next: () => boolean): boolean
    /**
     * Route the human's reply to a feature's pending question (chatroom
     * ask-human): a listener that consumes the message short-circuits with
     * `true` and the inbound flow stops there — this decision outranks
     * command dispatch and permission handling. The built-in base returns
     * false (no feature holds a pending question).
     * @param payload.engine - The engine receiving the inbound message.
     * @param payload.platform - Platform that delivered the message.
     * @param payload.sessionKey - Session key the message arrived under.
     * @param payload.content - The human's reply text.
     * @mode waterfall
     */
    'feishuBridge/route-human-reply'(payload: { engine: Engine; platform: Platform; sessionKey: string; content: string }, next: () => boolean): boolean
    /**
     * A turn is starting for a session: the one moment queued per-message
     * metadata is consumed. Listeners run in order (a chatroom listener
     * stamps gather-round metadata onto the role session and persists it).
     * @param payload.engine - The engine owning the turn.
     * @param payload.session - The session the turn runs under.
     * @param payload.metadata - Opaque per-message metadata carried through
     *   the queue; owned by the feature that set its keys.
     * @mode serial
     */
    'feishuBridge/turn-start'(payload: { engine: Engine; session: Session; metadata: Record<string, unknown> | undefined }): void
    /**
     * A turn just produced its final response: listeners may relay the
     * reply elsewhere (chatroom roles relay to the hub and wake the
     * moderator). The built-in base does nothing; call `next()` to let the
     * rest of the chain observe the turn end.
     * @param payload.engine - The engine owning the turn.
     * @param payload.state - The turn's interactive state (carries the platform).
     * @param payload.session - The session the turn ran under.
     * @param payload.response - The turn's clean final response text.
     * @param payload.isSilent - Whether the reply was silent (relay may skip).
     * @mode waterfall
     */
    'feishuBridge/turn-end'(payload: { engine: Engine; state: InteractiveState | undefined; session: Session; response: string; isSilent: boolean }, next: () => void): void
    /**
     * Allow an ask to be answered without the user. The built-in base
     * returns undefined (fall through to the normal ask flow); a listener
     * returns the decision instead (chatroom auto-approves the moderator's
     * role-pick plan review as a formality).
     * @param payload.engine - The engine rendering the ask.
     * @param payload.sessionKey - Interactive-state slot the ask renders on.
     * @param payload.request - The ask request (kind discriminates the surface).
     * @param payload.signal - Abort signal of the asking tool call, if any.
     * @mode waterfall
     */
    'feishuBridge/ask-approval'(payload: { engine: Engine; sessionKey: string; request: AskRequest; signal: AbortSignal | undefined }, next: () => Promise<AskDecision | undefined>): Promise<AskDecision | undefined>
    /**
     * Every platform of an engine finished starting. Listeners recover
     * cross-restart state that needs live platforms (chatroom closes armed
     * gather/end barriers from the persisted snapshot).
     * @param payload.engine - The engine whose platforms are live.
     * @mode emit
     */
    'feishuBridge/platforms-ready'(payload: { engine: Engine }): void
    /**
     * Decorate the shared session-start options object before the agent
     * session starts: listeners set feature sections (chatroom fills the
     * persona block and the shared research venv) and call `next()`. The
     * built-in base fills the subtask and workspace sections only.
     * @param payload.engine - The engine starting the session.
     * @param payload.session - The session being started.
     * @param payload.options - The options object to mutate in place.
     * @mode waterfall
     */
    'feishuBridge/session-start-options'(payload: { engine: Engine; session: Session; options: SessionStartOptions }, next: () => void): void
  }
}
