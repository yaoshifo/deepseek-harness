/**
 * Chatroom ledger persistence ported from cc-connect core/chatroom_ledger.go:
 * three per-chatroom files under <moderatorDir>/ledgers/<hubKeyHash>/ —
 * SYNTHESIS.md (rolling synthesis), SUBPROBLEMS.md (list + progress),
 * RECORD.md (full discussion log). The directory layout and file formats
 * match the Go implementation so an existing moderator dir reloads unchanged.
 *
 * All writes funnel through a module-level promise chain (the Go package
 * mutex) so an append and a read-modify-write update cannot interleave.
 *
 * @module dsh-feishu-bridge/chatroom-ledger
 */

import { createHash } from 'node:crypto'
import { mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '@deepseek-ai/dsh-feishu-bridge/exports'

/** Serializes every ledger write (Go ledgerMu). */
let writeChain: Promise<unknown> = Promise.resolve()

function serialize<T>(op: () => T): Promise<T> {
  const run = writeChain.then(op, op)
  writeChain = run.catch(() => undefined)
  return run
}

/** Path-safe id derived from s (sha256, first 16 hex chars).
 *
 * @param s - Value to digest (a hub session key).
 * @returns the 16-hex-char sha256 prefix of s.
 */
export function hashID(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

/**
 * Absolute path to a chatroom's ledger directory. Run 1 keeps the legacy
 * unsuffixed layout; every later chatroom on the same hub gets `-<run>` so a
 * new chatroom never overwrites a previous one's ledger.
 *
 * @param moderatorDir - Chatroom home dir holding the ledgers/ subtree.
 * @param hubKey - Hub session key the ledger belongs to.
 * @param run - 1-based chatroom number on this hub (default 1).
 * @returns the ledger directory path for that hub and run.
 */
export function chatroomLedgerDir(moderatorDir: string, hubKey: string, run = 1): string {
  const id = run <= 1 ? hashID(hubKey) : `${hashID(hubKey)}-${run}`
  return join(moderatorDir, 'ledgers', id)
}

const ledgerSynthesisFile = 'SYNTHESIS.md'
const ledgerSubproblemsFile = 'SUBPROBLEMS.md'
const ledgerRecordFile = 'RECORD.md'
const ledgerReportFile = 'REPORT.md'

/** The header block of one chatroom's SYNTHESIS.md, as the engine writes it.
 * The fields are the engine-written facts only (topic, roles, start, end,
 * prior-context pointer); the discussion body lives below the section marker.
 */
export interface ChatroomLedgerHeader {
  /** Discussion topic (`# 聊天室账本：<topic>` first line). */
  topic: string
  /** Role names (`- 角色：a, b`). */
  roles: string[]
  /** Start timestamp `YYYY-MM-DD HH:MM:SS` (`- 开始：`). */
  started: string
  /** End timestamp (`- 结束：<time>（…）`), '' while unfinished. */
  ended: string
  /** How the chatroom ended: 'ended' (已收尾), 'interrupted' (已中断), '' when unfinished. */
  endedStatus: 'ended' | 'interrupted' | ''
  /** Raw prior-context pointer (`- 前情：继承自 …`), '' when the chatroom started fresh. */
  prior: string
}

/**
 * Read and parse one chatroom's SYNTHESIS.md header block. Parsing stops at
 * the first section heading, so the discussion body never leaks into fields.
 *
 * @param dir - Ledger directory of the chatroom.
 * @returns the parsed header, or undefined when SYNTHESIS.md is unreadable (missing or hand-corrupted dir).
 */
export function readChatroomLedgerHeader(dir: string): ChatroomLedgerHeader | undefined {
  let content: string
  try {
    content = readFileSync(join(dir, ledgerSynthesisFile), 'utf8')
  } catch {
    return undefined
  }
  const header: ChatroomLedgerHeader = { topic: '', roles: [], started: '', ended: '', endedStatus: '', prior: '' }
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('## ')) break
    if (header.topic === '' && line.startsWith('# 聊天室账本：')) {
      header.topic = line.slice('# 聊天室账本：'.length).trim()
      continue
    }
    if (line.startsWith('- 角色：')) {
      header.roles = line.slice('- 角色：'.length).split(',').map(r => r.trim()).filter(r => r !== '')
      continue
    }
    if (line.startsWith('- 开始：')) {
      header.started = line.slice('- 开始：'.length).trim()
      continue
    }
    if (line.startsWith('- 结束：')) {
      const value = line.slice('- 结束：'.length).trim()
      if (value.endsWith('（已收尾）')) {
        header.ended = value.slice(0, -'（已收尾）'.length).trim()
        header.endedStatus = 'ended'
      } else if (value.endsWith('（已中断）')) {
        header.ended = value.slice(0, -'（已中断）'.length).trim()
        header.endedStatus = 'interrupted'
      } else {
        header.ended = value
      }
      continue
    }
    if (line.startsWith('- 前情：')) {
      header.prior = line.slice('- 前情：'.length).trim()
    }
  }
  return header
}

