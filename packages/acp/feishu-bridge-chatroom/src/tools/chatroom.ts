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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool, normalizeKeyStyleVariants, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { SubtaskAgentRouter } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { declareToolFamily } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomConfig } from '../chatroom-config.ts'
import { Msg } from '../i18n.ts'
import {
  askHuman,
  askRole,
  chatroomLedgerDirFor,
  chatroomResearchWorkspace,
  endChatroom,
  gatherRoles,
  interruptChatroom,
  listChatroomRoles,
  noteChatroom,
  resolveChatroomHubKey,
  resolveChatroomInheritPrior,
  startChatroom,
  type ChatroomInheritTarget,
} from '../engine/chatroom.ts'
import { listChatroomLedgers } from '../engine/chatroom-ledger.ts'
import {
  renderChatroomPickCardAndPush,
  renderChatroomTopicPickCardAndPush,
} from '../engine/chatroom-pick.ts'
import { listRoleNames, roleEssence } from '../engine/chatroom-roles.ts'
import { chatroomUserProfileError } from '../engine/chatroom-cmd.ts'
import { chatroomState } from '../chatroom-state.ts'

const DESCRIPTION =
  'Run a multi-role chatroom discussion: several independent role agents (each with its own persona '
  + 'directory and accumulated memory) discuss a topic while you (the moderator) orchestrate. Use for '
  + 'multi-role / round-table discussions made of real independent agents. start: spawn the role groups '
  + '(or list available roles); pass inherit: a past chatroom to continue from (topic substring or '
  + 'ledger dir name, empty = the newest) — the engine seeds a prior-context pointer that stays '
  + 'unverified until you screen it. ask: address ONE role with a question (serial roundtable). gather: '
  + 'broadcast ONE question to ALL roles in parallel; the engine wakes you exactly once with every '
  + 'reply (research: true marks a research round — roles drive full assistants, longer timeout). '
  + 'pick-roles: submit role recommendations as a JSON array; the engine renders a multi-select card '
  + 'for the user. pick-topic: submit candidate topics as a JSON array; the engine renders a '
  + 'single-select card. ask-human: a ROLE asks the user a question only the human knows; the '
  + 'discussion suspends until they reply. end: tear the chatroom down. note: update the shared '
  + 'ledger\'s synthesis (or subproblems, or report — the closing summary) section. history: list past '
  + 'chatrooms (topic, status, ledger dir, reports) and the shared research-data workspace.'

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

/** Per-kind pick item keys; key-style variants normalize to these before the cast. */
const PICK_ITEM_SCHEMAS: Record<'roles' | 'topics', JsonSchemaNode> = {
  roles: {
    type: 'object',
    properties: { name: { type: 'string' }, recommended: { type: 'boolean' }, blurb: { type: 'string' } },
    required: ['name'],
  },
  topics: {
    type: 'object',
    properties: { title: { type: 'string' }, recommended: { type: 'boolean' }, blurb: { type: 'string' } },
    required: ['title'],
  },
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
  const schema: JsonSchemaNode = { type: 'array', items: PICK_ITEM_SCHEMAS[kind] }
  const normalized = normalizeKeyStyleVariants(schema, parsed)
  // Model-produced JSON is a trust boundary: validate item shapes here so a
  // wrong-typed or missing name/title fails with a schema message instead of
  // a raw TypeError from the card renderer.
  const violations = validateJsonSchemaValue(schema, normalized)
  if (violations.length > 0) {
    throw new Error(`feishu_bridge_chatroom: ${kind} JSON items invalid: ${violations.join('; ')}`)
  }
  return normalized as T[]
}

