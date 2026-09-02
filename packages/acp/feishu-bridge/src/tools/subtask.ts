/**
 * The model-facing `feishu_bridge_subtask` tool: the cc-connect
 * `/subtask/*` HTTP handlers and CLI subcommand surface (spawn / report /
 * send / gather) ported to a dsh tool (plan D4). The caller agent resolves
 * its owning Engine + engine session key through the router — no process env
 * (Go CC_PROJECT/CC_SESSION_KEY), because ToolRunContext carries the caller
 * agent and the plugin owns the agent→engine mapping.
 *
 * Model-visible outputs are the Go CLI's result sentences verbatim, so the
 * tool result in the session log replays the same guidance the Go agent saw.
 *
 * @module dsh-feishu-bridge/tools-subtask
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Engine } from '../engine/engine.ts'
import { parseWorktreeMode } from '../engine/worktree.ts'

/** The engine and engine session key a tool call is routed to. */
export interface SubtaskRoute {
  readonly engine: Engine
  readonly sessionKey: string
  /**
   * Native continuable child id (de-baggage B4): present when the caller is
   * itself a native subtask child rather than an engine-owned session; the
   * sessionKey then carries the same native id.
   */
  readonly nativeChildId?: string
}

/**
 * Resolves the calling dsh agent to its engine session. Returns undefined
 * when the caller is not a feishu-bridge-owned agent (e.g. a foreign agent
 * in the same process).
 */
export type SubtaskAgentRouter = (agent: unknown) => SubtaskRoute | undefined

/** The structural member of a dsh Agent the router needs. */
interface AgentLike {
  readonly id?: unknown
}

const DESCRIPTION =
  'Delegate parallel work to isolated subtasks and collect their results. '
  + 'Each spawned subtask is an independent agent session running in parallel with you, '
  + 'optionally in its own working directory and git worktree. '
  + 'Work in a different directory is delegated through this tool only: the child runs there '
  + 'and loads that directory\'s instruction files. '
  + 'When you begin executing an approved plan, its independently-marked groups are parallel work: '
  + 'spawn them together in one message instead of implementing them serially yourself; '
  + 'execute serially dependent groups yourself in order. '
  + 'spawn: dispatch one self-contained task brief (the child runs in parallel and wakes you '
  + 'with its result when it reports back); default worktree isolation is "auto" — isolated '
  + 'when the child shares your repository; fork=true copies your conversation context into '
  + 'the child (works across directories too, but a short self-contained brief is cheaper). '
  + 'report: push THIS subtask\'s result back '
  + 'to the parent conversation that dispatched you — call exactly once when your work is '
  + 'complete; omit message to use your last reply. send: ask one of your running subtasks a '
  + 'follow-up question — native subtasks queue it until the child\'s current turn finishes '
  + 'and its answer wakes you; an attended group child that is busy rejects it (wait for its '
  + 'completion notice, then retry). gather: after spawning all the children you want to batch, BLOCK '
  + 'until every in-flight subtask has reported (or the timeout, ~20 minutes, returns partial '
  + 'results) — the combined summary arrives as THIS tool call\'s result, so call it when your '
  + 'next step depends on the results and synthesize in the same reply; skip it to keep working '
  + 'and be woken once per child. interrupt: stop one of your native subtasks\' current turn '
  + '(the child session survives and can be asked again later; attended group children are '
  + 'stopped from their own chat).'

