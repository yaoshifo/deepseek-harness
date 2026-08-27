/**
 * The model-facing `feishu_bridge_chatroom` tool: the cc-connect
 * `/chatroom/*` HTTP handlers and CLI subcommand surface (start / ask /
 * gather / pick-roles / pick-topic / ask-human / end / list / note) ported
 * to a dsh tool (plan D4). The caller agent resolves its owning Engine +
 * engine session key through the shared router — no process env, because
 * ToolRunContext carries the caller agent and the plugin owns the
 * agent→engine mapping.
 *
 * Model-visible outputs mirror the Go CLI's result sentences (adapted to
 * the tool surface), so the tool result replays the same guidance the Go
 * moderator saw.
 *
 * @module dsh-feishu-bridge/tools-chatroom
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubtaskAgentRouter } from './subtask.js'
import { declareToolFamily } from '../streaming.js'
import {
  askHuman,
  askRole,
  chatroomLedgerDirFor,
  endChatroom,
  gatherRoles,
  interruptChatroom,
  listChatroomRoles,
  noteChatroom,
  startChatroom,
} from '../engine/chatroom.js'
import {
  renderChatroomPickCardAndPush,
  renderChatroomTopicPickCardAndPush,
} from '../engine/chatroom-pick.js'
import { listRoleNames, roleEssence } from '../engine/chatroom-roles.js'

const DESCRIPTION =
  'Run a multi-role chatroom discussion: several independent role agents (each with its own persona '
  + 'directory and accumulated memory) discuss a topic while you (the moderator) orchestrate. Use for '
  + 'multi-role / round-table discussions made of real independent agents. start: spawn the role groups '
  + '(or list available roles). ask: address ONE role with a question (serial roundtable). gather: '
  + 'broadcast ONE question to ALL roles in parallel; the engine wakes you exactly once with every '
  + 'reply (research: true marks a research round — roles drive full assistants, longer timeout). '
  + 'pick-roles: submit role recommendations as a JSON array; the engine renders a multi-select card '
  + 'for the user. pick-topic: submit candidate topics as a JSON array; the engine renders a '
  + 'single-select card. ask-human: a ROLE asks the user a question only the human knows; the '
  + 'discussion suspends until they reply. end: tear the chatroom down. note: update the shared '
  + 'ledger\'s synthesis (or subproblems) section.'

interface RolePickJSON {
  name: string
  recommended: boolean
  blurb: string
}

interface TopicPickJSON {
  title: string
  recommended: boolean
  blurb: string
}

/** Parse a JSON array of picks, rejecting malformed payloads loudly. */
function parsePicks<T>(raw: string, kind: 'roles' | 'topics'): T[] {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error(`feishu_bridge_chatroom: ${kind} JSON is required`)
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`feishu_bridge_chatroom: ${kind} JSON is malformed: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`feishu_bridge_chatroom: ${kind} JSON must be an array`)
  }
  return parsed as T[]
}

/**
 * Register the `feishu_bridge_chatroom` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerChatroomTool(ctx: Context, route: SubtaskAgentRouter): () => void {
  // The tag color for this tool's progress entries is declared here, not
  // hardcoded in streaming.ts — the tool's owner states its family.
  const undeclare = declareToolFamily('feishu_bridge_chatroom', 'agent')
  const disposeTool = ctx.tools.register(defineTool({
    name: 'feishu_bridge_chatroom',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'ask', 'gather', 'pick-roles', 'pick-topic', 'ask-human', 'end', 'list', 'note'],
        description: 'start = spawn role groups; ask = question one role; gather = broadcast to all roles; '
          + 'pick-roles = submit role recommendations; pick-topic = submit candidate topics; ask-human = a role '
          + 'asks the user; end = tear down (add force: true to interrupt immediately from any state); '
          + 'list = available roles; note = update the ledger.',
      },
      message: {
        type: 'string',
        description: 'start: the topic. ask/gather/ask-human: the question. note: the synthesis/subproblem text.',
      },
      role: {
        type: 'string',
        description: 'ask only: target role name (or session key).',
      },
      roles: {
        type: 'string',
        description: 'start only: comma-separated role names; omit to use every configured role.',
      },
      picks: {
        type: 'string',
        description: 'pick-roles/pick-topic only: JSON array — [{"name","recommended","blurb"}] for roles, '
          + '[{"title","recommended","blurb"}] for topics.',
      },
      section: {
        type: 'string',
        enum: ['synthesis', 'subproblems'],
        description: 'note only: which ledger section to update (default synthesis).',
      },
      research: {
        type: 'boolean',
        description: 'gather only: mark this round as research (roles drive full assistants, longer timeout).',
      },
      force: {
        type: 'boolean',
        description: 'end only: interrupt immediately instead of draining — consumes armed gathers/end barriers, '
          + 'stops every in-flight role and assistant turn, tears down without a closing summary. Use when replies '
          + 'will never arrive (assistants user-stopped) or the user asked to abort.',
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
        throw new Error('feishu_bridge_chatroom: the calling session is not owned by a feishu-bridge project')
      }
      const { engine, sessionKey } = target
      switch (args.action) {
        case 'start': {
          const topic = (args.message ?? '').trim()
          if (topic === '') throw new Error('feishu_bridge_chatroom: start requires a topic (message)')
          const roles = (args.roles ?? '').split(',').map(r => r.trim()).filter(r => r !== '')
          const started = await startChatroom(engine, sessionKey, roles, topic)
          const lines = started.map(r => `  • ${r.name} (session ${r.sessionKey})`)
          return {
            status: 'ok' as const,
            message: `Chatroom started on "${topic}" with ${started.length} role(s):\n${lines.join('\n')}\n`
              + 'Roles are idle. Address one with action: ask (role: <name>).',
          }
        }
        case 'ask': {
          const role = (args.role ?? '').trim()
          if (role === '') throw new Error('feishu_bridge_chatroom: ask requires a role (name or session key)')
          const question = (args.message ?? '').trim()
          if (question === '') throw new Error('feishu_bridge_chatroom: ask requires a question (message)')
          await askRole(engine, sessionKey, role, question)
          return {
            status: 'ok' as const,
            message: `Asked role "${role}"; its reply will be relayed to the chatroom as 【${role}】 and wake you.`,
          }
        }
        case 'gather': {
          const question = (args.message ?? '').trim()
          if (question === '') throw new Error('feishu_bridge_chatroom: gather requires a question (message)')
          gatherRoles(engine, sessionKey, question, args.research === true)
          return {
            status: 'ok' as const,
            message: 'Gathered all roles in parallel; replies will be collected and you will be woken once '
              + 'with the full set. End your turn now.',
          }
        }
        case 'pick-roles': {
          const recs = parsePicks<RolePickJSON>(args.picks ?? '', 'roles')
          renderChatroomPickCardAndPush(engine, sessionKey, recs.map(r => ({
            name: r.name,
            recommended: r.recommended,
            blurb: r.blurb,
          })))
          return {
            status: 'ok' as const,
            message: 'Pick-roles submitted; the role-selection card has been rendered in the chatroom. '
              + 'End your turn now.',
          }
        }
        case 'pick-topic': {
          const topics = parsePicks<TopicPickJSON>(args.picks ?? '', 'topics')
          renderChatroomTopicPickCardAndPush(engine, sessionKey, topics.map(t => ({
            title: t.title,
            recommended: t.recommended,
            blurb: t.blurb,
          })))
          return {
            status: 'ok' as const,
            message: 'Pick-topic submitted; the topic-selection card has been rendered in the chatroom. '
              + 'End your turn now.',
          }
        }
        case 'ask-human': {
          const question = (args.message ?? '').trim()
          if (question === '') throw new Error('feishu_bridge_chatroom: ask-human requires a question (message)')
          await askHuman(engine, sessionKey, question)
          return {
            status: 'ok' as const,
            message: 'Question sent to the human; the discussion is suspended until they reply in the chat. '
              + 'Their reply is routed back to you automatically.',
          }
        }
        case 'end': {
          if (args.force === true) {
            const res = interruptChatroom(engine, sessionKey)
            return {
              status: 'ok' as const,
              message: `Chatroom interrupted; ${res.rolesRemoved} role group(s) cleaned up`
                + (res.missing.length > 0 ? `; unreceived replies: ${res.missing.join(', ')}` : '')
                + '. No closing turn — the user aborted. Do not orchestrate further.',
            }
          }
          const res = endChatroom(engine, sessionKey)
          if (res.status === 'pending') {
            return {
              status: 'ok' as const,
              message: `End pending: draining in-flight role replies (${res.inFlight.join(', ')}; timeout ${res.timeoutSecs}s). `
                + 'You will be woken with the closing summary when they land.',
            }
          }
          return {
            status: 'ok' as const,
            message: `Chatroom ended; ${res.rolesRemoved} role group(s) cleaned up. Give the closing summary now.`,
          }
        }
        case 'list': {
          const inRoom = listChatroomRoles(engine, sessionKey)
          if (inRoom.length > 0) {
            return {
              status: 'ok' as const,
              message: `Roles in this chatroom:\n${inRoom.map(r => `  • ${r.name} (session ${r.sessionKey})`).join('\n')}`,
            }
          }
          const rolesDir = engine.chatroomRolesDir()
          const names = [...listRoleNames(rolesDir)].sort()
          if (names.length === 0) return { status: 'ok' as const, message: '(no roles configured)' }
          const lines = names.map((n) => {
            const ess = roleEssence(rolesDir, n)
            return ess !== '' ? `  • ${n} — ${ess}` : `  • ${n}`
          })
          return { status: 'ok' as const, message: `Available roles:\n${lines.join('\n')}` }
        }
        case 'note': {
          const text = (args.message ?? '').trim()
          if (text === '') throw new Error('feishu_bridge_chatroom: note requires text (message)')
          await noteChatroom(engine, sessionKey, args.section ?? 'synthesis', text)
          const dir = chatroomLedgerDirFor(engine, sessionKey)
          return {
            status: 'ok' as const,
            message: `Ledger updated (${args.section ?? 'synthesis'}).${dir !== undefined ? ` Directory: ${dir}` : ''}`,
          }
        }
        default:
          // Unreachable: the schema enum rejects anything else before execute.
          throw new Error('feishu_bridge_chatroom: unknown action')
      }
    },
  }))
  return () => {
    disposeTool()
    undeclare()
  }
}
