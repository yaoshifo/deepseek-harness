/**
 * The `/cron` command family ported from cc-connect core/engine_cmd_cron.go:
 * add/addexec/list/del/enable/disable/mute/unmute/setup plus the cron list
 * card with per-job action buttons. Registration lives here (not in
 * engine/commands.ts) so the M6 cron domain cannot collide with parallel
 * work on that file; {@link registerCronCommands} merges into whatever
 * command table the engine already carries.
 *
 * @module dsh-feishu-bridge/cron-commands
 */

import {
  MsgAdminRequired,
  MsgCardBack,
  MsgCardTitleCron,
  MsgCronAddExecUsage,
  MsgCronAddUsage,
  MsgCronAdded,
  MsgCronAddedExec,
  MsgCronBtnDelete,
  MsgCronBtnDisable,
  MsgCronBtnEnable,
  MsgCronBtnMute,
  MsgCronBtnUnmute,
  MsgCronCardHint,
  MsgCronDelUsage,
  MsgCronDeleted,
  MsgCronDisabled,
  MsgCronEmpty,
  MsgCronEnabled,
  MsgCronFailedSuffix,
  MsgCronIDLabel,
  MsgCronLastRunLabel,
  MsgCronListFooter,
  MsgCronListTitle,
  MsgCronMuted,
  MsgCronNextRunLabel,
  MsgCronNotAvailable,
  MsgCronNotFound,
  MsgCronScheduleLabel,
  MsgCronUnmuted,
  MsgCronUsage,
  MsgError,
  MsgSetupNative,
} from '../i18n/index.js'
import { defaultBtn, dangerBtn, newCard, primaryBtn, type Card, type CardButton } from '../card.js'
import { asCardSender, type Message, type Platform } from '../core/types.js'
import type { Engine } from './engine.js'
import { isAdmin } from './commands.js'
import { CronJob, cronExprToHuman, generateCronID, truncateStr } from './cron.js'

/** Whether the platform can render interactive cards (Go supportsCards). */
function supportsCards(p: Platform): boolean {
  return asCardSender(p) !== undefined
}

/** Prefix-match a subcommand against candidates (Go matchSubCommand). */
function matchSubCommand(input: string, candidates: string[]): string {
  for (const c of candidates) {
    if (input === c) return c
  }
  let matched = ''
  for (const c of candidates) {
    if (c.startsWith(input)) {
      if (matched !== '') return input // ambiguous → raw input hits default
      matched = c
    }
  }
  return matched
}

