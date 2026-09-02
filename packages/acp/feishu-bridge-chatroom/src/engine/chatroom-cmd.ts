/**
 * The /chatroom command surface ported from cc-connect core/engine_chatroom.go
 * (cmdChatroom + afterChatroomStarted + startChatroomDirectRole +
 * stashChatroomResearchFlags + gateResearchUvOrFail). Registered on the
 * engine by {@link registerChatroomCommands} — a separate file so parallel
 * milestones don't collide in commands.ts.
 *
 * @module dsh-feishu-bridge/chatroom-cmd
 */

import { mkdirSync } from 'node:fs'
import type { Engine } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { emptyMessage } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Message, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { asCardSender, asGroupRenamer } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { chatroomHubGroupName } from './chatroom.ts'
import { newCard } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { Msg } from '../i18n.ts'
import { chatroomState } from '../chatroom-state.ts'
import { chatroomConfig } from '../chatroom-config.ts'
import {
  chatroomAssistantGroupName,
  chatroomLedgerDirFor,
  chatroomResearchWorkspace,
  chatroomStewardGroupName,
  ChatroomRole,
  clearChatroomResearchFlags,
  ensureResearchPythonEnv,
  interruptChatroom,
  listChatroomRoles,
  resolveChatroomHubKey,
  startChatroom,
} from './chatroom.ts'
import {
  maxChatroomResearchRounds,
  minChatroomResearchRounds,
} from './chatroom.ts'
import { listRoleNames, roleDir, roleExists, roleEssence } from './chatroom-roles.ts'
import { beginChatroomPick, beginChatroomTopicPick, executeChatroomCardAction } from './chatroom-pick.ts'
import {
  buildChatroomModeratorPriming,
  buildChatroomResearchModeratorPriming,
} from './chatroom-priming.ts'
import { WorktreeMode } from '@deepseek-ai/dsh-feishu-bridge/exports'

/** Canonical command names for /chatroom (Go builtinCommands entry). */
const chatroomCommandNames = ['chatroom', 'cr']

/** Resolve a typed command prefix to 'chatroom' ('' when unknown). */
function matchChatroomPrefix(cmd: string): string {
  for (const n of chatroomCommandNames) {
    if (n === cmd || (n.startsWith(cmd) && cmd.length >= 2)) return 'chatroom'
  }
  return ''
}

/**
 * Register the /chatroom (alias /cr) command and the picker card actions on
 * an engine that already has its session commands registered — through the
 * engine's registerCommand and registerCardAction seams (handler map +
 * resolver chain + help-card group, and the card-action registry, each in
 * one reversible registration).
 *
 * @param e - Engine whose command table gains the entry.
 * @returns the disposer removing the registration.
 */
export function registerChatroomCommands(e: Engine): () => void {
  const disposeCommand = e.registerCommand({
    id: 'chatroom',
    handler: (p, msg, args) => {
      void cmdChatroom(e, p, msg, args)
      return true
    },
    match: matchChatroomPrefix,
    group: 'session',
  })
  const disposeCardAction = e.registerCardAction(
    ['/chatroom-pick', '/chatroom-topic-pick'],
    (sessionKey, cmd, args) => executeChatroomCardAction(e, sessionKey, cmd, args),
  )
  return () => {
    disposeCardAction()
    disposeCommand()
  }
}

/**
 * /chatroom [--roles a,b] <topic…> | /chatroom a,b <topic…> | /chatroom
 * <topic…> | /chatroom — list, single-role direct chat, research mode, the
 * #43 role picker, and the #59 topic picker (Go cmdChatroom).
 *
 * @param e - Engine whose sessions, platforms, and pickers drive the flow.
 * @param p - Platform that delivered the command message.
 * @param msg - Triggering message; its session key is the hub.
 * @param args - Raw tokens after the command word (flags and topic words).
 */
