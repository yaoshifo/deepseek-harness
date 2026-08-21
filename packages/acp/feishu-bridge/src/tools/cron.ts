/**
 * The model-facing `feishu_bridge_cron` tool: the cc-connect `/cron/*` HTTP
 * handlers and CLI subcommand surface (add / list / info / edit / del)
 * ported to a dsh tool (plan D4). The caller agent resolves its owning
 * Engine + engine session key through the router — the Go CLI's
 * CC_PROJECT/CC_SESSION_KEY env contract, without env, because
 * ToolRunContext carries the caller agent.
 *
 * Model-visible outputs are the Go CLI's result sentences verbatim.
 *
 * @module dsh-feishu-bridge/tools-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CronJob, generateCronID, normalizeCronSessionMode } from '../engine/cron.js'
import type { SubtaskRoute } from './subtask.js'

/** Resolves the calling dsh agent to its engine session (shared with the subtask tool). */
export type CronAgentRouter = (agent: unknown) => SubtaskRoute | undefined

const DESCRIPTION =
  'Manage scheduled tasks (standard 5-field cron expressions) bound to this chat session. '
  + 'add: create a task that runs a prompt in this conversation (or a shell command with exec) on a schedule; '
  + 'list: show this project\'s tasks with ids, schedules, and last-run state; '
  + 'info: fetch one task by id; edit: change one field (cron_expr, prompt, exec, description, enabled, mute, '
  + 'session_mode, mode, timeout_mins, silent, work_dir); del: remove a task by id. '
  + 'The user can also manage tasks directly with the /cron command in the chat.'

/** Format one job the way the Go CLI's list output did. */
function jobLine(j: CronJob): string {
  const state = j.enabled ? 'active' : 'paused'
  const desc = j.description !== '' ? j.description : (j.isShellJob() ? j.exec : j.prompt)
  const mute = j.mute ? ' [mute]' : ''
  return `${state}${mute} ${j.id}  ${j.cronExpr}  ${desc}`
}

/**
 * Register the `feishu_bridge_cron` tool on `ctx.tools`.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param route - resolves the calling agent to its engine + session key.
 * @returns the exact disposer that unregisters the tool.
 */
export function registerCronTool(ctx: Context, route: CronAgentRouter): () => void {
  return ctx.tools.register(defineTool({
    name: 'feishu_bridge_cron',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'list', 'info', 'edit', 'del'],
        description: 'add = create a scheduled task; list = show this project\'s tasks; info = fetch one task; '
          + 'edit = change one field; del = remove a task.',
      },
      cronExpr: {
        type: 'string',
        description: 'add only: standard 5-field cron expression (minute hour day-of-month month day-of-week), '
          + 'e.g. "0 9 * * 1-5" every weekday at 09:00 or "*/30 * * * *" every 30 minutes.',
      },
      prompt: {
        type: 'string',
        description: 'add only: the prompt the agent runs on schedule (mutually exclusive with exec).',
      },
      exec: {
        type: 'string',
        description: 'add only: a shell command to run instead of an agent prompt (mutually exclusive with prompt).',
      },
      description: {
        type: 'string',
        description: 'add only: human-readable task description shown in lists and start notices.',
      },
      sessionMode: {
        type: 'string',
        enum: ['reuse', 'new_per_run'],
        description: 'add only: reuse (default) runs in this chat\'s active session; new_per_run uses a fresh '
          + 'session for every run.',
      },
      timeoutMins: {
        type: 'number',
        description: 'add only: minutes to wait for each run (default 30; 0 = wait without limit).',
      },
      mode: {
        type: 'string',
        description: 'add only: permission mode override for the run (default, bypassPermissions, acceptEdits, '
          + 'plan, auto, dontAsk).',
      },
      workDir: {
        type: 'string',
        description: 'add only: working directory for the run (default: this session\'s).',
      },
      silent: {
        type: 'boolean',
        description: 'add only: suppress the "⏰ task started" notice (default false).',
      },
      id: {
        type: 'string',
        description: 'info/edit/del: the task id from add/list.',
      },
      field: {
        type: 'string',
        description: 'edit only: the field to change (cron_expr, prompt, exec, description, enabled, mute, '
          + 'session_mode, mode, timeout_mins, silent, work_dir).',
      },
      value: {
        type: 'string',
        description: 'edit only: the new value; booleans as "true"/"false", numbers as digits.',
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
    execute(args, exec) {
      return Promise.resolve(runCronAction(route, args, { agent: exec.agent }))
    },
  }))
}