/** "01-02 15:04", or with the year when it differs from now (Go cronTimeFormat). */
function cronTimeFormat(t: Date, now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (t.getFullYear() !== now.getFullYear()) {
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
  }
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

/**
 * Register the `/cron` command family on an engine. Merges into an existing
 * command table (registerSessionCommands) instead of replacing it, and
 * chains the prefix resolver so `/cron` and its ≥2-char prefixes resolve
 * while every other command keeps its current resolution. Returns the
 * disposer.
 */
export function registerCronCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('cron', (p, msg, args) => { void cmdCron(e, p, msg, args); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'cron' || (cmd.length >= 2 && 'cron'.startsWith(cmd))) return 'cron'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('cron')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/** The /cron list card with per-job buttons (Go Engine.renderCronCard). */
export function renderCronCard(e: Engine, sessionKey: string, _userID: string): Card {
  const scheduler = e.cronScheduler
  if (scheduler === undefined) {
    return simpleCard(e.i18n.t(MsgCardTitleCron), 'orange', e.i18n.t(MsgCronNotAvailable))
  }

  const jobs = scheduler.store().listBySessionKey(sessionKey)
  if (jobs.length === 0) {
    return simpleCard(e.i18n.t(MsgCardTitleCron), 'orange', e.i18n.t(MsgCronEmpty))
  }

  const lang = e.i18n.currentLang()
  const now = new Date()

  const cb = newCard().title(e.i18n.t(MsgCardTitleCron), 'orange')
  cb.markdownf(e.i18n.t(MsgCronListTitle), jobs.length)

  for (const j of jobs) {
    const status = j.enabled
      ? "<text_tag color='green'>active</text_tag>"
      : "<text_tag color='grey'>paused</text_tag>"

    let desc = j.description
    if (desc === '') {
      desc = j.isShellJob() ? `🖥 ${truncateStr(j.exec, 60)}` : truncateStr(j.prompt, 60)
    }
    if (j.mute) desc += ' [mute]'

    const human = cronExprToHuman(j.cronExpr, lang)

    let sb = ''
    sb += `${status} ${desc}\n`
    sb += e.i18n.tf(MsgCronIDLabel, j.id)
    sb += e.i18n.tf(MsgCronScheduleLabel, human, j.cronExpr)
    const nextRun = scheduler.nextRun(j.id)
    if (nextRun !== undefined) {
      sb += e.i18n.tf(MsgCronNextRunLabel, cronTimeFormat(nextRun, now))
    }
    if (j.lastRun !== '') {
      sb += e.i18n.tf(MsgCronLastRunLabel, cronTimeFormat(new Date(j.lastRun), now))
      if (j.lastError !== '') {
        sb += e.i18n.tf(MsgCronFailedSuffix, `<text_tag color='red'>${truncateStr(j.lastError, 40)}</text_tag>`)
      }
      sb += '\n'
    }
    cb.markdown(sb)

    const btns: CardButton[] = []
    if (j.enabled) {
      btns.push(defaultBtn(e.i18n.t(MsgCronBtnDisable), `act:/cron disable ${j.id}`))
    } else {
      btns.push(primaryBtn(e.i18n.t(MsgCronBtnEnable), `act:/cron enable ${j.id}`))
    }
    if (j.mute) {
      btns.push(defaultBtn(e.i18n.t(MsgCronBtnUnmute), `act:/cron unmute ${j.id}`))
    } else {
      btns.push(defaultBtn(e.i18n.t(MsgCronBtnMute), `act:/cron mute ${j.id}`))
    }
    btns.push(dangerBtn(e.i18n.t(MsgCronBtnDelete), `act:/cron delete ${j.id}`))
    cb.buttonsEqual(...btns)
  }

  cb.divider()
  cb.note(e.i18n.t(MsgCronCardHint))
  cb.buttons(defaultBtn(e.i18n.t(MsgCardBack), 'nav:/help'))
  return cb.build()
}

/** A title-only informational card (Go Engine.simpleCard). */
function simpleCard(title: string, color: string, body: string): Card {
  return newCard().title(title, color).markdown(body).build()
}

/** The `/cron` dispatcher (Go Engine.cmdCron). */
export async function cmdCron(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const scheduler = e.cronScheduler
  if (scheduler === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronNotAvailable))
    return
  }

  if (args.length === 0) {
    if (!supportsCards(p)) {
      await cmdCronList(e, p, msg)
      return
    }
    await e.replyWithCard(p, msg.replyCtx, renderCronCard(e, msg.sessionKey, msg.userID))
    return
  }

  const sub = matchSubCommand((args[0] ?? '').toLowerCase(), [
    'add', 'addexec', 'list', 'del', 'delete', 'rm', 'remove', 'enable', 'disable', 'mute', 'unmute', 'setup',
  ])
  switch (sub) {
    case 'add':
      await cmdCronAdd(e, p, msg, args.slice(1))
      break
    case 'addexec':
      await cmdCronAddExec(e, p, msg, args.slice(1))
      break
    case 'list':
      await cmdCronList(e, p, msg)
      break
    case 'del': case 'delete': case 'rm': case 'remove':
      await cmdCronDel(e, p, msg, args.slice(1))
      break
    case 'enable':
      await cmdCronToggle(e, p, msg, args.slice(1), true)
      break
    case 'disable':
      await cmdCronToggle(e, p, msg, args.slice(1), false)
      break
    case 'mute':
      await cmdCronMute(e, p, msg, args.slice(1), true)
      break
    case 'unmute':
      await cmdCronMute(e, p, msg, args.slice(1), false)
      break
    case 'setup':
      await cmdCronSetup(e, p, msg)
      break
    default:
      await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronUsage))
  }
}

/** `/cron add <min> <hour> <day> <month> <weekday> <prompt...>` (Go cmdCronAdd). */
export async function cmdCronAdd(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  if (args.length < 6) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronAddUsage))
    return
  }

  const cronExpr = args.slice(0, 5).join(' ')
  const prompt = args.slice(5).join(' ')

  const job = new CronJob()
  job.id = generateCronID()
  job.project = e.name
  job.sessionKey = msg.sessionKey
  job.cronExpr = cronExpr
  job.prompt = prompt
  job.enabled = true
  job.createdAt = new Date().toISOString()

  try {
    e.cronScheduler?.addJob(job)
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgError, String(error instanceof Error ? error.message : error)))
    return
  }

  await e.reply(p, msg.replyCtx, e.i18n.tf(MsgCronAdded, job.id, cronExpr, truncateStr(prompt, 60)))
}

/** `/cron addexec <min> <hour> <day> <month> <weekday> <shell command...>` (Go cmdCronAddExec, admin-only). */
export async function cmdCronAddExec(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  if (!isAdmin(e, msg.userID)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgAdminRequired, '/cron addexec'))
    return
  }

  if (args.length < 6) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronAddExecUsage))
    return
  }

  const cronExpr = args.slice(0, 5).join(' ')
  const shellCmd = args.slice(5).join(' ')

  const job = new CronJob()
  job.id = generateCronID()
  job.project = e.name
  job.sessionKey = msg.sessionKey
  job.cronExpr = cronExpr
  job.exec = shellCmd
  job.enabled = true
  job.createdAt = new Date().toISOString()

  try {
    e.cronScheduler?.addJob(job)
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgError, String(error instanceof Error ? error.message : error)))
    return
  }

  await e.reply(p, msg.replyCtx, e.i18n.tf(MsgCronAddedExec, job.id, cronExpr, truncateStr(shellCmd, 60)))
}

