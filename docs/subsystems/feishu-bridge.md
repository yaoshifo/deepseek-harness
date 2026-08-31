# Feishu Bridge

English | [中文](feishu-bridge.zh.md)

The Feishu bridge runs the bot-facing conversational runtime: one engine per configured project, the platform adapters, and the sibling-plugin seam. The [chatroom extraction Agent Notes](../../.agents/notes/implemented/architecture/2026-08-29-feishu-bridge-chatroom-extraction.md) own the service and event decisions; this page records the Cordis surface of [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts).

The `ctx.feishuBridge` service exposes the live project registry, caller routing, and the `feishuBridge/*` dispatch face. Sibling plugins (the chatroom package, `@deepseek-ai/dsh-feishu-bridge-chatroom`) consume the service through the package's `./exports` entry and extend engine behavior by answering the dispatched events instead of mounting engine hooks.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfeishubridge--feishubridgeservice"></a>

### `ctx.feishuBridge` — `FeishuBridgeService`

The feishu-bridge service: live projects, caller routing, and the `feishuBridge/*` dispatch face. Mounted by the plugin's `apply()` before any engine is built; engines dispatch through the service instance, and sibling plugins reach it as `ctx.feishuBridge` (via `inject: ['feishuBridge']`).

```ts cordis-catalog
/**
 * Register tool names hidden from every session of one engine's project.
 *
 * A sibling plugin calls this for a project it is disabled on (the
 * chatroom plugin hides `feishu_bridge_chatroom` on projects configured
 * `enabled: false`), so the tool definition stops entering that project's
 * model requests instead of merely failing at execute.
 *
 * @param engine - The engine whose project sessions the mask applies to.
 * @param names - Tool names to hide; names absent from the live registry
 *   are dropped by the adapter's mask, not here.
 * @returns Disposer removing the names again; idempotent.
 */
denyTools(engine: Engine, names: readonly string[]): () => void

/**
 * The tool names currently registered as hidden for one engine's project.
 * @param engine - The engine whose mask set is addressed.
 * @returns The hidden names in registration order.
 */
deniedToolsOf(engine: Engine): readonly string[]

/**
 * Resolve once every live project is registered. The bridge's apply calls
 * {@link FeishuBridgeService.markReady} after its project-assembly loop, so
 * a sibling plugin awaiting this deterministically sees the full project
 * list (its per-project wiring then targets every engine). Idempotent:
 * callers after readiness resolve immediately.
 *
 * @returns A promise resolving when the service is ready.
 */
whenReady(): Promise<void>

/**
 * Mark the service ready, resolving every {@link FeishuBridgeService.whenReady}
 * waiter. Calling again is a no-op.
 */
markReady(): void

/**
 * Register one live project. The returned disposer removes it again.
 *
 * @param project - The engine/adapter pair of one configured project.
 * @returns Disposer dropping the project from the registry.
 */
registerProject(project: LiveProject): () => void

/**
 * Resolve the calling dsh agent to its engine session (plan D4: one
 * process-wide tool family per domain, routed by CALLER agent).
 *
 * @param caller - The value claiming to be a dsh agent.
 * @returns The engine and engine session key, or undefined when the caller
 *   is not a feishu-bridge-owned agent.
 */
route(caller: unknown): SubtaskRoute | undefined

/**
 * Resolve a native continuable child (de-baggage B4) to the engine that
 * spawned it. Only the subtask family consumes this — a native child
 * calling cron/relay/chatroom/send has no engine chat to act on.
 *
 * @param caller - The value claiming to be a dsh agent.
 * @returns The owning engine keyed by the native child id, or undefined.
 */
nativeRoute(caller: unknown): SubtaskRoute | undefined

/**
 * Dispatch a `feishuBridge/*` event to every listener on the context bus.
 * @param name - The event key.
 * @param args - The listener arguments (the built-in base is the last one).
 */
emit<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): void

/**
 * Dispatch a `feishuBridge/*` waterfall: listeners run in order until one
 * bails with a decision.
 * @param name - The event key.
 * @param args - The listener arguments (the built-in base is the last one).
 * @returns The first bail value, or the base behavior's result.
 */
waterfall<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>

/**
 * Dispatch a `feishuBridge/*` event serially, awaiting every listener in
 * order.
 * @param name - The event key.
 * @param args - The listener arguments (the built-in base is the last one).
 * @returns The first bail value, or the base behavior's result.
 */
