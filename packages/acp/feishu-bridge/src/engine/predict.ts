/**
 * Predict-next + turn-summary + /btw ported from cc-connect
 * core/engine_predict.go (#33 Predict Next): after a completed turn, an
 * insight card combines a one-line turn summary with a predicted next user
 * message (clickable to send); /btw asks a side question through a fork of
 * the live session without polluting the main conversation.
 *
 * @module dsh-feishu-bridge/predict
 */

import { asCardSender, asForkQuerierWithProvider, type HistoryEntry, type Message, type Platform } from '../core/types.js'
import { dangerBtn, newCard, primaryBtn } from '../card.js'
import { Msg } from '../i18n/index.js'
import type { Engine, InteractiveState } from './engine.js'
import type { Session } from './session.js'
import { buildCompactContext } from './groupname.js'

/** Default predict-next prompt (Go defaultPredictPrompt) used unless the config overrides it. */
export const defaultPredictPrompt = `你在预测人类用户接下来会输入什么

# 规则
- 只输出用户会输入的精确文本 → 用户对这条 assistant 消息最自然的反应是什么？
  - 信息查询之后 → 更深一层分析、相关话题、写个总结、跟 X 对比
  - 代码改动之后 → 测试 / 部署 / 提交
  - 或预测一个用户还没做的**动作**——一条命令、一个请求、或一个新任务
- 80 字符以内。一行中文，没有别的内容
- 拿不准就猜——任何预测都有用

现在预测：
`

/** Default turn-summary prompt (Go defaultSummaryPrompt) used unless the config overrides it. */
export const defaultSummaryPrompt = `用一行简洁的话概括这轮 AI turn 做了什么。

# 规则
- 只输出总结这一行
- 80 字符以内。一行中文，没有别的内容
- 以动词开头，或直接描述结果
- 要具体：提到文件名、函数名或关键产出

现在总结：
`

const maxPredictLineLen = 200
const maxSummaryLineLen = 120
const maxSummaryUserMsgLen = 500
const maxSummaryAssistantLen = 4000
/** A reply at or under this many runes needs no summary card (Go isShortReply). */
const shortReplyRunes = 150

/** The insight-card deadline when no fork timeout is configured. */
const defaultInsightTimeoutMs = 120_000

/** /btw fork deadline (Go cmdBtw's 300s context). */
const btwTimeoutMs = 300_000

/**
 * The predict-next label: the model when set, else the provider name.
 *
 * @param e - Engine carrying the predict-next config.
 * @returns The label shown on the insight card.
 */
export function predictNextLabel(e: Engine): string {
  return e.predictNextModel !== '' ? e.predictNextModel : e.predictNextProvider
}

/**
 * The last user message and last assistant reply for the summary fork (Go
 * buildSummaryContext).
 *
 * @param entries - The session history.
 * @returns the "User asked: … / Assistant replied: …" context block.
 */
export function buildSummaryContext(entries: HistoryEntry[]): string {
  let lastUser = ''
  let lastAssistant = ''
  for (const entry of entries) {
    if (entry.role === 'user') lastUser = entry.content
    else lastAssistant = entry.content
  }
  let sb = ''
  if (lastUser !== '') {
    sb += `User asked: ${lastUser.length > maxSummaryUserMsgLen ? `${lastUser.slice(0, maxSummaryUserMsgLen)}...` : lastUser}\n`
  }
  if (lastAssistant !== '') {
    sb += `Assistant replied: ${lastAssistant.length > maxSummaryAssistantLen ? `${lastAssistant.slice(0, maxSummaryAssistantLen)}...` : lastAssistant}\n`
  }
  return sb
}

/**
 * Predict the user's next message (Go generatePrediction): resume mode
 * forks the live session's transcript on the configured provider;
 * lightweight mode sends the compact context + prompt through a one-shot
 * query. The first non-empty line within the length cap wins.
 *
 * @param e - Engine carrying the predict-next config.
 * @param compactContext - The compacted conversation context (lightweight mode).
 * @param sessionID - The live agent session id (resume mode).
 * @param workDir - The session's workdir (resume mode).
 * @returns the prediction text, or '' when nothing usable came back.
 */
export async function generatePrediction(e: Engine, compactContext: string, sessionID: string, workDir: string): Promise<string> {
  const fq = asForkQuerierWithProvider(e.agent)
  if (fq === undefined) throw new Error('agent does not implement ForkQuerierWithProvider')
  const prompt = e.predictNextPrompt !== '' ? e.predictNextPrompt : defaultPredictPrompt
  const resp = e.predictNextResume
    ? await fq.forkSessionWithProvider(sessionID, prompt, e.predictNextProvider, workDir)
    : await fq.lightweightQuery(`${compactContext}\n\n${prompt}`, e.predictNextProvider)
  return firstShortLine(resp, maxPredictLineLen)
}

/**
 * Summarize what the turn accomplished in one line (Go generateTurnSummary).
 *
 * @param e - Engine carrying the turn-summary config.
 * @param history - The session history through this turn.
 * @returns the summary text, or '' when nothing usable came back.
 */
