/**
 * The model-facing `feishu_bridge_relay` tool: the cc-connect `/relay/*`
 * HTTP handlers and CLI surface (send / bind / binding) ported to a dsh
 * tool (plan D4). The caller agent resolves its owning Engine + engine
 * session key through the router; `from` is the engine's own project name
 * and the routed session key supplies platform + chat.
 *
 * Model-visible outputs are the Go CLI's result sentences verbatim.
 *
 * @module dsh-feishu-bridge/tools-relay
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseSessionKeyParts } from '../engine/relay.js'
import type { SubtaskRoute } from './subtask.js'

/** Resolves the calling dsh agent to its engine session (shared with the subtask tool). */
export type RelayAgentRouter = (agent: unknown) => SubtaskRoute | undefined

const DESCRIPTION =
  'Relay a message to another bound bot in this group chat and wait for its response. '
  + 'Bots are bound together with the /bind command in the chat; send delivers your message to the target '
  + 'project\'s agent and returns its reply (both sides are mirrored into the group chat). '
  + 'bind: add bots (project names, including yourself) to a binding for this chat; '
  + 'binding: show the current binding for this chat.'

/**
 * Register the `feishu_bridge_relay` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerRelayTool(ctx: Context, route: RelayAgentRouter): () => void {
  return ctx.tools.register(defineTool({
    name: 'feishu_bridge_relay',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['send', 'bind', 'binding'],
        description: 'send = deliver a message to another bound bot and return its response; '
          + 'bind = bind bots together in this chat; binding = show the current binding.',
      },
      to: {
        type: 'string',
        description: 'send only: the target project name (exact name, from /bind status or the binding list).',
      },
      message: {
        type: 'string',
        description: 'send only: the message to deliver.',
      },
      bots: {
        type: 'string',
        description: 'bind only: comma-separated project names to bind in this chat (at least 2, including yourself).',
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
      const target = route(exec.agent)
      if (target === undefined) {
        throw new Error('feishu_bridge_relay: the calling session is not owned by a feishu-bridge project')
      }
      const { engine, sessionKey } = target
      const rm = engine.relayManager
      if (rm === undefined) {
        throw new Error('feishu_bridge_relay: relay not available')
      }
      const [platform, chatID] = parseSessionKeyParts(sessionKey)
      switch (args.action) {
        case 'send': {
          const to = (args.to ?? '').trim()
          const message = (args.message ?? '').trim()
          if (to === '' || message === '') {
            throw new Error('feishu_bridge_relay: send requires the target project (to) and a message')
          }
          const resp = await rm.send({ from: engine.name, to, sessionKey, message })
          return { status: 'ok' as const, message: resp.response }
        }
        case 'bind': {
          const bots = (args.bots ?? '').split(',').map(b => b.trim()).filter(b => b !== '')
          if (bots.length < 2) {
            throw new Error('feishu_bridge_relay: bind requires at least 2 comma-separated project names (bots)')
          }
          const botMap: Record<string, string> = {}
          for (const bot of bots) botMap[bot] = bot
          rm.bind(platform, chatID, botMap)
          return { status: 'ok' as const, message: `Relay binding created for this chat: ${bots.join(' ↔ ')}` }
        }
        case 'binding': {
          const binding = rm.getBinding(chatID)
          if (binding === undefined) {
            return { status: 'ok' as const, message: 'No relay binding for this chat. Use /bind <project> first.' }
          }
          return {
            status: 'ok' as const,
            message: `Current relay binding: ${Object.keys(binding.bots).join(' ↔ ')}`,
          }
        }
        default:
          // Unreachable: the schema enum rejects anything else before execute.
          throw new Error('feishu_bridge_relay: unknown action')
      }
    },
  }))
}
