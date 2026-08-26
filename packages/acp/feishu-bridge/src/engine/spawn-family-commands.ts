/**
 * Spawn-family commands ported from cc-connect core/engine_cmd_session.go:
 * /tag (cmdTag), /untag (cmdUntag), /undone (cmdUndone), /notify (cmdNotify),
 * and /board (cmdDashboard + familyChats + renderDashboardTree). The tag and
 * avatar axes are independent: /tag-/untag own the heart tag, /done-/undone
 * own the phase avatar and dashboard-active state. Go's dashboard
 * done-button snapshot/refresh machinery is not ported — the tree renders
 * links only, so no refresh path exists.
 *
 * Registration lives here (not in engine/commands.ts) so this domain cannot
 * collide with parallel work on that file; {@link
 * registerSpawnFamilyCommands} merges into whatever command table the engine
 * already carries.
 *
 * @module dsh-feishu-bridge/spawn-family-commands
 */

import { newCard, type CardElement } from '../card.js'
import { Msg } from '../i18n/index.js'
import type { Message, Platform, SpawnedChatInfo } from '../core/types.js'
import {
  asChatActiveTagger,
  asChatPhasePainter,
  asChatTagRemover,
  asReactionAdder,
  asSpawnedChatActivator,
  asSpawnedChatLister,
  activeTagNameFor,
} from '../core/types.js'
import type { Engine } from './engine.js'

/** Canonical names for the family commands (Go builtinCommands entries). */
const familyAliases: Record<string, string[]> = {
  tag: ['tag'],
  untag: ['untag'],
  undone: ['undone'],
  notify: ['notify'],
  board: ['board', 'db'],
}

/**
 * Register /tag /untag /undone /notify /board on an engine. Returns the
 * disposer.
 * @param e - The engine whose command table and resolver to install on.
 * @returns The disposer removing the handlers and restoring the resolver.
 */
export function registerSpawnFamilyCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('tag', (p, msg) => { void cmdTag(e, p, msg); return true })
  handlers.set('untag', (p, msg) => { void cmdUntag(e, p, msg); return true })
  handlers.set('undone', (p, msg) => { void cmdUndone(e, p, msg); return true })
  handlers.set('notify', (p, msg, args) => { void cmdNotify(e, p, msg, args); return true })
  handlers.set('board', (p, msg) => { void cmdBoard(e, p, msg); return true })
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    for (const [id, names] of Object.entries(familyAliases)) {
      if (names.some(n => n === cmd || (n.startsWith(cmd) && cmd.length >= 2))) return id
    }
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    for (const id of Object.keys(familyAliases)) handlers.delete(id)
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/** /tag: apply the active heart tag to the current chat (Go cmdTag). */
async function cmdTag(e: Engine, p: Platform, msg: Message): Promise<void> {
  const tagger = asChatActiveTagger(p)
  if (tagger === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.TagNotSupported))
    return
  }
  try {
    await tagger.applyActiveTag(msg.sessionKey)
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.TagError, errorMessage(error)))
    return
  }
  // Tag-only: dashboard-active state is owned by the avatar axis.
  asReactionAdder(p)?.addReaction(msg.replyCtx, 'Tag')
}

/** /untag: remove the heart tag from the current chat (Go cmdUntag). */
async function cmdUntag(e: Engine, p: Platform, msg: Message): Promise<void> {
  const remover = asChatTagRemover(p)
  if (remover === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.UntagNotSupported))
    return
  }
  try {
    await remover.removeTagFromChat(msg.sessionKey, activeTagNameFor(p))
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.UntagError, errorMessage(error)))
    return
  }
  // Tag-only: dashboard-active state is owned by the avatar axis.
  asReactionAdder(p)?.addReaction(msg.replyCtx, 'Untag')
}