export async function generateTurnSummary(e: Engine, history: HistoryEntry[]): Promise<string> {
  const fq = asForkQuerierWithProvider(e.agent)
  if (fq === undefined) throw new Error('agent does not implement ForkQuerierWithProvider')
  const prompt = e.turnSummaryPrompt !== '' ? e.turnSummaryPrompt : defaultSummaryPrompt
  const resp = await fq.lightweightQuery(`${buildSummaryContext(history)}\n${prompt}`, e.turnSummaryProvider)
  return firstShortLine(resp, maxSummaryLineLen)
}

/** First non-empty line at most `cap` runes long; '' when none qualifies. */
function firstShortLine(resp: string, cap: number): string {
  for (const raw of resp.split('\n')) {
    const line = raw.trim()
    if (line === '' || Array.from(line).length > cap) continue
    return line
  }
  return ''
}

/**
 * Wait for the summary/prediction forks and send the combined insight card
 * (Go sendInsightCard). Each resolved fork sends whatever is available so
 * the card lands incrementally; a stale turnSeq discards the result. The
 * in-place notification-card update of the Go version is not ported — the
 * TS completion notification returns no handle, so the insight arrives as
 * a fresh card.
 *
 * @param e - Engine carrying the config and interactive states.
 * @param summaryCh - The turn-summary fork promise; undefined when disabled.
 * @param predictCh - The predict-next fork promise; undefined when disabled.
 * @param p - Platform to send the card on.
 * @param replyCtx - Reply context of the completed turn.
 * @param sessionKey - The interactive state key for staleness checks.
 * @param triggerSeq - The turnSeq that armed this card.
 * @param label - Provider/model label for the card title.
 * @param timeoutMs - Optional deadline override (tests).
 */
export async function sendInsightCard(
  e: Engine,
  summaryCh: Promise<string> | undefined,
  predictCh: Promise<string> | undefined,
  p: Platform,
  replyCtx: unknown,
  sessionKey: string,
  triggerSeq: number,
  label: string,
  timeoutMs?: number,
): Promise<void> {
  let summary = ''
  let prediction = ''
  const deadline = timeoutMs ?? Math.max(e.turnSummaryTimeout, e.predictNextTimeout, defaultInsightTimeoutMs)
  const withDeadline = <T>(pr: Promise<T>): Promise<T | 'timeout'> =>
    Promise.race([pr, new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, deadline) })])

  const tasks: Array<Promise<void>> = []
  if (summaryCh !== undefined) {
    tasks.push(withDeadline(summaryCh).then((r) => {
      if (r !== 'timeout') summary = r
      return send()
    }))
  }
  if (predictCh !== undefined) {
    tasks.push(withDeadline(predictCh).then((r) => {
      if (r !== 'timeout') prediction = r
      return send()
    }))
  }

  /** Send whatever has landed so far (Go sendInsight sends per fork arrival). */
  async function send(): Promise<void> {
    if (summary === '' && prediction === '') return
    const state = e.interactiveStates.get(sessionKey)
    if (state === undefined || state.turnSeq !== triggerSeq) {
      console.info(`insight-card: discarding stale result (trigger_seq=${String(triggerSeq)})`)
      return
    }
    const cs = asCardSender(p)
    if (cs === undefined) return
    const cb = newCard().title(
      summary !== '' && prediction !== '' ? `✨ ${label}` : summary !== '' ? `📝 ${label}` : `💡 猜你想问（${label}）`,
      'purple',
    )
    if (summary !== '') cb.markdown(`📝 ${summary}`)
    if (summary !== '' && prediction !== '') cb.markdown('\n---\n')
    if (prediction !== '') {
      cb.markdown(`💡 ${prediction}`)
      cb.buttons(
        primaryBtn('发送', `cmd:${prediction}`),
        dangerBtn('屏蔽', 'act:/nopred'),
      )
    }
    try {
      await cs.sendCard(replyCtx, cb.build())
    } catch (error) {
      console.error(`insight-card: send card failed: ${String(error)}`)
    }
  }

  await Promise.all(tasks)
}

/**
 * Arm the post-turn insight forks (Go engine_events.go's insight-card
 * block): a turn summary unless the reply is already short, and a
 * prediction unless disabled for the session. Both skip when messages are
 * queued behind the turn. Fire-and-forget — Go runs them as goroutines.
 *
 * @param e - Engine carrying the configs.
 * @param state - The completed turn's interactive state.
 * @param session - The engine session holding the history.
 * @param p - The platform of the completed turn.
 * @param replyCtx - The turn's reply context.
 * @param sessionKey - The interactive state key of the turn.
 * @param sendCompletionNotification - Whether the turn surfaced a completion.
 * @param isSilent - Whether the reply was a silent NO_REPLY turn.
 */
