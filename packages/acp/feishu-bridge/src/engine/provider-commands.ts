/**
 * The `/provider` command family ported from cc-connect
 * core/engine_provider.go (#9 全局 Providers / #12 per-provider switching):
 * bare listing, `switch <name> [--resume]`, `current`, and `clear`. A plain
 * switch drops the session (the next message starts fresh on the new
 * route); `--resume` keeps the agent session id so the next message
 * resumes the same transcript under the new route (MIGRATION.md D1:
 * dispose + resume with new agentOptions). The add/remove/preset flows are
 * not ported: a provider is a named llm route in the profile config, which
 * the runtime cannot create. Card platforms render the bare listing as the
 * provider card (Go renderProviderCard): a plain/hot mode row selects
 * whether the `act:/provider <name>[-r]` rows drop the session or keep the
 * transcript, and the pressed card refreshes in place.
 *
 * Registration lives here (not in engine/commands.ts) so the provider
 * domain cannot collide with parallel work on that file;
 * {@link registerProviderCommands} merges into whatever command table the
 * engine already carries, registers the /provider card action, and also
 * arms the provider_shortcuts quick commands (/strong → provider + new
 * session) through the engine's shortcut dispatch hook.
 *
 * @module dsh-feishu-bridge/provider-commands
 */

import type { Message, Platform, ProviderSwitcher } from '../core/types.js'
import { asProviderSwitcher, supportsCards } from '../core/types.js'
import { Msg } from '../i18n/index.js'
import { defaultBtn, newCard, type Card } from '../card.js'
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
 * The provider card (Go Engine.renderProviderCard): current line, a switch
 * -mode row (plain / hot), one list row per route with an
 * `act:/provider <name>[-r]` switch button, the click hint, and a back
 * button. The add/preset buttons are not ported — the runtime cannot create
 * routes.
 *
 * @param e - Engine owning the switcher and i18n.
 * @param notice - Extra markdown line under the current line (the outcome of a pressed row).
 * @param hot - Hot-switch mode: rows carry the `-r` flag (keep context) instead of dropping the session.
 * @returns The assembled card; a red not-supported card when the agent has no switcher.
 */
