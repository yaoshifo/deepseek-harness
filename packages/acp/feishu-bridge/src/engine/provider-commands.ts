/**
 * The `/provider` command family ported from cc-connect
 * core/engine_provider.go (#9 全局 Providers / #12 per-provider switching):
 * bare listing, `switch <name> [--resume]`, `current`, and `clear`. A plain
 * switch drops the session (the next message starts fresh on the new
 * route); `--resume` keeps the agent session id so the next message
 * resumes the same transcript under the new route (MIGRATION.md D1:
 * dispose + resume with new agentOptions). The add/remove/preset flows and
 * the provider card are not ported: a provider is a named llm route in the
 * profile config, which the runtime cannot create, and the card surface
 * arrives with the M7 render domain.
 *
 * Registration lives here (not in engine/commands.ts) so the provider
 * domain cannot collide with parallel work on that file;
 * {@link registerProviderCommands} merges into whatever command table the
 * engine already carries and also arms the provider_shortcuts quick
 * commands (/strong → provider + new session) through the engine's
 * shortcut dispatch hook.
 *
 * @module dsh-feishu-bridge/provider-commands
 */

import type { Message, Platform, ProviderSwitcher } from '../core/types.js'
import { asProviderSwitcher } from '../core/types.js'
import { Msg } from '../i18n/index.js'
import type { Engine } from './engine.js'

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

/** Reject unknown flags among the args (Go unknownFlag). */
function unknownFlag(args: string[], allowed: Record<string, boolean>): string {
  for (const arg of args) {
    if (arg.startsWith('-') && !allowed[arg]) return arg
  }
  return ''
}

/** Extract the provider name and the --resume/-r flag (Go parseProviderResumeFlag). */
function parseProviderResumeFlag(args: string[]): { name: string; resume: boolean } {
  let name = ''
  let resume = false
  for (const arg of args) {
    if (arg === '--resume' || arg === '-r') resume = true
    else name = arg
  }
  return { name, resume }
}

/** One /provider list body: current header, marked rows, switch hint. */
function providerListText(e: Engine, switcher: ProviderSwitcher): string {
  const current = switcher.getActiveProvider()
  const providers = switcher.listProviders()
  if (current === undefined && providers.length === 0) return e.i18n.t(Msg.ProviderNone)
  let sb = ''
  if (current !== undefined) {
    sb += `${e.i18n.tf(Msg.ProviderCurrent, current.name)}\n\n`
  }
  sb += e.i18n.t(Msg.ProviderListTitle)
  for (const prov of providers) {
    const marker = current !== undefined && prov.name === current.name ? '▶ ' : '  '
    sb += `${marker}${prov.name}\n`
  }
  return sb + `\n${e.i18n.t(Msg.ProviderSwitchHint)}`
}

/**
 * Register the /provider command family and the provider-shortcut dispatch
 * hook on an engine. Returns the disposer.
 */
export function registerProviderCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('provider', (p, msg, args) => { void cmdProvider(e, p, msg, args); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'provider' || (cmd.length >= 2 && 'provider'.startsWith(cmd))) return 'provider'
    return prevResolver?.(cmd) ?? ''
  }
  // Provider shortcuts (/strong → glm): dispatched from the engine's
  // shortcut hook when no builtin command claims the token.
  e.providerShortcutHandler = (p, msg, providerName) => { void cmdProviderShortcut(e, p, msg, providerName) }
  return () => {
    handlers.delete('provider')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
    e.providerShortcutHandler = undefined
  }
}

