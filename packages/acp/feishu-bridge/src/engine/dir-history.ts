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
import { atomicWriteFileSync } from '../atomicwrite.ts'
import { absLen, fuzzyThreshold, levenshtein } from '../lucide/fuzzy.ts'

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

  /**
   * Add a directory to the project's MRU front.
   * @param project - Project key the history belongs to.
   * @param dir - Directory to move to the front of the MRU list.
   */
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

  /**
   * Merged live-scanned + MRU list; non-existent entries dropped.
   * @param project - Project key to list directories for.
   * @returns MRU directories first, then live-scanned ones not already present.
   */
  list(project: string): string[] {
    return this.mergedList(project)
  }

  /**
   * Directory at the 1-based index ('' when out of range).
   * @param project - Project key whose merged list to index.
   * @param index - 1-based position in the merged list.
   * @returns The directory at index, or '' when out of range.
   */
  get(project: string, index: number): string {
    const entries = this.mergedList(project)
    if (index < 1 || index > entries.length) return ''
    return entries[index - 1] ?? ''
  }

  /**
   * The previous directory (index 2; index 1 is current).
   * @param project - Project key whose history to use.
   * @returns The directory before the current one, or '' when there is none.
   */
  previous(project: string): string {
    return this.get(project, 2)
  }

  /**
   * Whether a directory is in the MRU history.
   * @param project - Project key whose MRU list to check.
   * @param dir - Directory to look for.
   * @returns Whether dir is in the project's MRU history.
   */
  contains(project: string, dir: string): boolean {
    return (this.entries.get(project) ?? []).includes(dir)
  }

  /**
   * Set the parent directories to live-scan for a project.
   * @param project - Project key to configure.
   * @param paths - Parent directories whose subdirectories join the merged list.
   */
  setScanPaths(project: string, paths: string[]): void {
    this.scanPaths.set(project, [...paths])
  }

  /**
   * First scan root joined with rel that exists as a directory (bare
   * relative names like "mem0" resolve to <scanRoot>/mem0).
   *
   * @param project - Project key whose scan paths to use.
   * @param rel - Relative path, or bare directory name, to resolve.
   * @returns The first candidate that exists as a directory, or undefined when none does.
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
   *
   * @param project - Project key whose merged list to search.
   * @param rel - Missed relative name to match by basename similarity.
   * @returns The closest matching directory, or undefined when nothing scores.
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

  /**
   * Raise the MRU cap to at least the given value (Go EnsureSize).
   * @param size - Minimum capacity to guarantee; never shrinks the cap.
   */
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
      const parsed: unknown = JSON.parse(data)
      // Legal-but-wrong JSON (an array, a primitive) is not a history map.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn(`dir_history: ${this.storePath} is not a history object; starting empty`)
        return
      }
      for (const [k, v] of Object.entries(parsed)) {
        // A malformed row must not half-load: a string would spread into
        // single-character entries and a non-iterable throws mid-loop,
        // keeping only the rows already set.
        if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
          console.warn(`dir_history: skipping malformed MRU list for '${k}' in ${this.storePath}`)
          continue
        }
        this.entries.set(k, [...v])
      }
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
