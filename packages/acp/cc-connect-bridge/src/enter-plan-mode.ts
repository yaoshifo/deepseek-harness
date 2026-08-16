/**
 * The agent-facing entry tool into plan mode, registered by the cc-connect
 * bridge so deployments keep the dsh-base tool catalog untouched (the exit
 * tool ships with dsh-plan-mode and stays registered in both modes; this is
 * its mirror for agent-initiated entry).
 *
 * @module cc-connect-bridge/enter-plan-mode
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only edge: pulls in the `ctx.planMode` service declaration.
import type {} from '@deepseek-ai/dsh-plan-mode'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** The model-facing entry tool's name. */
export const ENTER_PLAN_MODE = 'enter_plan_mode'

/**
 * Register `enter_plan_mode` on the calling context: switches the calling
 * agent's session into plan mode (the same state the `/plan` command
 * selects), effective from the next model request.
 *
 * @param ctx - the plugin context to inject through.
 */
export function registerEnterPlanMode(ctx: Context): void {
  ctx.inject(['planMode', 'tools'], (toolCtx) => {
    toolCtx.tools.register(defineTool({
      name: ENTER_PLAN_MODE,
      description: 'Enter plan mode before starting work on a large, risky, or ambiguous change: '
        + 'while it is active, explore read-only and present the complete plan via exit_plan_mode '
        + 'for user approval before implementing anything. Use it when the task spans multiple '
        + 'subsystems, requirements are ambiguous, or the user asked for a plan first. '
        + 'Not for simple, well-scoped tasks — just do those directly.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entered: { type: 'boolean', const: true, required: true },
          },
        },
        render: () => [{ type: 'text', text: 'Plan mode entered — explore read-only, then present the complete plan with exit_plan_mode.' }],
      },
      execute: async (_args, exec) => {
        const agent = exec.agent
        if (agent === undefined) {
          throw new Error(`${ENTER_PLAN_MODE} requires a calling agent (no session to switch)`)
        }
        toolCtx.planMode.set(agent, true)
        return { entered: true }
      },
    }))
  })
}
