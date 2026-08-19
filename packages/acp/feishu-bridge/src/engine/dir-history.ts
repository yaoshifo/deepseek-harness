/**
 * Directory switch history ported from cc-connect core/dir_history.go:
 * per-project MRU list plus live-scanned parent dirs, JSON-persisted,
 * including the fuzzy bare-name fallback (Go ResolveScanPathFuzzy, #3).
 *
 * @module dsh-feishu-bridge/dir-history
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { atomicWriteFileSync } from '../atomicwrite.js'
import { absLen, fuzzyThreshold, levenshtein } from '../lucide/fuzzy.js'

/** Default MRU history length (Go DefaultDirHistorySize). */
export const DefaultDirHistorySize = 10

const dirHistoryFileName = 'dir_history.json'

/** Manages directory switch history per project (Go DirHistory). */
export class DirHistory {
  private readonly storePath: string
  private entries = new Map<string, string[]>()
  private scanPaths = new Map<string, string[]>()
  private maxSize = DefaultDirHistorySize

  constructor(dataDir: string) {
    this.storePath = join(dataDir, dirHistoryFileName)
    this.load()
  }

  /** Add a directory to the project's MRU front. */
  add(project: string, dir: string): void {
    if (dir === '') return
    const entries = [...(this.entries.get(project) ?? [])]
    const idx = entries.indexOf(dir)
    if (idx >= 0) entries.splice(idx, 1)
    entries.unshift(dir)
    if (entries.length > this.maxSize) entries.length = this.maxSize
    this.entries.set(project, entries)
    this.saveLocked()
  }

  /** Merged live-scanned + MRU list; non-existent entries dropped. */
  list(project: string): string[] {
    return this.mergedList(project)
  }

  /** Directory at the 1-based index ('' when out of range). */
  get(project: string, index: number): string {
    const entries = this.mergedList(project)
    if (index < 1 || index > entries.length) return ''
    return entries[index - 1] ?? ''
  }

  /** The previous directory (index 2; index 1 is current). */
  previous(project: string): string {
    return this.get(project, 2)
  }

  /** Whether a directory is in the MRU history. */
  contains(project: string, dir: string): boolean {
    return (this.entries.get(project) ?? []).includes(dir)
  }

  /** Set the parent directories to live-scan for a project. */
  setScanPaths(project: string, paths: string[]): void {
    this.scanPaths.set(project, [...paths])
  }

  /**
   * First scan root joined with rel that exists as a directory (bare
   * relative names like "mem0" resolve to <scanRoot>/mem0).
   */
  resolveScanPath(project: string, rel: string): string | undefined {
    for (const sp of this.scanPaths.get(project) ?? []) {
      const candidate = join(sp, rel)
      try {
        if (statSync(candidate).isDirectory()) return candidate
      } catch {
        // not present under this root — try the next
      }
    }
    return undefined
  }

  /**
   * Fuzzy fallback after an exact scan miss (Go ResolveScanPathFuzzy): pick
   * the closest candidate from the merged list by basename similarity.
   *
   * Scoring (lower wins): case-insensitive exact = 0 > prefix = 10 >
   * substring = 20 > edit distance <= threshold = 30+distance. Inputs shorter
   * than 2 characters are too ambiguous and never match; ties keep the
   * earlier merged-list entry (MRU first).
   */
  resolveScanPathFuzzy(project: string, rel: string): string | undefined {
    if (rel.length < 2) return undefined
    const lrel = rel.toLowerCase()
    let bestPath: string | undefined
    let bestScore = -1
    for (const cand of this.mergedList(project)) {
      const name = basename(cand)
      const lname = name.toLowerCase()
      let score = -1
      if (lrel === lname) score = 0
      else if (lname.startsWith(lrel)) score = 10
      else if (lname.includes(lrel)) score = 20
      else if (absLen(rel, name) <= fuzzyThreshold(rel)) {
        const d = levenshtein(lrel, lname)
        if (d <= fuzzyThreshold(rel)) score = 30 + d
      }
      if (score < 0) continue
      if (bestScore < 0 || score < bestScore) {
        bestScore = score
        bestPath = cand
      }
    }
    return bestPath
  }

  /** Raise the MRU cap to at least the given value (Go EnsureSize). */
  ensureSize(size: number): void {
    if (size < 1) return
    if (size > this.maxSize) this.maxSize = size
  }

  private mergedList(project: string): string[] {
    const scanned = new Set<string>()
    const scanOrder: string[] = []
    for (const sp of this.scanPaths.get(project) ?? []) {
      let dirents
      try {
        dirents = readdirSync(sp, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of dirents) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        const dir = join(sp, entry.name)
        if (!scanned.has(dir)) {
          scanned.add(dir)
          scanOrder.push(dir)
        }
      }
    }

    const resultSet = new Set<string>()
    const result: string[] = []
    for (const d of this.entries.get(project) ?? []) {
      if (scanned.has(d)) {
        if (!resultSet.has(d)) {
          result.push(d)
          resultSet.add(d)
        }
      } else {
        try {
          statSync(d)
          if (!resultSet.has(d)) {
            result.push(d)
            resultSet.add(d)
          }
        } catch {
          // dropped from history: directory no longer exists
        }
      }
    }
    for (const d of scanOrder) {
      if (!resultSet.has(d)) result.push(d)
    }
    return result
  }

  private load(): void {
    if (this.storePath === '') return
    let data: string
    try {
      data = readFileSync(this.storePath, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(data) as Record<string, string[]>
      for (const [k, v] of Object.entries(parsed)) this.entries.set(k, [...v])
    } catch (error) {
      console.error(`dir_history: failed to unmarshal ${this.storePath}: ${String(error)}`)
    }
  }

  private saveLocked(): void {
    if (this.storePath === '') return
    try {
      const data = `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`
      mkdirSync(dirname(this.storePath), { recursive: true })
      atomicWriteFileSync(this.storePath, new TextEncoder().encode(data), 0o644)
    } catch (error) {
      console.error(`dir_history: failed to write ${this.storePath}: ${String(error)}`)
    }
  }
}