/** `/cron list` as plain text (Go cmdCronList). */
export async function cmdCronList(e: Engine, p: Platform, msg: Message): Promise<void> {
  const scheduler = e.cronScheduler
  if (scheduler === undefined) return
  const jobs = scheduler.store().listByProject(e.name)
  if (jobs.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronEmpty))
    return
  }

  const lang = e.i18n.currentLang()
  const now = new Date()
  let sb = ''
  sb += e.i18n.tf(MsgCronListTitle, jobs.length)
  sb += '\n'
  sb += '\n'

  for (const [i, j] of jobs.entries()) {
    if (i > 0) sb += '\n'

    const status = j.enabled ? '✅' : '⏸'
    let desc = j.description
    if (desc === '') {
      desc = j.isShellJob() ? `🖥 ${truncateStr(j.exec, 60)}` : truncateStr(j.prompt, 60)
    }
    if (j.mute) desc += ' [mute]'
    sb += `${status} ${desc}\n`

    sb += `ID: ${j.id}\n`

    sb += e.i18n.tf(MsgCronScheduleLabel, cronExprToHuman(j.cronExpr, lang), j.cronExpr)

    const nextRun = scheduler.nextRun(j.id)
    if (nextRun !== undefined) {
      sb += e.i18n.tf(MsgCronNextRunLabel, cronTimeFormat(nextRun, now))
    }

    if (j.lastRun !== '') {
      sb += e.i18n.tf(MsgCronLastRunLabel, cronTimeFormat(new Date(j.lastRun), now))
      if (j.lastError !== '') {
        sb += ` (failed: ${truncateStr(j.lastError, 40)})`
      }
      sb += '\n'
    }
  }

  sb += `\n${e.i18n.t(MsgCronListFooter)}`
  await e.reply(p, msg.replyCtx, sb)
}

/** `/cron del <id>` (Go cmdCronDel). */
export async function cmdCronDel(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  if (args.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronDelUsage))
    return
  }
  const id = args[0] ?? ''
  if (e.cronScheduler?.removeJob(id)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgCronDeleted, id))
  } else {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgCronNotFound, id))
  }
}

/** `/cron enable|disable <id>` (Go cmdCronToggle). */
export async function cmdCronToggle(e: Engine, p: Platform, msg: Message, args: string[], enable: boolean): Promise<void> {
  if (args.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronDelUsage))
    return
  }
  const id = args[0] ?? ''
  try {
    if (enable) {
      e.cronScheduler?.enableJob(id)
    } else {
      e.cronScheduler?.disableJob(id)
    }
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgError, String(error instanceof Error ? error.message : error)))
    return
  }
  await e.reply(p, msg.replyCtx, enable ? e.i18n.tf(MsgCronEnabled, id) : e.i18n.tf(MsgCronDisabled, id))
}

/** `/cron mute|unmute <id>` (Go cmdCronMute). */
export async function cmdCronMute(e: Engine, p: Platform, msg: Message, args: string[], mute: boolean): Promise<void> {
  if (args.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(MsgCronDelUsage))
    return
  }
  const id = args[0] ?? ''
  if (!e.cronScheduler?.store().setMute(id, mute)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(MsgCronNotFound, id))
    return
  }
  await e.reply(p, msg.replyCtx, mute ? e.i18n.tf(MsgCronMuted, id) : e.i18n.tf(MsgCronUnmuted, id))
}

/**
 * `/cron setup` (Go cmdCronSetup). The dsh agent receives its bridge
 * instructions through the per-agent setup hook (plan D3) rather than a
 * memory file, so the setup result is always the native one.
 */
export async function cmdCronSetup(e: Engine, p: Platform, msg: Message): Promise<void> {
  await e.reply(p, msg.replyCtx, e.i18n.t(MsgSetupNative))
}

/**
 * Execute a card-button action for the cron domain (Go
 * Engine.executeCardAction's "/cron" case): `act:/cron <sub> <id>` buttons
 * enable/disable/delete/mute/unmute jobs.
 */
export function executeCardAction(e: Engine, cmd: string, args: string, _sessionKey: string): void {
  if (cmd !== '/cron') return
  const scheduler = e.cronScheduler
  if (scheduler === undefined || args === '') return
  const subArgs = args.trim().split(/\s+/)
  if (subArgs.length < 2) return
  const sub = subArgs[0] ?? ''
  const id = subArgs[1] ?? ''
  switch (sub) {
    case 'enable':
      try {
        scheduler.enableJob(id)
      } catch (error) {
        console.warn(`engine: enable cron job failed (${id}): ${String(error)}`)
      }
      break
    case 'disable':
      try {
        scheduler.disableJob(id)
      } catch (error) {
        console.warn(`engine: disable cron job failed (${id}): ${String(error)}`)
      }
      break
    case 'delete':
      scheduler.removeJob(id)
      break
    case 'mute':
      scheduler.store().setMute(id, true)
      break
    case 'unmute':
      scheduler.store().setMute(id, false)
      break
    default:
      break
  }
}