/**
 * Register the `feishu_bridge_subtask` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @param nativeRoute - resolves a native continuable-child caller to its owning engine.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerSubtaskTool(
  ctx: Context,
  route: SubtaskAgentRouter,
  nativeRoute?: SubtaskAgentRouter,
): () => void {
  return ctx.tools.register(defineTool({
    name: 'feishu_bridge_subtask',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['spawn', 'report', 'send', 'gather', 'interrupt'],
        description: 'spawn = dispatch a new subtask; report = deliver this subtask\'s result to its parent; '
          + 'send = follow up on a running subtask; gather = block until all in-flight subtasks report, then '
          + 'receive their combined summary as this call\'s result (a timeout returns partial results); '
          + 'interrupt = stop one subtask\'s current turn.',
      },
      message: {
        type: 'string',
        description: 'spawn: the self-contained task brief (also names the group). report: the result summary '
          + '(default: your last reply). send: the follow-up question.',
      },
      dir: {
        type: 'string',
        description: 'spawn only: the child\'s working directory (default: this session\'s). Work that lives in a '
          + 'different project must be delegated with this: the child runs there and loads that project\'s '
          + 'instruction files.',
      },
      worktree: {
        type: 'string',
        enum: ['auto', 'on', 'off'],
        description: 'spawn only: git worktree isolation. auto (default) isolates when the child shares your '
          + 'repository; on always isolates; off for read-only or cross-repo work.',
      },
      fork: {
        type: 'boolean',
        description: 'spawn only: copy this conversation\'s context into the child instead of starting fresh. '
          + 'Needs your conversation to have started; a self-contained brief is usually cheaper than forking '
          + 'the whole transcript.',
      },
      child: {
        type: 'string',
        description: 'send/interrupt: the target subtask\'s session key, from the spawn result. '
          + 'interrupt accepts native subtask ids only — attended group children are stopped from their own chat. '
          + 'send also accepts the literal "assistant" for your pre-provisioned research assistant, '
          + 'when one exists — prefer it over copying a long key by hand.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['ok'] },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const target = route(exec.agent) ?? nativeRoute?.(exec.agent)
      if (target === undefined) {
        throw new Error('feishu_bridge_subtask: the calling session is not owned by a feishu-bridge project')
      }
      const { engine, sessionKey } = target
      switch (args.action) {
        case 'spawn': {
          const brief = (args.message ?? '').trim()
          if (brief === '') throw new Error('feishu_bridge_subtask: spawn requires a task brief (message)')
          const { childName, childKey } = await engine.spawnSubtaskNative(
            sessionKey,
            args.dir ?? '',
            parseWorktreeMode(args.worktree ?? 'auto'),
            args.fork === true,
            brief,
          )
          return {
            status: 'ok' as const,
            message: `Spawned subtask "${childName}" (session ${childKey}). `
              + 'It runs in parallel; you will be woken with its result when it reports back.',
          }
        }
        case 'report': {
          if (target.nativeChildId !== undefined) {
            await engine.reportNativeChild(target.nativeChildId, (args.message ?? '').trim())
          } else {
            await engine.reportSubtask(sessionKey, (args.message ?? '').trim())
          }
          return { status: 'ok' as const, message: 'Reported result back to the parent conversation.' }
        }
        case 'send': {
          const child = (args.child ?? '').trim()
          if (child === '') throw new Error('feishu_bridge_subtask: send requires the target subtask\'s session key (child)')
          const question = (args.message ?? '').trim()
          if (question === '') throw new Error('feishu_bridge_subtask: send requires a follow-up message')
          await engine.sendToSubtask(sessionKey, child, question)
          return {
            status: 'ok' as const,
            message: `Follow-up sent to subtask ${child}; it is queued until the child's current turn finishes, `
              + 'and its answer will wake you when ready.',
          }
        }
        case 'gather': {
          if (target.nativeChildId !== undefined) {
            return {
              status: 'ok' as const,
              message: 'No barrier armed: you are yourself a native subtask, so each child report wakes you '
                + 'individually (native inbox semantics). Spawn-level batching applies to top-level conversations.',
            }
          }
          // Blocks until every in-flight child reports (or the gather
          // timeout returns partial results); the summary lands as this
          // call's result in the same turn. Abort (user stop) falls back to
          // the async wake path inside the engine.
          const summary = await engine.gatherSubtasksBlocking(sessionKey, exec.signal)
          return {
            status: 'ok' as const,
            message: summary,
          }
        }
        case 'interrupt': {
          const child = (args.child ?? '').trim()
          if (child === '') throw new Error('feishu_bridge_subtask: interrupt requires the target subtask\'s session key (child)')
          engine.interruptNativeChild(child, sessionKey)
          return {
            status: 'ok' as const,
            message: `Interrupt requested for subtask ${child}; its current turn stops but the session survives — `
              + 'a later send reaches it again.',
          }
        }
        default:
          // Unreachable: the schema enum rejects anything else before execute.
          throw new Error('feishu_bridge_subtask: unknown action')
      }
    },
  }))
}

/**
 * Narrowing helper for the router's agent argument (structural dsh Agent).
 *
 * @param agent - The untyped caller agent value from the tool run context.
 * @returns The agent's id, or '' when the value is not a bridge-owned agent.
 */
export function agentIDOf(agent: unknown): string {
  const id = (agent as AgentLike | undefined)?.id
  // dsh agent/session ids are branded strings; anything else is not a
  // bridge-owned caller.
  return typeof id === 'string' ? id : ''
}