export async function cmdChatroom(e: Engine, p: Platform, msg: Message, args: string[]): Promise<void> {
  // `/chatroom list` (or 列表) lists every available role — pure display, no
  // spawn — and must short-circuit before the topic/role parser.
  if (args.length > 0 && (args[0] === 'list' || args[0] === '列表')) {
    await cmdChatroomList(e, p, msg)
    return
  }
  // `/chatroom stop` (or 中断) hard-stops the chatroom this chat belongs to,
  // from any protocol state — the escape hatch end cannot offer while a
  // gather is armed.
  if (args.length > 0 && (args[0] === 'stop' || args[0] === '中断')) {
    await cmdChatroomStop(e, p, msg)
    return
  }
  // Re-entry guard: live role groups under this hub mean a chatroom is
  // already running. A second open (direct→multi-role, repeated open, or a
  // fresh picker) would spawn a new generation of role groups while the old
  // ones live on, mixing persona markers under one hub.
  if (listChatroomRoles(e, msg.sessionKey).length > 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ChatroomAlreadyRunning))
    return
  }
  if (e.spawnCapablePlatform() === undefined) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.SpawnNotSupported))
    return
  }
  // Parse: the first positional token is treated as a roles list only if it
  // looks like one (contains a comma or names an existing role); otherwise
  // the whole positional stream is the topic.
  const rolesDir = chatroomConfig(e).rolesDir()
  let rolesCSV = ''
  let topic = ''
  let gotRoles = false
  let research = false
  let researchMode = ''
  let maxRounds = 0
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === '--roles' || a === '-r') {
      const next = args[i + 1]
      if (next !== undefined) {
        i++
        rolesCSV = next
        gotRoles = true
      }
      continue
    }
    if (a === '--research') {
      research = true
      continue
    }
    if (a === '--mode') {
      const next = args[i + 1]
      if (next !== undefined) {
        i++
        researchMode = next.trim()
      }
      continue
    }
    if (a === '--max-rounds') {
      const next = args[i + 1]
      if (next === undefined) {
        await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ChatroomMaxRoundsRange, maxChatroomResearchRounds))
        return
      }
      i++
      const n = Number.parseInt(next.trim(), 10)
      // Reject instead of silently dropping an invalid value — the moderator
      // would otherwise believe the cap took effect.
      if (Number.isNaN(n) || n < minChatroomResearchRounds || n > maxChatroomResearchRounds) {
        await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ChatroomMaxRoundsRange, maxChatroomResearchRounds))
        return
      }
      maxRounds = n
      continue
    }
    if (a.startsWith('-')) continue
    if (!gotRoles && (a.includes(',') || roleExists(rolesDir, a))) {
      rolesCSV = a
      gotRoles = true
      continue
    }
    topic = `${topic} ${a}`.trim()
  }
  topic = topic.trim()
  const roles: string[] = []
  for (const r of rolesCSV.split(',')) {
    const trimmed = r.trim()
    if (trimmed !== '') roles.push(trimmed)
  }
  if (topic === '') {
    // #59 随便聊聊: no topic at all → the moderator suggests candidate
    // topics; the user picks one, then enters the #43 role picker. Naming
    // roles without a topic is a misuse → usage error.
    if (gotRoles || roles.length > 0) {
      await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ChatroomUsage))
      return
    }
    if (!(await gateResearchUvOrFail(e, p, msg, research))) return
    stashChatroomResearchFlags(e, msg.sessionKey, research, researchMode, maxRounds)
    try {
      beginChatroomTopicPick(e, p, msg)
    } catch (error) {
      await e.reply(p, msg.replyCtx, String(error instanceof Error ? error.message : error))
    }
    return
  }

  // Feature 2: a single explicitly-named role → direct 1:1 conversation in
  // this chat, no moderator. Research mode does not apply — reject it.
  if (roles.length === 1) {
    if (research) {
      await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ChatroomResearchSingleRole))
      return
    }
    await startChatroomDirectRole(e, p, msg, roles[0] ?? '', topic)
    return
  }

  // Stash research-mode flags on the hub session BEFORE any path that leads
  // to afterChatroomStarted so --research survives the async pick flows.
  if (!(await gateResearchUvOrFail(e, p, msg, research))) return
  stashChatroomResearchFlags(e, msg.sessionKey, research, researchMode, maxRounds)

  // Feature 1: no roles named → wake the moderator to recommend roles based
  // on the topic, then render a picker card for the user to confirm.
  if (roles.length === 0) {
    try {
      beginChatroomPick(e, p, msg, topic)
    } catch (error) {
      await e.reply(p, msg.replyCtx, String(error instanceof Error ? error.message : error))
    }
    return
  }

  // Explicit multi-role path: spawn + post-spawn steps.
  let started: ChatroomRole[]
  try {
    started = await startChatroom(e, msg.sessionKey, roles, topic)
  } catch (error) {
    await e.reply(p, msg.replyCtx, String(error instanceof Error ? error.message : error))
    return
  }
  void afterChatroomStarted(e, p, msg.sessionKey, msg.userID, msg.chatType, msg.replyCtx, started, topic)
}