export function triggerInsights(
  e: Engine,
  state: InteractiveState,
  session: Session,
  p: Platform | undefined,
  replyCtx: unknown,
  sessionKey: string,
  sendCompletionNotification: boolean,
  isSilent: boolean,
): void {
  if (!sendCompletionNotification || isSilent) return
  if (state.pendingMessages.length > 0) return

  let summaryCh: Promise<string> | undefined
  let predictCh: Promise<string> | undefined

  if (e.turnSummaryEnabled && !state.turnSummaryRunning) {
    const history = session.getHistory(0)
    let lastAssistant = ''
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === 'assistant') {
        lastAssistant = history[i]?.content ?? ''
        break
      }
    }
    if (Array.from(lastAssistant).length > shortReplyRunes) {
      state.turnSummaryRunning = true
      summaryCh = generateTurnSummary(e, history)
        .catch((error: unknown) => {
          console.error(`turn-summary: failed: ${String(error)}`)
          return ''
        })
        .finally(() => { state.turnSummaryRunning = false })
    }
  }

  if (e.predictNextEnabled && !state.predictNextDisabled && !state.predictNextRunning) {
    state.predictNextRunning = true
    const sid = state.agentSession?.currentSessionID() ?? ''
    const [wtPath] = session.getWorktreeInfo()
    const workDir = wtPath !== '' ? wtPath : e.perChatWorkDir(e.dirOverrideKey(sessionKey))
    predictCh = generatePrediction(e, buildCompactContext(session.getHistory(0)), sid, workDir)
      .catch((error: unknown) => {
        console.error(`predict-next: failed: ${String(error)}`)
        return ''
      })
      .finally(() => { state.predictNextRunning = false })
  }

  if (summaryCh === undefined && predictCh === undefined) return
  if (p === undefined) return
  const label = predictNextLabel(e)
  const triggerSeq = state.turnSeq
  void sendInsightCard(e, summaryCh, predictCh, p, replyCtx, sessionKey, triggerSeq, label)
}

// ── /btw ─────────────────────────────────────────────────────────────────

/**
 * Register the /btw command on an engine. Returns the disposer.
 *
 * @param e - Engine to register the command and resolver on.
 * @returns Disposer removing the handler and restoring the previous resolver.
 */
export function registerPredictCommands(e: Engine): () => void {
  const handlers = e.commandHandlers ?? new Map<string, (p: Platform, msg: Message, args: string[]) => boolean>()
  const ownedTable = e.commandHandlers === undefined
  handlers.set('btw', (p, msg, args) => cmdBtw(e, p, msg, args))
  e.commandHandlers = handlers
  const prevResolver = e.commandResolver
  e.commandResolver = (cmd: string): string => {
    if (cmd === 'btw' || (cmd.length >= 2 && 'btw'.startsWith(cmd))) return 'btw'
    return prevResolver?.(cmd) ?? ''
  }
  return () => {
    handlers.delete('btw')
    if (ownedTable && handlers.size === 0) e.commandHandlers = undefined
    e.commandResolver = prevResolver
  }
}

/**
 * /btw: a side question forked off the session's transcript — the answer
 * never enters the main conversation (Go cmdBtw). Resolves the fork target
 * from the live session, falling back to the persisted session id so /btw
 * works after a restart or idle-reap; the fork runs in the session's
 * workdir (worktree, /spawn --dir override, or the project default).
 *
 * @param e - Engine carrying the sessions and interactive states.
 * @param p - Platform to reply on.
 * @param msg - The /btw command message.
 * @param args - Command arguments after /btw; the side question text.
 * @returns True (the command is always consumed).
 */
export function cmdBtw(e: Engine, p: Platform, msg: Message, args: string[]): boolean {
  let text = args.join(' ')
  if (msg.extraContent !== '') {
    text = text === '' ? msg.extraContent : `${msg.extraContent}\n${text}`
  }
  if (text === '') {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwEmpty))
    return true
  }

  const state = e.interactiveStates.get(msg.sessionKey)
  let sessionID = ''
  if (state?.agentSession !== undefined && state.agentSession.alive()) {
    sessionID = state.agentSession.currentSessionID()
  }
  if (sessionID === '') {
    const sid = e.sessions.activeSessionID(msg.sessionKey)
    if (sid !== '') {
      const sess = e.sessions.findByID(sid)
      if (sess !== undefined) sessionID = sess.getAgentSessionID()
    }
  }
  if (sessionID === '') {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwNoSession))
    return true
  }

  const fq = asForkQuerierWithProvider(e.agent)
  if (fq === undefined) {
    void e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwNoSession))
    return true
  }
  // The session's workdir: worktree path, per-chat override, or ''.
  const active = e.sessions.getOrCreateActive(msg.sessionKey)
  const [wtPath] = active.getWorktreeInfo()
  const workDir = wtPath !== '' ? wtPath : e.perChatWorkDir(e.dirOverrideKey(msg.sessionKey))
  void (async () => {
    try {
      const resp = await Promise.race([
        fq.forkQuery(sessionID, text, workDir),
        new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, btwTimeoutMs) }),
      ])
      if (resp === 'timeout') {
        await e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwTimeout))
      } else if (resp !== '') {
        await e.reply(p, msg.replyCtx, resp)
      }
    } catch (error) {
      console.error(`btw: fork query failed: ${String(error)}`)
      await e.reply(p, msg.replyCtx, e.i18n.t(Msg.BtwSendFailed))
    }
  })()
  return true
}