/** The model-facing arguments of the cron tool, one row per parameter. */
export interface CronToolArgs {
  action: string
  cronExpr?: string
  prompt?: string
  exec?: string
  description?: string
  sessionMode?: string
  timeoutMins?: number
  mode?: string
  workDir?: string
  silent?: boolean
  id?: string
  field?: string
  value?: string
}
/** The synchronous cron action dispatcher (execute wraps it in a Promise). */
function runCronAction(route: CronAgentRouter, args: CronToolArgs, exec: { agent: unknown }): { status: 'ok'; message: string } {
  const target = route(exec.agent)
  if (target === undefined) {
    throw new Error('feishu_bridge_cron: the calling session is not owned by a feishu-bridge project')
  }
  const { engine, sessionKey } = target
  const scheduler = engine.cronScheduler
  if (scheduler === undefined) {
    throw new Error('feishu_bridge_cron: cron scheduler not available')
  }
  switch (args.action) {
    case 'add': {
      const cronExpr = (args.cronExpr ?? '').trim()
      const prompt = (args.prompt ?? '').trim()
      const execCmd = (args.exec ?? '').trim()
      if (cronExpr === '') throw new Error('feishu_bridge_cron: add requires a cron expression (cronExpr)')
      if (prompt === '' && execCmd === '') throw new Error('feishu_bridge_cron: add requires either prompt or exec')
      if (prompt !== '' && execCmd !== '') throw new Error('feishu_bridge_cron: prompt and exec are mutually exclusive')
      const job = new CronJob()
      job.id = generateCronID()
      job.project = engine.name
      job.sessionKey = sessionKey
      job.cronExpr = cronExpr
      job.prompt = prompt
      job.exec = execCmd
      job.description = (args.description ?? '').trim()
      job.enabled = true
      job.createdAt = new Date().toISOString()
      job.silent = args.silent
      job.sessionMode = normalizeCronSessionMode(args.sessionMode ?? '')
      job.mode = args.mode ?? ''
      job.workDir = (args.workDir ?? '').trim()
      job.timeoutMins = args.timeoutMins
      scheduler.addJob(job)
      const what = execCmd !== '' ? `Command: ${execCmd}` : `Prompt: ${prompt}`
      return {
        status: 'ok' as const,
        message: `Cron job created: ${job.id}\nSchedule: ${cronExpr}\n${what}`,
      }
    }
    case 'list': {
      const jobs = scheduler.store().listByProject(engine.name)
      if (jobs.length === 0) return { status: 'ok' as const, message: 'No cron jobs for this project.' }
      return {
        status: 'ok' as const,
        message: jobs.map(jobLine).join('\n'),
      }
    }
    case 'info': {
      const id = (args.id ?? '').trim()
      if (id === '') throw new Error('feishu_bridge_cron: info requires the task id')
      const job = scheduler.store().get(id)
      if (job === undefined) throw new Error(`job "${id}" not found`)
      return {
        status: 'ok' as const,
        message: `${jobLine(job)}\n${JSON.stringify(job.toJSON())}`,
      }
    }
    case 'edit': {
      const id = (args.id ?? '').trim()
      const field = (args.field ?? '').trim()
      if (id === '') throw new Error('feishu_bridge_cron: edit requires the task id')
      if (field === '') throw new Error('feishu_bridge_cron: edit requires the field name')
      if (args.value === undefined || args.value === '') throw new Error('feishu_bridge_cron: edit requires the new value')
      let value: unknown = args.value
      if (field === 'enabled' || field === 'mute' || field === 'silent') {
        if (args.value !== 'true' && args.value !== 'false') {
          throw new Error(`feishu_bridge_cron: field ${field} needs "true" or "false"`)
        }
        value = args.value === 'true'
      } else if (field === 'timeout_mins') {
        const n = Number.parseInt(args.value, 10)
        if (!Number.isInteger(n) || n < 0) throw new Error('feishu_bridge_cron: timeout_mins must be an integer >= 0')
        value = n
      }
      scheduler.updateJob(id, field, value)
      return { status: 'ok' as const, message: `Cron job ${id} updated: ${field} = ${args.value}` }
    }
    case 'del': {
      const id = (args.id ?? '').trim()
      if (id === '') throw new Error('feishu_bridge_cron: del requires the task id')
      if (!scheduler.removeJob(id)) throw new Error(`job "${id}" not found`)
      return { status: 'ok' as const, message: `Cron job ${id} deleted.` }
    }
    default:
      // Unreachable: the schema enum rejects anything else before execute.
      throw new Error('feishu_bridge_cron: unknown action')
  }
}