/** /undone: restore the baseline-phase avatar and dashboard-active state (Go cmdUndone). */
async function cmdUndone(e: Engine, p: Platform, msg: Message): Promise<void> {
  const painter = asChatPhasePainter(p)
  if (painter === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.UndoneNotSupported))
    return
  }
  try {
    await painter.setChatPhase(msg.sessionKey, painter.chatBasePhase(msg.sessionKey))
  } catch (error) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.UndoneError, errorMessage(error)))
    return
  }
  // Fire-and-forget like the Go path: the avatar is already restored; a
  // failed dashboard-state persist only degrades the board.
  void asSpawnedChatActivator(p)?.markSpawnedChatActive(msg.sessionKey)
  asReactionAdder(p)?.addReaction(msg.replyCtx, 'Undone')
}

/**
 * /notify: re-send the spawn/fork readiness card in the current chat with
 * role-based jump links; args become a card note (Go cmdNotify).
 */
async function cmdNotify(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  const sessions = e.sessions
  const workDir = e.perChatWorkDir(e.dirOverrideKey(msg.sessionKey))
  const cur = sessions.getOrCreateActive(msg.sessionKey)
  let note = args.join(' ').trim()

  const jumpMD = await e.spawnJumpMarkdown(p, sessions, cur, msg.sessionKey)
  if ((jumpMD === undefined || jumpMD.content === '') && note === '' && cur.getParentSessionKey() === '') {
    note = e.i18n.t(Msg.NotifyNoChildren)
  }

  await e.buildCompletionUsage({
    totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
    nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
    numTurns: 0, compactionCount: 0,
  })
  const card = await e.buildSpawnNotifyCard(
    workDir,
    e.i18n.t(Msg.SpawnGroupReady),
    note,
    jumpMD ?? { content: '' },
    msg.sessionKey,
  )
  await e.replyWithCard(p, msg.replyCtx, card)
}

/**
 * /board: show the current chat's family tree of spawned groups (Go
 * cmdDashboard — family subtree only, not every spawned group).
 */
async function cmdBoard(e: Engine, p: Platform, msg: Message): Promise<void> {
  const allChats: SpawnedChatInfo[] = []
  for (const plat of e.platforms) {
    const lister = asSpawnedChatLister(plat)
    if (lister === undefined) continue
    try {
      allChats.push(...await lister.listActiveSpawnedChats())
    } catch (error) {
      console.warn(`board: list spawned chats failed (${plat.name()}): ${String(error)}`)
    }
  }

  // Parent→child links, shared across bot groups: chat ID → parent chat ID
  // from session ParentSessionKey.
  const parentOf = new Map<string, string>()
  const { idToKey } = e.sessions.sessionKeyMap()
  for (const s of e.sessions.allSessions()) {
    const ck = rawChatID(idToKey[s.id] ?? '')
    const pk = rawChatID(s.getParentSessionKey())
    if (ck !== '' && pk !== '') parentOf.set(ck, pk)
  }

  const currentChatID = rawChatID(msg.sessionKey)
  const builder = newCard().title('Dashboard', 'purple')
  if (allChats.length === 0) {
    builder.markdown('_暂无活跃任务群_')
    await e.replyWithCard(p, msg.replyCtx, builder.build())
    return
  }
  const family = familyChats(allChats, parentOf, currentChatID)
  if (family.length === 0) {
    builder.markdown('_当前群不在任何任务树中_')
    await e.replyWithCard(p, msg.replyCtx, builder.build())
    return
  }
  renderDashboardTree(e, builder, family, parentOf, currentChatID, p)
  builder.note(`当前任务树 ${family.length} 个群`)
  await e.replyWithCard(p, msg.replyCtx, builder.build())
}

/** Chat ID without the platform prefix (Go rawChatID). */
function rawChatID(sessionKey: string): string {
  if (sessionKey === '') return ''
  const parts = sessionKey.split(':', 3)
  return parts[1] ?? ''
}

