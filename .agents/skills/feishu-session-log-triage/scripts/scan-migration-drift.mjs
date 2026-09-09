#!/usr/bin/env node
/**
 * Migration-drift scan: run the CURRENT build's v0/v1→current migration decode
 * over every historical-generation session log under a sessions root and
 * fail loud when any committed session is unreadable.
 *
 * Why: released migration codecs carry hand-written schema snapshots of what
 * the old writer actually wrote. A snapshot written after the generation
 * retired can lag behind fields the writer added while it was still current
 * (2026-09-09: todo `activeForm`, header `oneshot` origin, permission
 * `origin`, approval `allowed-always` — 62% of v0 sessions refused). The only
 * independent source of truth is the committed data itself, which no CI
 * fixture can stand in for. Run this after every daemon /reload that may
 * change the session-format packages, and BEFORE writing any new-generation
 * codec's schema snapshot.
 *
 * Usage: node scan-migration-drift.mjs [sessions-root]
 *   sessions-root defaults to ~/.dsh/feishu-bridge-sessions (Mac host layout;
 *   the dev server uses the same path under its own home).
 * Exit code: 0 when every historical session migrates, 1 otherwise.
 * The catalog is resolved from this repository's build output
 * (packages/session/session-format-catalog/lib) relative to this script, so
 * the scan always exercises the deployed-on-this-checkout codec chain.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../../..')
const catalogPath = join(repoRoot, 'packages/session/session-format-catalog/lib/index.js')
if (!existsSync(catalogPath)) {
  console.error(`scan-migration-drift: catalog build not found at ${catalogPath}; run pnpm run build first`)
  process.exit(2)
}
const { sessionFormatCatalog } = await import(catalogPath)

const root = resolve(process.argv[2] ?? join(homedir(), '.dsh/feishu-bridge-sessions'))
if (!existsSync(root)) {
  console.error(`scan-migration-drift: sessions root not found: ${root}`)
  process.exit(2)
}

// Historical generations only: version 0 keeps the unversioned name, later
// generations carry their vN component. Current-generation logs read through
// the current codec and have no hand-written snapshot to drift.
const HISTORICAL_FILES = ['session.jsonl.zstd', 'session.v1.jsonl.zstd']

let scanned = 0
let ok = 0
const failures = new Map() // normalized reason -> { count, sample, origId }

for (const project of readdirSync(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const sessionDir = join(root, project.name, session.name)
    for (const file of HISTORICAL_FILES) {
      const log = join(sessionDir, file)
      if (!existsSync(log)) continue
      scanned += 1
      let lines
      try {
        lines = execFileSync('zstdcat', [log], { maxBuffer: 1 << 28 }).toString('utf8').split('\n')
      } catch (error) {
        note(`zstdcat failed: ${String(error instanceof Error ? error.message : error)}`, session.name)
        continue
      }
      try {
        const restore = sessionFormatCatalog.createRestore(JSON.parse(lines[0] ?? ''), {
          recovery: 'recoverable',
          validation: 'transformed',
        })
        for (let i = 1; i < lines.length; i++) {
          const row = lines[i].trim()
          if (row !== '') restore.decodeRow(JSON.parse(row))
        }
        restore.finish()
        ok += 1
      } catch (error) {
        note(String(error instanceof Error ? error.message : error), session.name)
      }
    }
  }
}

function note(rawReason, origId) {
  const reason = rawReason.replace(/\d+/g, 'N').slice(0, 160)
  const entry = failures.get(reason) ?? { count: 0, sample: rawReason.slice(0, 200), origId }
  entry.count += 1
  failures.set(reason, entry)
}

const failed = scanned - ok
console.log(`scanned ${scanned} historical-generation logs under ${root}`)
console.log(`readable: ${ok}, refused: ${failed}`)
for (const [reason, { count, sample, origId }] of [...failures.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(count).padStart(5)}  ${reason}`)
  console.log(`         sample (${origId}): ${sample}`)
}
if (failed > 0) {
  console.log('scan-migration-drift: REFUSED logs exist — the current build cannot migrate them.')
  console.log('Either the codec snapshot lags behind committed data (fix the snapshot) or the drift is')
  console.log('a recorded accepted loss (see memory: feishu-bridge-v0-session-schema-drift).')
  process.exit(1)
}
console.log('scan-migration-drift: all historical logs migrate cleanly')