function nowClock(): string {
  const now = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
}

/** A prior chatroom a new one continues from, resolved before start. */
export interface ChatroomLedgerPrior {
  /** The prior chatroom's topic, shown in the pointer line and section title. */
  topic: string
  /** The prior chatroom's ledger directory, the pointer roles and the moderator Read. */
  dir: string
}

/**
 * Write a fresh ledger (three files), creating the parent dir. Overwrites
 * any prior files — a new chatroom is a new discussion. A prior writes a
 * pointer (never the prior content) into the header and a 前情 section
 * above the synthesis marker, so synthesis updates preserve it.
 *
 * @param dir - Ledger directory to create and populate.
 * @param topic - Discussion topic written into the file headers.
 * @param roles - Role names listed in the synthesis header.
 * @param prior - Prior chatroom to continue from, when the caller resolved one.
 */
export function initChatroomLedger(dir: string, topic: string, roles: string[], prior?: ChatroomLedgerPrior): Promise<void> {
  return serialize(() => {
    mkdirSync(dir, { recursive: true })

    const priorLine = prior === undefined ? '' : `- 前情：继承自 ${prior.topic}（${prior.dir}）\n`
    const priorSection = prior === undefined ? '' : [
      `## 前情（继承自 ${prior.topic}，未经本次讨论验证）`,
      '',
      `上一个聊天室的判断在 ${prior.dir}（SYNTHESIS.md 综述 / SUBPROBLEMS.md 进度 / RECORD.md 记录 / REPORT.md 结论）。主持人先 Read 甄别，把**采信**的部分用 feishu_bridge_chatroom 工具（action: note）写进下方综述段（标注继承来源）再开始讨论；存疑项作为开放问题带入；发现错误用「修正：」显式记入综述。`,
      '',
    ].join('\n')

    const syn = [
      `# 聊天室账本：${topic}`,
      '',
      `- 议题：${topic}`,
      `- 角色：${roles.join(', ')}`,
      `- 开始：${nowClock()}`,
      priorLine,
      `${priorSection}## 当前图景与进展`,
      '',
      '（主持尚未用 `feishu_bridge_chatroom note` 写综述）',
      '',
    ].join('\n')
    atomicWriteFileSync(join(dir, ledgerSynthesisFile), new TextEncoder().encode(syn), 0o644)

    const sub = '## 子问题清单\n\n（主持尚未拆解）\n'
    atomicWriteFileSync(join(dir, ledgerSubproblemsFile), new TextEncoder().encode(sub), 0o644)

    const rec = '## 讨论记录\n\n'
    atomicWriteFileSync(join(dir, ledgerRecordFile), new TextEncoder().encode(rec), 0o644)
  })
}

/** Append a role's reply to RECORD.md (append-only).
 *
 * @param dir - Ledger directory.
 * @param roleName - Role credited with the reply.
 * @param reply - Reply text appended to the discussion record.
 */
export function appendChatroomLedger(dir: string, roleName: string, reply: string): Promise<void> {
  return serialize(() => {
    const time = nowClock().slice(11)
    const entry = `- [${time}] 【${roleName}】：${reply.trim()}\n`
    appendFileSync(join(dir, ledgerRecordFile), entry, 'utf8')
  })
}

/**
 * Replace the content of SYNTHESIS.md after the `## 当前图景与进展`
 * header, preserving the file header (topic/roles/start).
 *
 * @param dir - Ledger directory.
 * @param synthesis - New synthesis body replacing the old section.
 */
export function updateChatroomLedgerSynthesis(dir: string, synthesis: string): Promise<void> {
  return serialize(() => {
    const path = join(dir, ledgerSynthesisFile)
    const content = readFileSync(path, 'utf8')
    const marker = '## 当前图景与进展\n'
    const mi = content.indexOf(marker)
    if (mi < 0) throw new Error('ledger: synthesis section marker not found')
    const newContent = content.slice(0, mi + marker.length) + synthesis.trim() + '\n'
    atomicWriteFileSync(path, new TextEncoder().encode(newContent), 0o644)
  })
}

/**
 * Overwrite SUBPROBLEMS.md with the given text (子问题清单 + 进度): a fresh
 * list replaces the old one.
 *
 * @param dir - Ledger directory.
 * @param text - New subproblem list body.
 */
export function updateChatroomSubproblems(dir: string, text: string): Promise<void> {
  return serialize(() => {
    const content = `## 子问题清单\n\n${text.trim()}\n`
    atomicWriteFileSync(join(dir, ledgerSubproblemsFile), new TextEncoder().encode(content), 0o644)
  })
}