/**
 * Persist the --research / --mode / --max-rounds flags onto the hub session
 * so they survive the async picker flows (Go stashChatroomResearchFlags).
 *
 * @param e - Engine whose session store holds the hub session.
 * @param hubKey - Session key of the hub (group) session to stamp.
 * @param research - Whether --research was given; false scrubs stale flags.
 * @param mode - Requested research mode; anything but 'auto'/'manual' resolves to the configured default.
 * @param maxRounds - Per-invocation round cap override; 0 keeps the configured cap.
 */
export function stashChatroomResearchFlags(
  e: Engine, hubKey: string, research: boolean, mode: string, maxRounds: number,
): void {
  const hub = e.sessions.getOrCreateActive(hubKey)
  if (!research) {
    // A previous research chatroom in this group left flags on the hub;
    // scrub them so the next research chatroom starts from round 0.
    clearChatroomResearchFlags(hub)
    e.sessions.save()
    return
  }
  chatroomState(hub).chatroomResearch = true
  if (mode !== 'auto' && mode !== 'manual') {
    mode = chatroomConfig(e).defaultResearchMode()
  }
  chatroomState(hub).chatroomResearchMode = mode
  if (maxRounds > 0) {
    // Per-invocation override of the configured cap (auto mode only).
    chatroomState(hub).chatroomResearchMaxRounds = maxRounds
  }
  e.sessions.save()
}

/**
 * Pre-provision the shared research venv and, on failure, reply the needs-uv
 * message. True when research may proceed; false when the caller must abort
 * (feature off, or venv ready).
 */
async function gateResearchUvOrFail(e: Engine, p: Platform, msg: Message, research: boolean): Promise<boolean> {
  if (!research) return true
  try {
    await ensureResearchPythonEnv(e, chatroomResearchWorkspace(e))
  } catch (error) {
    console.warn(`chatroom: research venv provisioning failed; blocking startup: ${String(error)}`)
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ChatroomResearchNeedsUv))
    return false
  }
  return true
}

/**
 * Render a card listing every role under the roles dir with its one-line
 * essence (Go cmdChatroomList). Does not spawn anything.
 */
async function cmdChatroomList(e: Engine, p: Platform, msg: Message): Promise<void> {
  const rolesDir = chatroomConfig(e).rolesDir()
  const names = [...listRoleNames(rolesDir)].sort()
  if (names.length === 0) {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ChatroomNoRolesConfigured) + rolesDir)
    return
  }
  const b: string[] = []
  for (const n of names) {
    const ess = roleEssence(rolesDir, n)
    if (ess !== '') b.push(`**${n}** — ${ess}\n`)
    else b.push(`**${n}**\n`)
  }
  const content = b.join('').replace(/\n+$/, '')
  const card = newCard().title(e.i18n.tf(Msg.ChatroomListTitle, names.length), 'purple').markdown(content).build()
  const cs = asCardSender(p)
  if (cs !== undefined) {
    try {
      await cs.sendCard(msg.replyCtx, card)
      return
    } catch {
      // fall through to plain text
    }
  }
  await e.reply(p, msg.replyCtx, content)
}

/**
 * `/chatroom stop` (or 中断): interrupt the chatroom this chat belongs to.
 * Valid from the hub, any role group, or any assistant group (the hub is
 * resolved through the chatroom bindings); the interrupt card lands in the
 * hub, so the invoking role/assistant group needs no reply — it is about to
 * be torn down anyway.
 */
