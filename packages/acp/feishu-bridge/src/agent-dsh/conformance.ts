/**
 * Compile-time conformance for the adapter's hand-written structural slices.
 *
 * Every `ctx.get(...) as DshXxxLike` cast in `adapter.ts` compiles even when
 * the real upstream type has drifted; the flat/wrapped SessionEvent incident
 * (2026-08-30) shipped exactly that way. Each exported type below pins one
 * slice to the real exported service and turns upstream drift into a
 * typecheck failure here instead of a silent runtime cast.
 *
 * Direction: value-producing slices assert the real service satisfies the
 * slice (the cast's implicit claim). `DshCreateOptionsLike` is inverted —
 * the adapter builds options, so the slice must satisfy the parameter type
 * the real registry accepts.
 *
 * @module dsh-feishu-bridge/agent-dsh
 */

import type AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { deliverSubagentPrompt, HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import type JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type McpWorkspaceService from '@deepseek-ai/dsh-mcp-workspace'
import type PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import type {
  DshAgentHandleLike,
  DshAgentLike,
  DshAgentsRegistryLike,
  DshContextLike,
  DshCreateOptionsLike,
  DshPersistenceLike,
  DshSessionProjectionsLike,
  DshSubagentsLike,
  DshToolsLike,
  McpWorkspaceLike,
} from './adapter.ts'

/** Compile-time assertion anchor: fails to compile when the argument is not `true`. */
type Expect<T extends true> = T
/** `true` when the real type satisfies the hand-written slice. */
type SatisfiesSlice<TActual, TSlice> = TActual extends TSlice ? true : false

/** The live Agent the adapter drives, derived from the registry's `get`. */
type RealAgent = NonNullable<ReturnType<AgentRegistry['get']>>
/** The handle `ctx.agents.create`/`resume` returns. */
type RealAgentHandle = Awaited<ReturnType<AgentRegistry['create']>>

/** `ctx.agents` registry slice. */
export type AgentsRegistrySliceConforms =
  Expect<SatisfiesSlice<AgentRegistry, DshAgentsRegistryLike>>

/** Agent member slice (id/status/session/followup/steer/cancel). */
export type AgentSliceConforms =
  Expect<SatisfiesSlice<RealAgent, DshAgentLike>>

/** create/resume handle slice (agent + dispose). */
export type AgentHandleSliceConforms =
  Expect<SatisfiesSlice<RealAgentHandle, DshAgentHandleLike>>

/**
 * The real registry still accepts every option field the adapter builds
 * (input direction; the slice's loose id types stay looser than the
 * branded real ones by design).
 */
export type CreateOptionsCovered =
  Expect<SatisfiesSlice<Parameters<AgentRegistry['create']>[0], DshCreateOptionsLike>>

/** `sessionPersistence` service slice, via the profile's jsonl backend instance type. */
export type PersistenceSliceConforms =
  Expect<SatisfiesSlice<JsonlSessionPersistence, DshPersistenceLike>>

/** `subagents` service slice; the symbol member is asserted separately below. */
export type SubagentsSliceConforms =
  Expect<SatisfiesSlice<SubagentRuntime, Omit<DshSubagentsLike, typeof deliverSubagentPrompt>>>

/** The slice's symbol member mirrors the upstream-declared host prompt protocol. */
export type SubagentPromptProtocolConforms =
  Expect<SatisfiesSlice<HostPromptDeliverer, Pick<DshSubagentsLike, typeof deliverSubagentPrompt>>>

/** `sessionProjections` registry slice (the /context card's snapshot source). */
export type ProjectionsSliceConforms =
  Expect<SatisfiesSlice<SessionProjectionRegistry, DshSessionProjectionsLike>>

/** `tools` service slice (schemas/get/restrict). */
export type ToolsSliceConforms =
  Expect<SatisfiesSlice<ToolRuntime, DshToolsLike>>

/** `mcpWorkspace` service slice (wrap). */
export type McpWorkspaceSliceConforms =
  Expect<SatisfiesSlice<McpWorkspaceService, McpWorkspaceLike>>

/** `permissionPresets` inline slice (set) from applyPermissionPreset. */
export type PermissionPresetsSliceConforms =
  Expect<SatisfiesSlice<PermissionPresetService, { set(session: unknown, name: string): void }>>

/** The ctx slice's optional logger matches Cordis's real Context logger (production always provides it). */
export type ContextLoggerConforms =
  Expect<SatisfiesSlice<Pick<Context, 'logger'>, Required<Pick<DshContextLike, 'logger'>>>>