/**
 * Register the `feishu_bridge_chatroom` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerChatroomTool(ctx: Context, route: SubtaskAgentRouter): () => void {
  // The tag family is declared at registration (the tool's owner states
  // it); streaming.ts's static agentTools set also names this tool, so the
  // declaration is redundant for the color today.
  const undeclare = declareToolFamily('feishu_bridge_chatroom', 'agent')
  const disposeTool = ctx.tools.register(defineTool({
    name: 'feishu_bridge_chatroom',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'ask', 'gather', 'pick-roles', 'pick-topic', 'ask-human', 'end', 'list', 'note', 'history'],
        description: 'start = spawn role groups; ask = question one role; gather = broadcast to all roles; '
          + 'pick-roles = submit role recommendations; pick-topic = submit candidate topics; ask-human = a role '
          + 'asks the user; end = tear down (add force: true to interrupt immediately from any state); '
          + 'list = available roles; note = update the ledger; history = past chatrooms and shared research data.',
      },
      message: {
        type: 'string',
        description: 'start: the topic. ask/gather/ask-human: the question. note: the synthesis/subproblem/report text.',
      },
      role: {
        type: 'string',
        description: 'ask only: target role name (or session key).',
      },
      roles: {
        type: 'string',
        description: 'start only: comma-separated role names; omit to use every configured role.',
      },
      inherit: {
        type: 'string',
        description: 'start only: a past chatroom to continue from — a ledger dir name or a topic substring; '
          + 'empty = the newest chatroom. Seeds a prior-context pointer into the new ledger; the prior '
          + 'judgements stay unverified until you screen and adopt them.',
      },
      picks: {
        type: 'string',
        description: 'pick-roles/pick-topic only: JSON array — [{"name","recommended","blurb"}] for roles, '
          + '[{"title","recommended","blurb"}] for topics.',
      },
      section: {
        type: 'string',
        enum: ['synthesis', 'subproblems', 'report'],
        description: 'note only: which ledger section to update (default synthesis; report = the closing summary).',
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
      // Disabled projects normally never see this tool (the plugin masks the
      // definition on the bridge service); this gate covers sessions created
      // in the startup window before the mask was registered.
      if (!chatroomConfig(engine).enabled()) {
        throw new Error('feishu_bridge_chatroom: the chatroom is disabled for this project')
      }
      switch (args.action) {
        case 'start': {
          const topic = (args.message ?? '').trim()
          if (topic === '') throw new Error('feishu_bridge_chatroom: start requires a topic (message)')
          // A role or assistant group cannot become a nested moderator: the
          // command path's role-list guard cannot see this — it only checks
          // roles parented on the CALLING session.
          const callerState = chatroomState(engine.sessions.getOrCreateActive(sessionKey))
          if (callerState.chatroomHubKey !== '' || callerState.researchAssistant) {
            throw new Error(engine.i18n.t(Msg.ChatroomStartMemberForbidden))
          }
          // Same already-running guard as the /chatroom command: a repeat
          // start would spawn a second generation of role groups under the
          // live hub.
          if (listChatroomRoles(engine, sessionKey).length > 0) {
            throw new Error(engine.i18n.t(Msg.ChatroomAlreadyRunning))
          }
          // Same fail-loud referent check as the /chatroom command: a
          // configured-but-unreadable user profile blocks the start.
          const profileError = chatroomUserProfileError(engine)
          if (profileError !== '') throw new Error(profileError)
          const roles = (args.roles ?? '').split(',').map(r => r.trim()).filter(r => r !== '')
          // inherit resolves BEFORE spawning so an unresolvable reference
          // fails without side effects; '' (bare) takes the newest chatroom.
          let prior: ChatroomInheritTarget | undefined
          if (args.inherit !== undefined) {
            prior = resolveChatroomInheritPrior(engine, args.inherit.trim())
          }
          const started = await startChatroom(engine, sessionKey, roles, topic, prior)
          const lines = started.map(r => `  • ${r.name} (session ${r.sessionKey})`)
          const priorLine = prior !== undefined
            ? `Continuing from 「${prior.topic}」 — the prior-context pointer is seeded into the ledger; its judgements are UNVERIFIED until you Read, screen, and note the adopted parts into the synthesis.\n`
            : ''
          return {
            status: 'ok' as const,
            message: `Chatroom started on "${topic}" with ${started.length} role(s):\n${lines.join('\n')}\n`
              + priorLine
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
          // Only the moderator hub may end: a role passing its own key would
          // pass endChatroom's barrier checks (barriers live on the hub) and
          // tear down only its own subtree — force even stops its own turn —
          // while the real hub's armed barriers drain to their timeouts.
          const hubKey = resolveChatroomHubKey(engine, sessionKey)
          if (hubKey === '') {
            // A session outside any chatroom is not a role/assistant group —
            // the moderator-only text would misdiagnose and point at
            // /chatroom stop, which would answer not-in-room itself.
            throw new Error(engine.i18n.t(Msg.ChatroomNotInRoom))
          }
          if (hubKey !== sessionKey) {
            throw new Error(engine.i18n.t(Msg.ChatroomEndModeratorOnly))
          }
          if (args.force === true) {
            const res = interruptChatroom(engine, hubKey)
            return {
              status: 'ok' as const,
              message: `Chatroom interrupted; ${res.rolesRemoved} role group(s) cleaned up`
                + (res.missing.length > 0 ? `; unreceived replies: ${res.missing.join(', ')}` : '')
                + '. No closing turn — the user aborted. Do not orchestrate further.',
            }
          }
          const res = endChatroom(engine, hubKey)
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
          const rolesDir = chatroomConfig(engine).rolesDir()
          const names = [...listRoleNames(rolesDir)].sort()
          if (names.length === 0) return { status: 'ok' as const, message: '(no roles configured)' }
          const lines = names.map((n) => {
            const ess = roleEssence(rolesDir, n)
            return ess !== '' ? `  • ${n} — ${ess}` : `  • ${n}`
          })
          return { status: 'ok' as const, message: `Available roles:\n${lines.join('\n')}` }
        }
        case 'history': {
          const mod = chatroomConfig(engine).moderatorDir()
          if (!mod.ok) {
            throw new Error('feishu_bridge_chatroom: no chatroom history (moderator dir not configured)')
          }
          const entries = listChatroomLedgers(join(mod.dir, 'ledgers'))
          const lines = entries.map((l) => {
            const status = l.header.endedStatus === 'ended'
              ? 'ended'
              : l.header.endedStatus === 'interrupted' ? 'interrupted' : 'unfinished'
            const reports = l.reports.length > 0 ? `; reports: ${l.reports.join(', ')}` : ''
            const prior = l.header.prior !== '' ? `; prior: ${l.header.prior}` : ''
            return `  • ${l.header.started || '?'} [${status}] 「${l.header.topic}」 roles: ${l.header.roles.join(', ')} — ${l.dir}${reports}${prior}`
          })
          let message = entries.length === 0
            ? 'No past chatrooms recorded yet.'
            : 'Past chatrooms, newest first (each entry is THAT discussion\'s conclusion — an unverified judgement, not established fact):\n'
              + lines.join('\n')
          const ws = chatroomResearchWorkspace(engine)
          if (ws !== '' && existsSync(join(ws, 'DATA_LEDGER.md'))) {
            message += `\nShared research data (reusable across chatrooms): workspace ${ws}; fetch ledger ${join(ws, 'DATA_LEDGER.md')} — check the source/scope/fetched-at columns before reusing a dataset (data/core/ holds common pulls, data/<role>/ per-role ones).`
          }
          return { status: 'ok' as const, message }
        }
        case 'note': {
          const text = (args.message ?? '').trim()
          if (text === '') throw new Error('feishu_bridge_chatroom: note requires text (message)')
          // Mirror end's resolution: a role session would otherwise resolve
          // the ledger dir from its own key and surface a raw ENOENT from a
          // nonexistent directory.
          const noteHubKey = resolveChatroomHubKey(engine, sessionKey)
          if (noteHubKey === '') {
            throw new Error(engine.i18n.t(Msg.ChatroomNotInRoom))
          }
          if (noteHubKey !== sessionKey) {
            throw new Error(engine.i18n.t(Msg.ChatroomNoteModeratorOnly))
          }
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