async function cmdChatroomStop(e: Engine, p: Platform, msg: Message): Promise<void> {
  const hubKey = resolveChatroomHubKey(e, msg.sessionKey)
  if (hubKey === '') {
    await e.reply(p, msg.replyCtx, e.i18n.t(Msg.ChatroomStopNotInRoom))
    return
  }
  try {
    interruptChatroom(e, hubKey)
  } catch (error) {
    await e.reply(p, msg.replyCtx, `chatroom: ${String(error instanceof Error ? error.message : error)}`)
  }
}

/**
 * Convert the user's current (hub) chat into a 1:1 direct conversation with
 * a single role — no moderator, no relay, no spawned group (Feature 2). The
 * hub session's workdir is overridden to the role's persona dir, the agent
 * session is reset for a clean persona load, and chatroomDirectRole is set
 * so the direct-role contract injects while the hub key stays '' (relay
 * dormant). The topic is then fed as a normal user turn (Go
 * startChatroomDirectRole).
 *
 * @param e - Engine owning sessions and project state.
 * @param p - Platform used for the notice card and the wake message.
 * @param msg - Triggering message; its hub session becomes the role session.
 * @param role - Role directory name under the roles dir.
 * @param topic - Conversation topic, fed to the role as the first user turn.
 */
export async function startChatroomDirectRole(
  e: Engine, p: Platform, msg: Message, role: string, topic: string,
): Promise<void> {
  const rolesDir = chatroomConfig(e).rolesDir()
  if (!roleExists(rolesDir, role)) {
    await e.reply(p, msg.replyCtx, e.i18n.tf(Msg.ChatroomUnknownRole, role, role))
    return
  }
  const dir = roleDir(rolesDir, role)
  // Rename the hub group to the topic, mirroring the multi-role path. No
  // child groups in the direct-role path (the role IS the hub).
  e.renameHubToTopic(p, msg.sessionKey, msg.chatType, topic, [], chatroomHubGroupName)
  // Override the chat workdir to the role persona dir (persists across restarts).
  e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(msg.sessionKey), dir)
  e.projectState?.save()
  const s = e.sessions.getOrCreateActive(msg.sessionKey)
  // Reset the agent session so the role persona loads cleanly from the new
  // workdir, rather than stacking on the prior assistant context.
  s.setAgentSessionID('', '')
  chatroomState(s).chatroomRoleName = role
  chatroomState(s).chatroomHubKey = '' // critical: the relay stays dormant
  chatroomState(s).chatroomDirectRole = true
  e.sessions.save()

  // Notice card.
  const cs = asCardSender(p)
  if (cs !== undefined) {
    void cs.sendCard(msg.replyCtx, newCard()
      .title(e.i18n.t(Msg.ChatroomPickTitle), 'green')
      .markdown(`${e.i18n.tf(Msg.ChatroomDirectStarted, role)}\n\n${e.i18n.t(Msg.ChatroomTopicLabel)}: ${topic}`)
      .build()).catch(() => {
      // Best-effort direct-mode notice; the topic turn below is the real start signal.
    })
  }

  // Feed the topic as a normal user turn (no moderator priming). The session
  // is a direct-role persona (bypass), so it can never be in plan mode.
  const wake: Message = {
    ...emptyMessage(),
    sessionKey: msg.sessionKey,
    platform: p.name(),
    userID: msg.userID,
    userName: msg.userName,
    content: topic,
    replyCtx: msg.replyCtx,
  }
  e.deliverMachineMessage(p, wake)
}

/**
 * Post-spawn steps shared by the explicit-multi-role path and the picker's
 * multi-role confirm: rename the hub group to the topic, bind the moderator
 * workdir, post a summary card, pre-spawn research assistants, and wake the
 * moderator with the orchestration contract (Go afterChatroomStarted).
 * Async where the platform/spawn surface awaits (Go ran these inline).
 *
 * @param e - Engine owning sessions, spawn, and project state.
 * @param p - Platform used for cards, renames, and the moderator wake.
 * @param sessionKey - Hub (moderator) session key.
 * @param userID - User the moderator wake turn is attributed to.
 * @param chatType - Chat type of the hub, forwarded to the group rename.
 * @param rctx - Reply context the summary card posts into.
 * @param started - Roles spawned by startChatroom.
 * @param topic - Discussion topic.
 */
