/**
 * Hint-button click counting ported from cc-connect core/hint_usage.go:
 * per-category counts with write-through JSON persistence and stable
 * frequency-descending ordering for the hints panels. Unlike the Go store,
 * all three categories persist (Go dropped hints_common).
 *
 * @module dsh-feishu-bridge/hint-usage
 */

import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from '../atomicwrite.js'

const hintUsageFileName = 'hint_usage.json'

/** Click-count category keys matching the config field names. */
export type HintCategory = 'hints' | 'hints_with_param' | 'hints_common'

/** Tracks hint-button clicks per category (Go HintUsage). */
export class HintUsage {
  private readonly storePath: string
  private readonly counts: Record<HintCategory, Map<string, number>> = {
    hints: new Map(),
    hints_with_param: new Map(),
    hints_common: new Map(),
  }

  constructor(dataDir: string) {
    this.storePath = join(dataDir, hintUsageFileName)
    this.load()
  }

  /**
   * Record one click and persist the store.
   * @param category - The hint group the clicked button belongs to.
   * @param hint - The clicked hint's command text.
   */
  increment(category: HintCategory, hint: string): void {
    this.counts[category].set(hint, (this.counts[category].get(hint) ?? 0) + 1)
    this.save()
  }

  /**
   * Hints ordered by click count descending; equal counts keep the input order.
   * @param category - The hint group whose counts to use.
   * @param hints - Configured hints in their config order.
   * @returns A new array ordered most-clicked first.
   */
  sortedByFrequency(category: HintCategory, hints: string[]): string[] {
    const counts = this.counts[category]
    return [...hints].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
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
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn(`hint_usage: ${this.storePath} is not a usage object; starting empty`)
        return
      }
      const raw = parsed as Partial<Record<HintCategory, unknown>>
      for (const category of Object.keys(this.counts) as HintCategory[]) {
        const cat = raw[category]
        if (cat === undefined) continue
        if (typeof cat !== 'object' || cat === null) {
          console.warn(`hint_usage: skipping malformed '${category}' table in ${this.storePath}`)
          continue
        }
        // A non-number count would turn increments into string
        // concatenation and corrupt the store on the next write-through.
        const counts = new Map<string, number>()
        for (const [hint, count] of Object.entries(cat)) {
          if (typeof count !== 'number' || !Number.isFinite(count)) {
            console.warn(`hint_usage: skipping malformed count for '${hint}' in ${this.storePath}`)
            continue
          }
          counts.set(hint, count)
        }
        this.counts[category] = counts
      }
    } catch (error) {
      console.error(`hint_usage: failed to unmarshal ${this.storePath}: ${String(error)}`)
    }
  }

  private save(): void {
    if (this.storePath === '') return
    try {
      const data = `${JSON.stringify({
        hints: Object.fromEntries(this.counts.hints),
        hints_with_param: Object.fromEntries(this.counts.hints_with_param),
        hints_common: Object.fromEntries(this.counts.hints_common),
      }, null, 2)}\n`
      mkdirSync(dirname(this.storePath), { recursive: true })
      atomicWriteFileSync(this.storePath, new TextEncoder().encode(data), 0o644)
    } catch (error) {
      console.error(`hint_usage: failed to write ${this.storePath}: ${String(error)}`)
    }
  }
}
