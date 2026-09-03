/**
 * The `/provider` command family ported from cc-connect
 * core/engine_provider.go (#9 全局 Providers / #12 per-provider switching),
 * reshaped to per-chat semantics: bare listing, `switch <name> [--resume]`,
 * `current`, and `clear` all act on the chat the command ran in. A switch
 * pins that session's route override (which wins over the project default
 * for that chat only and persists across restarts); a plain switch drops the
 * session (the next message starts fresh on the new route); `--resume` keeps
 * the agent session id so the next message resumes the same transcript under
 * the new route (MIGRATION.md D1: dispose + resume with new agentOptions).
 * The project default route itself never moves at runtime — chats without
 * an override keep using it. The add/remove/preset flows are not ported: a
 * provider is a named llm route in the profile config, which the runtime
 * cannot create. Card platforms render the bare listing as the provider
 * card (Go renderProviderCard): a plain/hot mode row selects whether the
 * `act:/provider <name>[-r]` rows drop the session or keep the transcript,
 * and the pressed card refreshes in place.
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

import type { Message, Platform, ProviderSwitcher } from '../core/types.ts'
import { asProviderSwitcher, supportsCards } from '../core/types.ts'
import { Msg } from '../i18n/index.ts'
import { defaultBtn, newCard, type Card } from '../card.ts'
import type { Engine } from './engine.ts'

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
function providerListText(e: Engine, switcher: ProviderSwitcher, sessionKey: string): string {
  const current = switcher.getActiveProvider(sessionKey)
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
 * routes. The current line and the ▶ marker resolve the session's override
 * first, so two chats can sit on different routes.
 *
 * @param e - Engine owning the switcher and i18n.
 * @param notice - Extra markdown line under the current line (the outcome of a pressed row).
 * @param sessionKey - Engine session key whose effective route marks the current line.
 * @param hot - Hot-switch mode: rows carry the `-r` flag (keep context) instead of dropping the
 * session. Defaults to hot — the card opens hot-switched; the card action passes the pressed mode explicitly.
 * @returns The assembled card; a red not-supported card when the agent has no switcher.
 */
function renderProviderCard(e: Engine, notice: string, sessionKey: string, hot = true): Card {
  const switcher = asProviderSwitcher(e.agent)
  if (switcher === undefined) {
    return newCard().title(e.i18n.t(Msg.ProviderCardTitle), 'red')
      .markdown(e.i18n.t(Msg.ProviderNotSupported)).build()
  }
  const current = switcher.getActiveProvider(sessionKey)
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
      { text: e.i18n.t(Msg.ProviderCardModeHot), type: hot ? 'primary' : 'default', value: 'nav:/provider -r' },
      { text: e.i18n.t(Msg.ProviderCardModePlain), type: hot ? 'default' : 'primary', value: 'nav:/provider' },
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
  // the mode row carries `nav:/provider` [-r] with no route name, and the
  // help card's provider entry opens the hot default (`nav:/provider -r`).
  // Both prefixes share the handler because the
  // card owns every action value it emits: the -r flag can only arrive on a
  // value this card produced, and a non-empty route name is always a
  // pressed row.
  const disposeCardAction = e.registerCardAction(['/provider'], (sessionKey, _cmd, args) => {
    const { name, resume } = parseProviderResumeFlag(args.split(/\s+/).filter(a => a !== ''))
    const switcher = asProviderSwitcher(e.agent)
    if (name === '' || switcher === undefined) return renderProviderCard(e, '', sessionKey, resume)
    const notice = applyProviderSwitch(e, sessionKey, switcher, name, resume)
      ? e.i18n.tf(resume ? Msg.ProviderHotSwitched : Msg.ProviderSwitched, name)
      : e.i18n.tf(Msg.ProviderNotFound, name)
    return renderProviderCard(e, notice, sessionKey, resume)
  })
  return () => {
    handlers.delete('provider')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
    e.providerShortcutHandler = undefined
    disposeCardAction()
  }
}

/** /provider: list, switch, current, clear (Go cmdProvider; per-chat routes). */
async function cmdProvider(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const switcher = asProviderSwitcher(e.agent)
  if (switcher === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderNotSupported))
    return
  }

  if (args.length === 0) {
    if (supportsCards(p)) {
      await e.replyWithCard(p, msg.replyCtx, renderProviderCard(e, '', msg.sessionKey))
      return
    }
    await e.reply(p, msg.replyCtx, providerListText(e, switcher, msg.sessionKey))
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
      await e.reply(p, msg.replyCtx, providerListText(e, switcher, msg.sessionKey))
      return
    }
    case 'switch': {
      if (args.length < 2) {
        await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderSwitchUsage))
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
      const current = switcher.getActiveProvider(msg.sessionKey)
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
      // Clearing drops this chat's override (the project default stays) and
      // starts the next message fresh on the default route, matching a
      // plain switch's session handling.
      switcher.setSessionProvider(msg.sessionKey, '')
      e.stopInteractiveSession(msg.sessionKey)
      const s = e.sessions.getOrCreateActive(msg.sessionKey)
      s.setAgentSessionID('', '')
      e.sessions.save()
      saveProvider(e, msg.sessionKey, '')
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

/** Persist one session's route override; save failures only warn (Go slog.Error). */
function saveProvider(e: Engine, sessionKey: string, name: string): void {
  if (e.providerSaveFunc === undefined) return
  try {
    e.providerSaveFunc(sessionKey, name)
  } catch (error) {
    console.error(`provider: failed to save session provider: ${String(error)}`)
  }
}

/**
 * Run the switch side effects shared by the text commands and a pressed
 * provider-card row (Go switchProvider/switchProviderResume minus the
 * reply): pin this session's route override, handle the agent session id,
 * and persist the choice. A plain switch drops the id (the next message
 * starts fresh on the new route); a resume switch captures it before the
 * interactive-session stop and restores it after, so the next message
 * resumes the same transcript under the new route's agentOptions (history
 * is NOT cleared). Other chats' routes are untouched.
 *
 * @param e - Engine owning the sessions and the persistence hook.
 * @param sessionKey - Session whose route is pinned and whose agent session id is handled.
 * @param switcher - Agent provider switcher.
 * @param name - Route to pin for this session.
 * @param resume - True keeps the agent session id (Go --resume); false drops it.
 * @returns True when the route exists and the switch ran; false leaves all state untouched.
 */
function applyProviderSwitch(e: Engine, sessionKey: string, switcher: ProviderSwitcher, name: string, resume: boolean): boolean {
  if (!switcher.setSessionProvider(sessionKey, name)) return false
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
  saveProvider(e, sessionKey, name)
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

/** A provider shortcut (/strong): switch this chat + fresh session in one step (Go cmdProviderShortcut). */
async function cmdProviderShortcut(e: Engine, p: Platform, msg: Message, providerName: string): Promise<void> {
  const switcher = asProviderSwitcher(e.agent)
  if (switcher === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ProviderNotSupported))
    return
  }
  if (!switcher.setSessionProvider(msg.sessionKey, providerName)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderNotFound, providerName))
    return
  }

  e.stopInteractiveSession(msg.sessionKey)
  const old = e.sessions.getOrCreateActive(msg.sessionKey)
  old.setAgentSessionID('', '')
  e.sessions.save()
  e.sessions.newSession(msg.sessionKey, '')
  saveProvider(e, msg.sessionKey, providerName)
  await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ProviderShortcutNew, providerName))
}