/** /provider: list, switch, current, clear (Go cmdProvider). */
async function cmdProvider(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const switcher = asProviderSwitcher(e.agent)
  if (switcher === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderNotSupported))
    return
  }

  if (args.length === 0) {
    await e.reply(p, msg.replyCtx, providerListText(e, switcher))
    return
  }

  const sub = matchSubCommand(args[0]?.toLowerCase() ?? '', ['list', 'switch', 'current', 'clear', 'reset', 'none'])
  switch (sub) {
    case 'list': {
      const providers = switcher.listProviders()
      if (providers.length === 0) {
        await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderListEmpty))
        return
      }
      await e.reply(p, msg.replyCtx, providerListText(e, switcher))
      return
    }
    case 'switch': {
      if (args.length < 2) {
        await e.reply(p, msg.replyCtx, 'Usage: /provider switch <name> [--resume]')
        return
      }
      const bad = unknownFlag(args.slice(1), { '-r': true, '--resume': true })
      if (bad !== '') {
        await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderUnknownFlag, bad))
        return
      }
      const { name, resume } = parseProviderResumeFlag(args.slice(1))
      await (resume ? switchProviderResume : switchProvider)(e, p, msg, switcher, name)
      return
    }
    case 'current': {
      const current = switcher.getActiveProvider()
      if (current === undefined) {
        await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderNone))
        return
      }
      await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderCurrent, current.name))
      return
    }
    case 'clear':
    case 'reset':
    case 'none': {
      switcher.setActiveProvider('')
      e.stopInteractiveSession(msg.sessionKey)
      const s = e.sessions.getOrCreateActive(msg.sessionKey)
      s.setAgentSessionID('', '')
      s.clearHistory()
      e.sessions.save()
      saveProvider(e, '')
      await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderCleared))
      return
    }
    default: {
      const bad = unknownFlag(args, { '-r': true, '--resume': true })
      if (bad !== '') {
        await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderUnknownFlag, bad))
        return
      }
      const { name, resume } = parseProviderResumeFlag(args)
      await (resume ? switchProviderResume : switchProvider)(e, p, msg, switcher, name)
      return
    }
  }
}

/** Persist the active provider name; save failures only warn (Go slog.Error). */
function saveProvider(e: Engine, name: string): void {
  if (e.providerSaveFunc === undefined) return
  try {
    e.providerSaveFunc(name)
  } catch (error) {
    console.error(`provider: failed to save active provider: ${String(error)}`)
  }
}

/** /provider switch: rotate to a fresh session on the new route (Go switchProvider). */
async function switchProvider(e: Engine, p: Platform, msg: Message, switcher: ProviderSwitcher, name: string): Promise<void> {
  if (!switcher.setActiveProvider(name)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderNotFound, name))
    return
  }
  e.stopInteractiveSession(msg.sessionKey)
  const s = e.sessions.getOrCreateActive(msg.sessionKey)
  s.setAgentSessionID('', '')
  s.clearHistory()
  e.sessions.save()
  saveProvider(e, name)
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderSwitched, name))
}

/** /provider switch --resume: keep the transcript, swap the route (Go switchProviderResume). */
async function switchProviderResume(e: Engine, p: Platform, msg: Message, switcher: ProviderSwitcher, name: string): Promise<void> {
  if (!switcher.setActiveProvider(name)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderNotFound, name))
    return
  }
  const s = e.sessions.getOrCreateActive(msg.sessionKey)
  const agentSessionID = s.getAgentSessionID()
  const agentType = s.agentType

  e.stopInteractiveSession(msg.sessionKey)
  // Restore the id so the next start resumes the same transcript under the
  // new route's agentOptions; history is NOT cleared.
  if (agentSessionID !== '') {
    s.setAgentSessionID(agentSessionID, agentType)
  }
  e.sessions.save()
  saveProvider(e, name)
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderHotSwitched, name))
}

/** A provider shortcut (/strong): switch + fresh session in one step (Go cmdProviderShortcut). */
async function cmdProviderShortcut(e: Engine, p: Platform, msg: Message, providerName: string): Promise<void> {
  const switcher = asProviderSwitcher(e.agent)
  if (switcher === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderNotSupported))
    return
  }
  if (!switcher.setActiveProvider(providerName)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderNotFound, providerName))
    return
  }

  e.stopInteractiveSession(msg.sessionKey)
  const old = e.sessions.getOrCreateActive(msg.sessionKey)
  old.setAgentSessionID('', '')
  old.clearHistory()
  e.sessions.save()
  e.sessions.newSession(msg.sessionKey, '')
  saveProvider(e, providerName)
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderShortcutNew, providerName))
}