/**
 * The subset of chats belonging to currentChatID's family tree: walk up to
 * the topmost spawned ancestor, then collect the whole subtree beneath it
 * (Go familyChats). A non-spawned current chat roots at its direct spawned
 * children.
 */
function familyChats(
  chats: SpawnedChatInfo[],
  parentOf: Map<string, string>,
  currentChatID: string,
): SpawnedChatInfo[] {
  const active = new Set(chats.map(c => c.chatID))
  const childrenOf = new Map<string, string[]>()
  for (const c of chats) {
    const parent = parentOf.get(c.chatID)
    if (parent !== undefined && parent !== '' && active.has(parent)) {
      const list = childrenOf.get(parent) ?? []
      list.push(c.chatID)
      childrenOf.set(parent, list)
    }
  }

  let roots: string[] = []
  if (active.has(currentChatID)) {
    let root = currentChatID
    const visited = new Set([currentChatID])
    for (;;) {
      const parent = parentOf.get(root)
      if (parent === undefined || parent === '' || !active.has(parent) || visited.has(parent)) break
      root = parent
      visited.add(root)
    }
    roots = [root]
  } else {
    for (const c of chats) {
      if (parentOf.get(c.chatID) === currentChatID) roots.push(c.chatID)
    }
  }

  const want = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) continue
    if (want.has(id)) continue
    want.add(id)
    stack.push(...(childrenOf.get(id) ?? []))
  }

  return chats.filter(c => want.has(c.chatID))
}

/**
 * Render spawned chats as an indented parent→child tree of chat links (Go
 * renderDashboardTree): nested chats under a collapsible panel, leaves as
 * `└─ [name](url)` markdown lines, the current chat marked with ←. Cycles
 * and orphans render flat so nothing is dropped.
 */
function renderDashboardTree(
  e: Engine,
  builder: ReturnType<typeof newCard>,
  chats: SpawnedChatInfo[],
  parentOf: Map<string, string>,
  currentChatID: string,
  p: Platform,
): void {
  const byID = new Map<string, SpawnedChatInfo>()
  const order: string[] = []
  for (const c of chats) {
    if (!byID.has(c.chatID)) order.push(c.chatID)
    byID.set(c.chatID, c)
  }

  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const id of order) {
    const parent = parentOf.get(id)
    if (parent === undefined || parent === '' || !byID.has(parent)) {
      roots.push(id)
      continue
    }
    const list = childrenOf.get(parent) ?? []
    list.push(id)
    childrenOf.set(parent, list)
  }

  const visited = new Set<string>()
  const renderNode = (id: string, depth: number): CardElement | undefined => {
    if (visited.has(id)) return undefined
    visited.add(id)
    const c = byID.get(id)
    if (c === undefined) return undefined
    const name = c.chatName !== '' ? c.chatName : id
    const url = e.chatJumpURL(p, id)
    const isCurrent = c.chatID === currentChatID
    const children = childrenOf.get(id) ?? []
    if (children.length === 0) {
      const prefix = depth > 0 ? '└─ ' : ''
      let content = `${prefix}[${name}](${url})`
      if (isCurrent) content += ' ←'
      return { kind: 'markdown', content }
    }
    const subElements: CardElement[] = []
    for (const child of children) {
      const el = renderNode(child, depth + 1)
      if (el !== undefined) subElements.push(el)
    }
    let title = `[${name}](${url})`
    if (isCurrent) title += ' ←'
    return { kind: 'collapsiblePanel', title, titleIsMD: true, border: 'grey', expanded: true, elements: subElements }
  }

  const elements: CardElement[] = []
  for (const id of roots) {
    const el = renderNode(id, 0)
    if (el !== undefined) elements.push(el)
  }
  for (const id of order) {
    if (!visited.has(id)) {
      const el = renderNode(id, 0)
      if (el !== undefined) elements.push(el)
    }
  }
  builder.raw(...elements)
}

/** String form of an unknown error (Go %v formatting). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