export async function afterChatroomStarted(
  e: Engine,
  p: Platform,
  sessionKey: string,
  userID: string,
  chatType: string,
  rctx: unknown,
  started: ChatroomRole[],
  topic: string,
): Promise<void> {
  // Collect chatroom child group keys for the family avatar: role groups
  // here, research-assistant groups in the research branch below.
  const chatroomChildKeys: string[] = started.map(r => r.sessionKey)
  // Bind the chatroom to its home dir so the moderator agent runs there.
  const home = chatroomConfig(e).moderatorDir()
  if (home.ok) {
    e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(sessionKey), home.dir)
    e.projectState?.save()
  }
  // Clear any lingering direct-role flag so the moderator gets the moderator
  // persona (not the direct-role contract) — covers /chatroom <single-role>
  // followed later by /chatroom a,b in the same hub.
  const s = e.sessions.getOrCreateActive(sessionKey)
  if (chatroomState(s).chatroomDirectRole) chatroomState(s).chatroomDirectRole = false
  // Mark the hub as the chatroom moderator so its agent session swaps to the
  // bare persona (D3 setup hook replaces Go's --bare fork).
  chatroomState(s).chatroomModerator = true
  e.sessions.save()
  // The #59/#43 flows wake the hub BEFORE the moderator flag exists, so a
  // hub agent may already be running with the plain persona. Recycle the
  // stale process here (keeping the Session object, so the wake turn below
  // resumes the topic-pick history under the same session ID). No-op when
  // the hub has no live agent session.
  await e.cleanupInteractiveState(sessionKey)
  const ledgerDir = chatroomLedgerDirFor(e, sessionKey)
  const ledgerOK = ledgerDir !== undefined

  // Summary card in the hub.
  const sb: string[] = []
  sb.push(`${e.i18n.t(Msg.ChatroomTopicLabel)}: ${topic}\n`)
  for (const r of started) {
    sb.push(`• ${r.name}\n`)
  }
  if (ledgerOK) {
    sb.push(e.i18n.tf(Msg.ChatroomLedgerDirNote, ledgerDir))
  }
  // The ready card is the one place every chatroom member reads: state here
  // that plain messages in the hub reach the moderator, so mid-run
  // participation is discoverable without a command.
  sb.push(e.i18n.t(Msg.ChatroomInterjectHint))
  sb.push(`\n${e.i18n.t(Msg.ChatroomModeratorOpening)}`)
  void e.sendAsCard(p, rctx, sb.join(''), { title: e.i18n.t(Msg.ChatroomReady), color: 'purple' })

  // Research mode: pre-spawn a full-CC assistant subgroup for each role so
  // the role can drive it to fetch data / run scripts without needing coding
  // tools itself. The assistant stays IDLE until the role sends it a task.
  const research = chatroomState(s).chatroomResearch
  if (research) {
    // All assistants share one workdir (the research workspace) so they
    // reuse a single Python env / data dir. resolveDir requires the dir to
    // exist, so create it up front; on failure fall back to each role's
    // persona dir.
    let assistantDir = ''
    let researchVenv = ''
    const ws = chatroomResearchWorkspace(e)
    if (ws !== '') {
      try {
        mkdirSync(ws, { recursive: true })
        assistantDir = ws
        // The cmdChatroom startup gate already provisioned the venv; this
        // idempotent call just retrieves its path for each assistant session.
        researchVenv = await ensureResearchPythonEnv(e, ws) ?? ''
      } catch (error) {
        console.warn(`chatroom: research workspace unavailable; assistants run without shared venv (ws=${ws}): ${String(error)}`)
      }
    }
    for (const r of started) {
      // Idle spawn: create the assistant group + session record but do NOT
      // fire a first turn — the assistant waits for the role's real task.
      // The role gets the childKey through its session's researchAssistantKey
      // (surfaced in its bare persona and env).
      let dir = assistantDir
      if (dir === '') dir = r.dir
      let childKey = ''
      try {
        const spawned = await e.spawnSubtask(r.sessionKey, dir, WorktreeMode.ForceOff, false, '', [], false)
        childKey = spawned.childKey
      } catch (error) {
        console.warn(`chatroom: research assistant spawn failed (role=${r.name}): ${String(error)}`)
        continue
      }
      chatroomState(e.sessions.getOrCreateActive(r.sessionKey)).researchAssistantKey = childKey
      chatroomChildKeys.push(childKey)
      // Flag the child session as a research assistant so its bare persona
      // carries the research preamble + venv instructions.
      const child = e.sessions.getOrCreateActive(childKey)
      chatroomState(child).researchAssistant = true
      if (researchVenv !== '') chatroomState(child).researchVenv = researchVenv
      // Rename the assistant group so the user can tell assistants apart in
      // the group list; the idle spawn's neutral placeholder would stick.
      const assistantName = chatroomAssistantGroupName(r.name)
      child.setName(assistantName)
      const renamer = asGroupRenamer(p)
      if (renamer !== undefined) {
        void renamer.renameGroupAny(childKey, assistantName).catch((error: unknown) => {
          console.warn(`chatroom: failed to rename research assistant group (role=${r.name}): ${String(error)}`)
        })
      }
    }
    // Data steward: one more idle assistant, parented on the HUB. The role
    // assistants each fetch what their own role needs, duplicating the
    // shared public datasets (observed: one NBS page pulled by all five);
    // the steward fetches those once into the shared workspace, so it only
    // exists when that workspace resolved (without it the role assistants
    // already scatter into their persona dirs — no shared area to prefetch
    // into). Hub parentage keeps the roles' own "assistant" alias targets
    // intact: the alias resolves per caller, so the moderator's "assistant"
    // reaches the steward.
    if (assistantDir !== '') {
      let childKey = ''
      try {
        const spawned = await e.spawnSubtask(sessionKey, assistantDir, WorktreeMode.ForceOff, false, '', [], false)
        childKey = spawned.childKey
      } catch (error) {
        console.warn(`chatroom: research steward spawn failed: ${String(error)}`)
      }
      if (childKey !== '') {
        chatroomState(s).researchAssistantKey = childKey
        chatroomChildKeys.push(childKey)
        // Flag the child session as a research assistant so its bare persona
        // carries the research preamble + venv instructions.
        const child = e.sessions.getOrCreateActive(childKey)
        chatroomState(child).researchAssistant = true
        if (researchVenv !== '') chatroomState(child).researchVenv = researchVenv
        child.setName(chatroomStewardGroupName())
        const renamer = asGroupRenamer(p)
        if (renamer !== undefined) {
          void renamer.renameGroupAny(childKey, chatroomStewardGroupName()).catch((error: unknown) => {
            console.warn(`chatroom: failed to rename research steward group: ${String(error)}`)
          })
        }
      }
    }
    e.sessions.save()
  }

  // Hub rename + family avatar: fire after role/assistant children exist so
  // the shared icon avatar can cover the whole family at once.
  e.renameHubToTopic(p, sessionKey, chatType, topic, chatroomChildKeys, chatroomHubGroupName)

  // Wake the hub agent as the moderator with the orchestration contract.
  let priming = buildChatroomModeratorPriming(topic, started, ledgerDir ?? '')
  if (research) {
    let mode = chatroomState(s).chatroomResearchMode
    if (mode === '') mode = 'auto'
    let maxRounds = chatroomConfig(e).maxResearchRounds()
    const override = chatroomState(s).chatroomResearchMaxRounds
    if (override > 0) maxRounds = override
    priming = buildChatroomResearchModeratorPriming(topic, started, ledgerDir ?? '', mode, maxRounds, chatroomResearchWorkspace(e))
  }
  const wake: Message = {
    ...emptyMessage(),
    sessionKey,
    platform: p.name(),
    userID,
    userName: '[聊天室]',
    content: priming,
    replyCtx: rctx,
  }
  e.deliverMachineMessage(p, wake)
}
