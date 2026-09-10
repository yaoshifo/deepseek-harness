/**
 * The model-facing `feishu_bridge_followups` tool: the closing follow-ups
 * card as a narrow schema. The model fills only the findings list; the
 * question text, id, reserved header, and multi-select flag are engine-owned
 * constants synthesized onto the questions ask delegated to
 * `Engine.askUser`, whose closing-card conversion branch (isFollowupsAsk) is
 * the single implementation — this tool adds no second registration path.
 * The narrowed contract exists because the generic ask_user_question shape
 * had the model re-type those constants every closing, and models dropped
 * the required `question`/`id` fields on ~3 attempts/day across the fleet
 * (options were never malformed).
 *
 * @module dsh-feishu-bridge/tools-followups
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FOLLOWUPS_ASK_HEADER } from '../engine/ask.ts'
import type { UserQuestion } from '../core/types.ts'
import type { SubtaskRoute } from './subtask.ts'

/** The fixed question text of every closing card (headline of the dispatched
 * selection message; the card itself renders only the options). */
const FOLLOWUPS_QUESTION = '以上发现后续如何处理？'

/** The stable question id echoed in the deferred registration answer. */
const FOLLOWUPS_ID = 'followups'

const DESCRIPTION =
  'Register the closing follow-ups suggestion card for this turn. '
  + 'Call it right after delivering your final reply, when the「发现的问题 / 可优化点」'
  + '(problems / improvement findings) section of that reply is non-empty; skip it when there are no findings. '
  + 'Pass one option per finding: label = short title, description = `path:line` plus the suggested action '
  + 'in one sentence, recommended = true on the ones worth handling (recommended options render pre-checked). '
  + 'The tool returns immediately with a registration confirmation — end the turn normally and do not wait: '
  + 'the card ships after this turn\'s completion notice, and the user\'s selections arrive as new '
  + '[后续处理] messages, where a checked option is authorization to start that item.'

/**
 * Register the `feishu_bridge_followups` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerFollowupsTool(ctx: Context, route: (caller: unknown) => SubtaskRoute | undefined): () => void {
  return ctx.tools.register(defineTool({
    name: 'feishu_bridge_followups',
    description: DESCRIPTION,
    parameters: {
      options: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: {
              type: 'string',
              required: true,
              description: 'Short option title naming the finding.',
            },
            description: {
              type: 'string',
              required: true,
              description: '`path:line` plus the suggested action in one sentence.',
            },
            recommended: {
              type: 'boolean',
              description: 'Mark the options worth handling; they render pre-checked on the card.',
            },
          },
        },
        description: 'One option per finding from the closing reply\'s findings section.',
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
      if (args.options.length === 0) {
        throw new Error('feishu_bridge_followups: at least one option is required (skip the call when there are no findings)')
      }
      const target = route(exec.agent)
      if (target === undefined) {
        throw new Error('feishu_bridge_followups: the calling session is not owned by a feishu-bridge project')
      }
      const { engine, sessionKey } = target
      const question: UserQuestion = {
        id: FOLLOWUPS_ID,
        question: FOLLOWUPS_QUESTION,
        header: FOLLOWUPS_ASK_HEADER,
        multiSelect: true,
        options: args.options,
      }
      const decision = await engine.askUser(sessionKey, { kind: 'questions', questions: [question] })
      const first = decision.answers?.[0]
      return { status: 'ok' as const, message: first?.custom ?? '' }
    },
  }))
}