serial<K extends FeishuBridgeEventName>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridge-events"></a>

### `feishuBridge/*` events

<a id="feishubridgeask-approval--waterfall"></a>

#### `feishuBridge/ask-approval` — waterfall

Allow an ask to be answered without the user. The built-in base returns undefined (fall through to the normal ask flow); a listener returns the decision instead (a listener auto-approves the moderator's role-pick plan review as a formality).

```ts cordis-catalog
/**
 * Allow an ask to be answered without the user. The built-in base
 * returns undefined (fall through to the normal ask flow); a listener
 * returns the decision instead (a listener auto-approves the
 * moderator's role-pick plan review as a formality).
 * @param payload.engine - The engine rendering the ask.
 * @param payload.sessionKey - Interactive-state slot the ask renders on.
 * @param payload.request - The ask request (kind discriminates the surface).
 * @param payload.signal - Abort signal of the asking tool call, if any.
 * @mode waterfall
 */
'feishuBridge/ask-approval'(payload: { engine: Engine; sessionKey: string; request: AskRequest; signal: AbortSignal | undefined }, next: () => Promise<AskDecision | undefined>): Promise<AskDecision | undefined>
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeask-parked--emit"></a>

#### `feishuBridge/ask-parked` — emit

An ask card was parked and rendered (any kind; the questions kind is the only current dispatcher). Listeners arm their own whole-ask guards on the pending object (a research-manual hub arms the auto-default timer whose fire settles unanswered questions).

```ts cordis-catalog
/**
 * An ask card was parked and rendered (any kind; the questions kind is
 * the only current dispatcher). Listeners arm their own whole-ask
 * guards on the pending object (a research-manual hub arms the
 * auto-default timer whose fire settles unanswered questions).
 * @param payload.engine - The engine that parked the ask.
 * @param payload.platform - Platform the ask card was posted on.
 * @param payload.sessionKey - Session key the ask renders under.
 * @param payload.replyCtx - Reply context for follow-up notices.
 * @param payload.pending - The parked ask (settles the promise; carries the timer slot).
 * @mode emit
 */
'feishuBridge/ask-parked'(payload: { engine: Engine; platform: Platform; sessionKey: string; replyCtx: unknown; pending: PendingAsk }): void
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeauto-render-policy--waterfall"></a>

#### `feishuBridge/auto-render-policy` — waterfall

Decide whether auto-render is suppressed for a session: features whose sessions relay their output elsewhere skip the local HTML overview. The built-in base covers subtask children; a listener adds feature sessions (feature roles relay to their hub). The caller applies the monitor-child exemption and the user-interjection re-enable around this decision.

```ts cordis-catalog
/**
 * Decide whether auto-render is suppressed for a session: features
 * whose sessions relay their output elsewhere skip the local HTML
 * overview. The built-in base covers subtask children; a listener adds
 * feature sessions (feature roles relay to their hub). The caller
 * applies the monitor-child exemption and the user-interjection
 * re-enable around this decision.
 * @param payload.session - The session being considered.
 * @mode waterfall
 */
'feishuBridge/auto-render-policy'(payload: { session: Session }, next: () => boolean): boolean
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgebackground-session-policy--waterfall"></a>

#### `feishuBridge/background-session-policy` — waterfall

Decide whether a session is a background session a human can take over (re-enabling auto-render from that point). The built-in base covers subtask children; a listener adds feature sessions (feature roles relay to their hub).

```ts cordis-catalog
/**
 * Decide whether a session is a background session a human can take
 * over (re-enabling auto-render from that point). The built-in base
 * covers subtask children; a listener adds feature sessions (feature
 * roles relay to their hub).
 * @param payload.session - The session being considered.
 * @mode waterfall
 */
'feishuBridge/background-session-policy'(payload: { session: Session }, next: () => boolean): boolean
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgehard-cap-exemption--waterfall"></a>

#### `feishuBridge/hard-cap-exemption` — waterfall

Decide whether a session is exempt from the per-turn hard cap (a turn whose events keep trickling in would otherwise reset the idle timer forever). The built-in base exempts nothing; a listener short-circuits with `true` for sessions whose long turns are the product (research assistants and research-hub roles).

```ts cordis-catalog
/**
 * Decide whether a session is exempt from the per-turn hard cap (a turn
 * whose events keep trickling in would otherwise reset the idle timer
 * forever). The built-in base exempts nothing; a listener short-circuits
 * with `true` for sessions whose long turns are the product (research
 * assistants and research-hub roles).
 * @param payload.engine - The engine owning the session registry (hub lookup).
 * @param payload.session - The session the turn runs under.
 * @mode waterfall
 */
'feishuBridge/hard-cap-exemption'(payload: { engine: Engine; session: Session }, next: () => boolean): boolean
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgemode-policy--waterfall"></a>

#### `feishuBridge/mode-policy` — waterfall

Adjust the effective mode for a session start (a moderator drives a running discussion, never an implementation: an inherited plan default would stall the discussion on an ExitPlanMode approval nobody needs to give). The built-in base returns the adapter-computed mode unchanged.

```ts cordis-catalog
/**
 * Adjust the effective mode for a session start (a moderator drives a
 * running discussion, never an implementation: an inherited plan default
 * would stall the discussion on an ExitPlanMode approval nobody needs to
 * give). The built-in base returns the adapter-computed mode unchanged.
 * @param payload.options - The session-start options the adapter built.
 * @param payload.mode - The mode the adapter computed (bypass /
 *   override / project default).
 * @mode waterfall
 */
'feishuBridge/mode-policy'(payload: { options: SessionStartOptions | undefined; mode: string }, next: () => string): string
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgepermission-policy--waterfall"></a>

#### `feishuBridge/permission-policy` — waterfall

Decide whether tool-permission requests auto-approve for a session start. The built-in base covers unattended subtask children; a listener short-circuits with `true` for role personas nobody can answer approvals for.

```ts cordis-catalog
/**
 * Decide whether tool-permission requests auto-approve for a session
 * start. The built-in base covers unattended subtask children; a
 * listener short-circuits with `true` for role personas nobody can
 * answer approvals for.
 * @param payload.options - The session-start options the adapter built.
 * @mode waterfall
 */
'feishuBridge/permission-policy'(payload: { options: SessionStartOptions | undefined }, next: () => boolean): boolean
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeplatforms-ready--emit"></a>

#### `feishuBridge/platforms-ready` — emit

Every platform of an engine finished starting. Listeners recover cross-restart state that needs live platforms (a listener closes armed gather/end barriers from the persisted snapshot).

```ts cordis-catalog
/**
 * Every platform of an engine finished starting. Listeners recover
 * cross-restart state that needs live platforms (a listener closes armed
 * gather/end barriers from the persisted snapshot).
 * @param payload.engine - The engine whose platforms are live.
 * @mode emit
 */
'feishuBridge/platforms-ready'(payload: { engine: Engine }): void
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgerename-exemption--waterfall"></a>

#### `feishuBridge/rename-exemption` — waterfall

Decide whether a session's group keeps a fixed name that first-message spawn renaming must not clobber. The built-in base exempts nothing; a listener short-circuits with `true` for feature-owned group names (role, research, and direct-role groups).

```ts cordis-catalog
/**
 * Decide whether a session's group keeps a fixed name that
 * first-message spawn renaming must not clobber. The built-in base
 * exempts nothing; a listener short-circuits with `true` for
 * feature-owned group names (role, research, and direct-role groups).
 * @param payload.session - The spawned chat's session.
 * @mode waterfall
 */
'feishuBridge/rename-exemption'(payload: { session: Session }, next: () => boolean): boolean
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeresolve-child-alias--waterfall"></a>

#### `feishuBridge/resolve-child-alias` — waterfall

Resolve a short child alias a model can type reliably into the real child session key (a 40+ char hex key gets characters dropped in transcription). The built-in base returns '' (unknown alias, normal parsing continues); a listener returns the resolved key, or throws to fail the resolution loudly (an alias whose referent was never provisioned must not degrade into a mistyped-key error).

```ts cordis-catalog
/**
 * Resolve a short child alias a model can type reliably into the real
 * child session key (a 40+ char hex key gets characters dropped in
 * transcription). The built-in base returns '' (unknown alias, normal
 * parsing continues); a listener returns the resolved key, or throws to
 * fail the resolution loudly (an alias whose referent was never
 * provisioned must not degrade into a mistyped-key error).
 * @param payload.engine - The engine owning the caller's session registry.
 * @param payload.callerSessionKey - Session key of the parent issuing the send.
 * @param payload.alias - The alias as typed into the tool call.
 * @mode waterfall
 */
'feishuBridge/resolve-child-alias'(payload: { engine: Engine; callerSessionKey: string; alias: string }, next: () => string): string
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeroute-human-reply--waterfall"></a>

#### `feishuBridge/route-human-reply` — waterfall

Route the human's reply to a feature's pending question: a listener that consumes the message short-circuits with `true` and the inbound flow stops there — this decision outranks command dispatch and permission handling. The built-in base returns false (no feature holds a pending question). Machine messages (deliverMachineMessage wakes) are never human replies — listeners must skip them.

```ts cordis-catalog
/**
 * Route the human's reply to a feature's pending question: a listener that consumes the message short-circuits with
 * `true` and the inbound flow stops there — this decision outranks
 * command dispatch and permission handling. The built-in base returns
 * false (no feature holds a pending question). Machine messages
 * (deliverMachineMessage wakes) are never human replies — listeners
 * must skip them.
 * @param payload.engine - The engine receiving the inbound message.
 * @param payload.platform - Platform that delivered the message.
 * @param payload.sessionKey - Session key the message arrived under.
 * @param payload.content - The human's reply text.
 * @param payload.machine - True when a synthetic machine message, never a human reply.
 * @mode waterfall
 */
'feishuBridge/route-human-reply'(payload: { engine: Engine; platform: Platform; sessionKey: string; content: string; machine: boolean }, next: () => boolean): boolean
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgesession-start-options--waterfall"></a>

#### `feishuBridge/session-start-options` — waterfall

Decorate the shared session-start options object before the agent session starts: listeners set feature sections (a listener fills the persona block and the shared research venv) and call `next()`. The built-in base fills the subtask and workspace sections only.

```ts cordis-catalog
/**
 * Decorate the shared session-start options object before the agent
 * session starts: listeners set feature sections (a listener fills the
 * persona block and the shared research venv) and call `next()`. The
 * built-in base fills the subtask and workspace sections only.
 * @param payload.engine - The engine starting the session.
 * @param payload.session - The session being started.
 * @param payload.options - The options object to mutate in place.
 * @mode waterfall
 */
'feishuBridge/session-start-options'(payload: { engine: Engine; session: Session; options: SessionStartOptions }, next: () => void): void
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgesubtask-dispatched--emit"></a>

#### `feishuBridge/subtask-dispatched` — emit

A subtask was dispatched from a parent session (group spawn or a follow-up send). Listeners record feature bookkeeping on the parent (research roles mark the assistant dispatch of this turn).

```ts cordis-catalog
/**
 * A subtask was dispatched from a parent session (group spawn or a
 * follow-up send). Listeners record feature bookkeeping on the parent
 * (research roles mark the assistant dispatch of this turn).
 * @param payload.engine - The engine owning the parent session.
 * @param payload.parentSessionKey - Session key of the dispatching parent.
 * @mode emit
 */
'feishuBridge/subtask-dispatched'(payload: { engine: Engine; parentSessionKey: string }): void
```

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeturn-end--waterfall"></a>

#### `feishuBridge/turn-end` — waterfall

A turn just produced its final response: listeners may relay the reply elsewhere (feature roles relay to their hub and wake the moderator). The built-in base does nothing; call `next()` to let the rest of the chain observe the turn end.

```ts cordis-catalog
/**
 * A turn just produced its final response: listeners may relay the
 * reply elsewhere (feature roles relay to their hub and wake the
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
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)

<a id="feishubridgeturn-start--serial"></a>

#### `feishuBridge/turn-start` — serial

A turn is starting for a session: the one moment queued per-message metadata is consumed. Listeners run in order (a feature listener stamps gather-round metadata onto the role session and persists it).

```ts cordis-catalog
/**
 * A turn is starting for a session: the one moment queued per-message
 * metadata is consumed. Listeners run in order (a feature listener
 * stamps gather-round metadata onto the role session and persists it).
 * @param payload.engine - The engine owning the turn.
 * @param payload.session - The session the turn runs under.
 * @param payload.metadata - Opaque per-message metadata carried through
 *   the queue; owned by the feature that set its keys.
 * @mode serial
 */
'feishuBridge/turn-start'(payload: { engine: Engine; session: Session; metadata: Record<string, unknown> | undefined }): void
```

Types: [Session](session.md)

Source: [`packages/acp/feishu-bridge/src/bridge-service.ts`](../../packages/acp/feishu-bridge/src/bridge-service.ts)
<!-- END GENERATED cordis-surface -->
