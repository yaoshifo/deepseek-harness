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
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs'
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

/** Absolute path to a chatroom's ledger directory.
 *
 * @param moderatorDir - Chatroom home dir holding the ledgers/ subtree.
 * @param hubKey - Hub session key the ledger belongs to.
 * @returns the ledger directory path for that hub.
 */
export function chatroomLedgerDir(moderatorDir: string, hubKey: string): string {
  return join(moderatorDir, 'ledgers', hashID(hubKey))
}

const ledgerSynthesisFile = 'SYNTHESIS.md'
const ledgerSubproblemsFile = 'SUBPROBLEMS.md'
const ledgerRecordFile = 'RECORD.md'

function nowClock(): string {
  const now = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
}

/**
 * Write a fresh ledger (three files), creating the parent dir. Overwrites
 * any prior files — a new chatroom is a new discussion.
 *
 * @param dir - Ledger directory to create and populate.
 * @param topic - Discussion topic written into the file headers.
 * @param roles - Role names listed in the synthesis header.
 */
export function initChatroomLedger(dir: string, topic: string, roles: string[]): Promise<void> {
  return serialize(() => {
    mkdirSync(dir, { recursive: true })

    const syn = [
      `# 聊天室账本：${topic}`,
      '',
      `- 议题：${topic}`,
      `- 角色：${roles.join(', ')}`,
      `- 开始：${nowClock()}`,
      '',
      '## 当前图景与进展',
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