function renderProviderCard(e: Engine, notice: string, hot = false): Card {
  const switcher = asProviderSwitcher(e.agent)
  if (switcher === undefined) {
    return newCard().title(e.i18n.t(Msg.ProviderCardTitle), 'red')
      .markdown(e.i18n.t(Msg.ProviderNotSupported)).build()
  }
  const current = switcher.getActiveProvider()
  const providers = switcher.listProviders()
  const cb = newCard().title(e.i18n.t(Msg.ProviderCardTitle), 'indigo')
  if (current === undefined && providers.length === 0) {
    return cb.markdown(e.i18n.t(Msg.ProviderNone))
      .buttons(defaultBtn(e.i18n.t(Msg.CardBack), 'nav:/help'))
      .build()
  }
  if (current !== undefined) cb.markdown(e.i18n.tf(Msg.ProviderCardCurrent, current.name))
  if (notice !== '') cb.markdown(notice)
  if (providers.length > 0) {
    cb.buttonsEqual(
      { text: e.i18n.t(Msg.ProviderCardModePlain), type: hot ? 'default' : 'primary', value: 'nav:/provider' },
      { text: e.i18n.t(Msg.ProviderCardModeHot), type: hot ? 'primary' : 'default', value: 'nav:/provider -r' },
    )
    cb.divider()
    for (const prov of providers) {
      const isActive = current !== undefined && prov.name === current.name
      const model = prov.model ?? ''
      const label = `${isActive ? '▶' : '◻'} **${prov.name}**${model !== '' ? `  \`${model}\`` : ''}`
      cb.listItemBtn(
        label,
        e.i18n.t(hot ? Msg.ProviderCardHotBtn : Msg.ProviderCardSwitchBtn),
        isActive ? 'primary' : 'default',
        `act:/provider ${prov.name}${hot ? ' -r' : ''}`,
      )
    }
    cb.markdown(`\n${e.i18n.t(Msg.ProviderCardHint)}`)
  }
  cb.buttons(defaultBtn(e.i18n.t(Msg.CardBack), 'nav:/help'))
  return cb.build()
}

/**
 * Register the /provider command family, the /provider card action, and
 * the provider-shortcut dispatch hook on an engine. Returns the disposer.
 *
 * @param e - Engine to register the command handler, resolver, card action, and shortcut hook on.
 * @returns Disposer removing the handler and restoring the previous state.
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
  // Provider-card actions: a pressed row carries `act:/provider <name>[-r]`,
  // the mode row and the help card's provider entry carry `nav:/provider`
  // [-r] with no route name. Both prefixes share the handler because the
  // card owns every action value it emits: the -r flag can only arrive on a
  // value this card produced, and a non-empty route name is always a
  // pressed row.
  const disposeCardAction = e.registerCardAction(['/provider'], (sessionKey, _cmd, args) => {
    const { name, resume } = parseProviderResumeFlag(args.split(/\s+/).filter(a => a !== ''))
    const switcher = asProviderSwitcher(e.agent)
    if (name === '' || switcher === undefined) return renderProviderCard(e, '', resume)
    const notice = applyProviderSwitch(e, sessionKey, switcher, name, resume)
      ? e.i18n.tf(resume ? Msg.ProviderHotSwitched : Msg.ProviderSwitched, name)
      : e.i18n.tf(Msg.ProviderNotFound, name)
    return renderProviderCard(e, notice, resume)
  })
  return () => {
    handlers.delete('provider')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
    e.providerShortcutHandler = undefined
    disposeCardAction()
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
    if (supportsCards(p)) {
      await e.replyWithCard(p, msg.replyCtx, renderProviderCard(e, ''))
      return
    }
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
      e.applyActiveProviderContextWindow()
      e.syncUsageProvidersActive()
      e.stopInteractiveSession(msg.sessionKey)
      const s = e.sessions.getOrCreateActive(msg.sessionKey)
      s.setAgentSessionID('', '')
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

/**
 * Run the switch side effects shared by the text commands and a pressed
 * provider-card row (Go switchProvider/switchProviderResume minus the
 * reply): swap the route, re-resolve the context window and usage
 * detectors, handle the agent session id, and persist the choice. A plain
 * switch drops the id (the next message starts fresh on the new route); a
 * resume switch captures it before the interactive-session stop and
 * restores it after, so the next message resumes the same transcript under
 * the new route's agentOptions (history is NOT cleared).
 *
 * @param e - Engine owning the sessions and the persistence hook.
 * @param sessionKey - Session whose agent session id is handled.
 * @param switcher - Agent provider switcher.
 * @param name - Route to activate.
 * @param resume - True keeps the agent session id (Go --resume); false drops it.
 * @returns True when the route exists and the switch ran; false leaves all state untouched.
 */
function applyProviderSwitch(e: Engine, sessionKey: string, switcher: ProviderSwitcher, name: string, resume: boolean): boolean {
  if (!switcher.setActiveProvider(name)) return false
  e.applyActiveProviderContextWindow()
  e.syncUsageProvidersActive()
  const s = e.sessions.getOrCreateActive(sessionKey)
  const agentSessionID = s.getAgentSessionID()
  const agentType = s.agentType
  e.stopInteractiveSession(sessionKey)
  if (resume) {
    if (agentSessionID !== '') {
      s.setAgentSessionID(agentSessionID, agentType)
    }
  } else {
    s.setAgentSessionID('', '')
  }
  e.sessions.save()
  saveProvider(e, name)
  return true
}

/** /provider switch: rotate to a fresh session on the new route (Go switchProvider). */
async function switchProvider(e: Engine, p: Platform, msg: Message, switcher: ProviderSwitcher, name: string): Promise<void> {
  if (!applyProviderSwitch(e, msg.sessionKey, switcher, name, false)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderNotFound, name))
    return
  }
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderSwitched, name))
}

/** /provider switch --resume: keep the transcript, swap the route (Go switchProviderResume). */
async function switchProviderResume(e: Engine, p: Platform, msg: Message, switcher: ProviderSwitcher, name: string): Promise<void> {
  if (!applyProviderSwitch(e, msg.sessionKey, switcher, name, true)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderNotFound, name))
    return
  }
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
  e.applyActiveProviderContextWindow()
  e.syncUsageProvidersActive()

  e.stopInteractiveSession(msg.sessionKey)
  const old = e.sessions.getOrCreateActive(msg.sessionKey)
  old.setAgentSessionID('', '')
  e.sessions.save()
  e.sessions.newSession(msg.sessionKey, '')
  saveProvider(e, providerName)
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderShortcutNew, providerName))
}