/**
 * Write (or replace) the ended line in SYNTHESIS.md's header block, above
 * the section markers so synthesis updates preserve it. A second write
 * replaces the first — the latest terminal state wins.
 *
 * @param dir - Ledger directory.
 * @param status - How the chatroom ended: 'ended' (已收尾) or 'interrupted' (已中断).
 */
export function writeChatroomLedgerEnded(dir: string, status: 'ended' | 'interrupted'): Promise<void> {
  return serialize(() => {
    const path = join(dir, ledgerSynthesisFile)
    const content = readFileSync(path, 'utf8')
    const label = status === 'ended' ? '（已收尾）' : '（已中断）'
    const line = `- 结束：${nowClock()}${label}`
    const lines = content.split('\n')
    const endedIdx = lines.findIndex(l => l.startsWith('- 结束：'))
    if (endedIdx >= 0) {
      lines[endedIdx] = line
      atomicWriteFileSync(path, new TextEncoder().encode(lines.join('\n')), 0o644)
      return
    }
    const markerIdx = lines.findIndex(l => l.startsWith('## '))
    if (markerIdx < 0) {
      atomicWriteFileSync(path, new TextEncoder().encode(`${content.trimEnd()}\n${line}\n`), 0o644)
      return
    }
    lines.splice(markerIdx, 0, line)
    atomicWriteFileSync(path, new TextEncoder().encode(lines.join('\n')), 0o644)
  })
}

/**
 * Overwrite REPORT.md with the moderator's closing summary — the report of
 * record for this chatroom, readable by later chatrooms and the history
 * listing.
 *
 * @param dir - Ledger directory.
 * @param text - The closing summary text.
 */
export function updateChatroomReport(dir: string, text: string): Promise<void> {
  return serialize(() => {
    const content = `# 聊天室报告\n\n${text.trim()}\n`
    atomicWriteFileSync(join(dir, ledgerReportFile), new TextEncoder().encode(content), 0o644)
  })
}

/** One chatroom's history entry: the ledger dir, its header, and its report files. */
export interface ChatroomHistoryEntry {
  /** Absolute ledger directory path. */
  dir: string
  /** The parsed SYNTHESIS.md header (topic, roles, start/end, prior pointer). */
  header: ChatroomLedgerHeader
  /** Report files present in the dir, in a fixed order. */
  reports: string[]
}

/** Report file names probed per ledger dir, in listing order. */
const ledgerReportFiles = [ledgerReportFile, 'summary.html', 'summary-academic.html']

/**
 * List a moderator dir's chatroom ledgers, newest-started first. Dirs
 * without a readable SYNTHESIS.md are skipped; a missing root yields an
 * empty list — history degrades to "nothing recorded", never an error.
 *
 * @param ledgersRoot - The `<moderatorDir>/ledgers` directory to scan.
 * @param limit - Maximum entries returned (default 20).
 * @returns the chatroom history entries, newest first.
 */
export function listChatroomLedgers(ledgersRoot: string, limit = 20): ChatroomHistoryEntry[] {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = readdirSync(ledgersRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<ChatroomHistoryEntry & { mtimeMs: number }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = join(ledgersRoot, ent.name)
    const header = readChatroomLedgerHeader(dir)
    if (header === undefined) continue
    const reports = ledgerReportFiles.filter((f) => {
      try {
        return !statSync(join(dir, f)).isDirectory()
      } catch {
        return false
      }
    })
    let mtimeMs = 0
    try {
      mtimeMs = statSync(dir).mtimeMs
    } catch {
      // Unstattable dir: sorts as the oldest within its started-second tie.
    }
    out.push({ dir, header, reports, mtimeMs })
  }
  // Newest first; the dir mtime breaks same-second ties (init and later
  // ledger writes both bump it, so the most recently active chatroom wins).
  out.sort((a, b) => b.header.started.localeCompare(a.header.started) || b.mtimeMs - a.mtimeMs)
  return out.slice(0, limit)
}

/**
 * Resolve a `--continue` reference to a prior chatroom: the exact ledger
 * dir name wins, then a topic substring match scanning newest-first, and a
 * bare reference takes the newest chatroom.
 *
 * @param ledgersRoot - The `<moderatorDir>/ledgers` directory to scan.
 * @param ref - Dir name or topic substring; '' means the newest chatroom.
 * @returns the matched history entry, or undefined when nothing matches.
 */
export function resolveChatroomInherit(ledgersRoot: string, ref: string): ChatroomHistoryEntry | undefined {
  const list = listChatroomLedgers(ledgersRoot, Number.MAX_SAFE_INTEGER)
  const trimmed = ref.trim()
  if (trimmed === '') return list[0]
  const exact = list.find(l => l.dir.endsWith(`/${trimmed}`) || l.dir.endsWith(`\\${trimmed}`))
  if (exact !== undefined) return exact
  return list.find(l => l.header.topic.includes(trimmed))
}
