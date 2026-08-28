/**
 * The /context command (TS-native, no Go counterpart): renders the chat's
 * context-insight card from the live agent session's projections —
 * occupancy headline, six-bucket composition and per-turn trend charts,
 * recent context events, session statistics, and the top tool schemas — with
 * a refresh button that re-reads the snapshot and PATCHes the card in place.
 *
 * Rendering is pure (src/context/render.ts); this module only resolves the
 * engine-side inputs: the live agent session id (live interactive first,
 * `Engine.activeAgentSessionID`), the adapter's `ContextSnapshotReader`
 * capability, the session display name, and the active provider's model.
 *
 * @module dsh-feishu-bridge/context-commands
 */

import { asContextSnapshotReader, asProviderSwitcher, supportsCards } from '../core/types.js'
import { renderContextCard, CONTEXT_REFRESH_ARG_PREFIX, type ContextCardArgs } from '../context/render.js'
import type { Card } from '../card.js'
import type { Message, Platform } from '../core/types.js'
import type { Engine } from './engine.js'

/**
 * Register /context and its card-refresh action on an engine through the
 * registerCommand and registerCardAction seams (handler map + resolver chain
 * + the agent help-card group, and the `/context` card-action registry).
 *
 * @param e - Engine whose command table and card-action registry gain the entry.
 * @returns The disposer removing both registrations.
 */
export function registerContextCommands(e: Engine): () => void {
  const disposeCommand = e.registerCommand({
    id: 'context',
    handler: (p, msg) => {
      void cmdContext(e, p, msg)
      return true
    },
    match: cmd => (cmd === 'context' || ('context'.startsWith(cmd) && cmd.length >= 2)) ? 'context' : '',
    group: 'agent',
  })
  // The pressed card's refresh button carries `act:/context ctx:<sessionKey>`
  // — the key the card was rendered for wins over the pressing user's own
  // chat key (another user in a per-user-session chat pressing the button
  // still refreshes the session the card belongs to).
  const disposeCardAction = e.registerCardAction(['/context'], (sessionKey, _cmd, args) => {
    const target = args.startsWith(CONTEXT_REFRESH_ARG_PREFIX)
      ? args.slice(CONTEXT_REFRESH_ARG_PREFIX.length).trim()
      : ''
    return contextCard(e, target === '' ? sessionKey : target)
  })
  return () => {
    disposeCardAction()
    disposeCommand()
  }
}

/**
 * /context: render the chat's context-insight card (plain text on
 * non-card platforms — the charts degrade away, the numbers stay).
 *
 * @param e - Engine owning the session state.
 * @param p - Platform that delivered the command message.
 * @param msg - Triggering message; its session key selects the agent session.
 */
async function cmdContext(e: Engine, p: Platform, msg: Message): Promise<void> {
  const card = contextCard(e, msg.sessionKey)
  if (supportsCards(p)) {
    await e.replyWithCard(p, msg.replyCtx, card)
    return
  }
  await e.reply(p, msg.replyCtx, card.renderText())
}

/**
 * Assemble the card for one session key: resolve the live agent session,
 * read its projection snapshot through the adapter capability, and render.
 *
 * @param e - Engine whose session state and agent are read.
 * @param sessionKey - Interactive session key of the chat.
 * @returns The rendered card (the empty-state card when nothing is readable).
 */
function contextCard(e: Engine, sessionKey: string): Card {
  const session = e.sessions.getOrCreateActive(sessionKey)
  const agentSessionID = e.activeAgentSessionID(sessionKey, session)
  let snapshot: ContextCardArgs['snapshot']
  try {
    snapshot = asContextSnapshotReader(e.agent)?.contextSnapshot(agentSessionID)
  } catch (error) {
    // A registering plugin's view parse failed inside the registry's
    // snapshot; the card degrades to the empty state instead of failing the
    // command dispatch.
    console.warn(`context: projection snapshot read failed (${sessionKey}): ${String(error)}`)
  }
  let title = e.sessions.getSessionName(session.getAgentSessionID())
  if (title === '') title = session.getName()
  return renderContextCard({
    sessionKey,
    sessionTitle: title,
    model: displayModel(asProviderSwitcher(e.agent)?.getActiveProvider()?.model ?? ''),
    snapshot,
  })
}

/** The provider route's model name, minus the "[1m]" gateway alias. */
function displayModel(model: string): string {
  return model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model
}
