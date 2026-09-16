/**
 * Gate: `tsc -b` never deletes the outputs of a removed source file, so a
 * deleted `src/<file>.ts` leaves its `lib/types/<file>.{js,d.ts,.js.map,.d.ts.map}`
 * behind as build residue. The tsdown bundles only pull files the fresh entry
 * chain imports, so the poison path is a lib consumer reading deleted symbols
 * from a stale output. Scan the repository-root package and every workspace
 * package's tsc output dir (`lib/types`, rootDir `src`) and flag outputs
 * whose source no longer exists. Also flag zombie package directories —
 * layout-matched dirs whose package.json is gone: the tsdown workspace
 * globs still match them, so they break (or silently "build" stale junk in)
 * the workspace bundle pass. tsdown's root-level `lib/*.js` bundles and
 * chunks regenerate wholesale per build and stay out of scope.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** tsc output suffixes that map back to a `src` TypeScript source. */
const OUTPUT_SUFFIXES = ['.js', '.js.map', '.d.ts', '.d.ts.map'] as const

/** Source suffixes an output can be emitted from (ESM repo: `.ts` and `.tsx`). */
const SOURCE_SUFFIXES = ['.ts', '.tsx'] as const

/** Normalize a path to forward slashes so repo-relative output is portable. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/**
 * Recursively collect regular files under `dir`; symlinks are not followed.
 *
 * @param dir - Directory to walk.
 * @param out - Accumulator for the walked file paths.
 * @returns the accumulated file paths.
 */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * Package roots under `root` that carry a `lib/types` dir: the repository
 * root itself plus the `packages/<group>/<pkg>`, `vendor/<pkg>`, and
 * `vendor/<group>/<pkg>` layouts. Sorted for deterministic output.
 *
 * @param root - Workspace root to scan.
 * @returns package roots with a tsc output dir.
 */
function discoverPackages(root: string): string[] {
  const found: string[] = []
  if (statSync(join(root, 'lib/types'), { throwIfNoEntry: false })?.isDirectory() === true) {
    found.push(root)
  }
  for (const pkgRoot of packageDirectories(root)) {
    if (statSync(join(pkgRoot, 'lib/types'), { throwIfNoEntry: false })?.isDirectory() === true) {
      found.push(pkgRoot)
    }
  }
  return found.sort()
}

/**
 * Directories in the `packages/<group>/<pkg>`, `vendor/<pkg>`, and
 * `vendor/<group>/<pkg>` layouts, sorted for deterministic output.
 *
 * @param root - Workspace root to scan.
 * @returns the layout-matched package directories.
 */
function packageDirectories(root: string): string[] {
  const found: string[] = []
  for (const top of ['packages', 'vendor']) {
    const topDir = join(root, top)
    if (!existsSync(topDir)) continue
    for (const group of readdirSync(topDir, { withFileTypes: true })) {
      if (!group.isDirectory() || group.name === 'node_modules') continue
      const groupDir = join(topDir, group.name)
      found.push(groupDir)
      for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
        if (!pkg.isDirectory() || pkg.name === 'node_modules') continue
        found.push(join(groupDir, pkg.name))
      }
    }
  }
  return found.sort()
}

/**
 * Repo-relative (posix) paths of tsc outputs under any package's `lib/types`
 * whose `src` counterpart no longer exists.
 *
 * @param root - Workspace root (a checkout of this repository).
 * @returns the orphaned output paths, sorted.
 */
export function collectBuildResidue(root: string): string[] {
  // Empty-corpus guard: a checkout of this repository always carries at
  // least one of the workspace trees; anything else is a wrong root that
  // would otherwise pass vacuously.
  if (!existsSync(join(root, 'packages')) && !existsSync(join(root, 'vendor'))) {
    throw new Error(`verify-build-residue: no packages/ or vendor/ tree under ${root}`)
  }
  const residue: string[] = []
  for (const pkgRoot of discoverPackages(root)) {
    const outDir = join(pkgRoot, 'lib/types')
    for (const file of collectFiles(outDir)) {
      const suffix = OUTPUT_SUFFIXES.find(s => file.endsWith(s))
      if (suffix === undefined) continue
      const base = toPosix(relative(outDir, file)).slice(0, -suffix.length)
      const hasSource = SOURCE_SUFFIXES.some(s => existsSync(join(pkgRoot, 'src', base + s)))
      if (!hasSource) residue.push(toPosix(relative(root, file)))
    }
  }
  return residue.sort()
}

/**
 * Delete the orphaned outputs and return what was removed.
 *
 * @param root - Workspace root (a checkout of this repository).
 * @returns the pruned output paths, sorted.
 */
export function pruneBuildResidue(root: string): string[] {
  const residue = collectBuildResidue(root)
  for (const relPath of residue) rmSync(join(root, relPath))
  return residue
}

/** Directory entries a zombie package may carry and still be safe residue. */
const KNOWN_ZOMBIE_ENTRIES = new Set(['node_modules', 'lib', '.typecheck'])

/**
 * Repo-relative (posix, trailing slash) paths of zombie package
 * directories — layout-matched package dirs whose package.json is gone:
 * two-level dirs (`packages/<group>/<pkg>`, `vendor/<group>/<pkg>`) always,
 * and a one-level `vendor/<pkg>` only when it is not a group (no child
 * carries a package.json). The tsdown workspace globs still match these
 * directories, and their package name resolves through find-up to the repo
 * root, so once their orphaned outputs are pruned the workspace build fails
 * with a misleading root-package entry error.
 *
 * @param root - Workspace root (a checkout of this repository).
 * @returns the zombie package directories, sorted.
 */
export function collectZombiePackages(root: string): string[] {
  const zombies: string[] = []
  const record = (pkgRoot: string): void => {
    if (!existsSync(join(pkgRoot, 'package.json'))) {
      zombies.push(`${toPosix(relative(root, pkgRoot))}/`)
    }
  }
  const carriesPackage = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true })
      .some(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
  for (const top of ['packages', 'vendor']) {
    const topDir = join(root, top)
    if (!existsSync(topDir)) continue
    for (const group of readdirSync(topDir, { withFileTypes: true })) {
      if (!group.isDirectory() || group.name === 'node_modules') continue
      const groupDir = join(topDir, group.name)
      // A vendor one-level dir is a package candidate only when nothing
      // inside it is a package; packages/ one-level dirs are always groups.
      if (top === 'vendor' && !carriesPackage(groupDir)) record(groupDir)
      for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
        if (!pkg.isDirectory() || pkg.name === 'node_modules') continue
        record(join(groupDir, pkg.name))
      }
    }
  }
  return zombies.sort()
}

/**
 * Delete the zombie package directories and return what was removed. A
 * zombie is removable only when every entry is known generated residue
 * (node_modules, lib, .typecheck, *.tsbuildinfo); unknown entries refuse
 * the whole prune — the same safety rule `scripts/clean.ts` applies.
 *
 * @param root - Workspace root (a checkout of this repository).
 * @returns the pruned zombie directories (repo-relative, trailing slash), sorted.
 * @throws when a zombie carries entries outside the known-residue set.
 */
export function pruneZombiePackages(root: string): string[] {
  const zombies = collectZombiePackages(root)
  for (const relDir of zombies) {
    const unknown = readdirSync(join(root, relDir))
      .filter(entry => !KNOWN_ZOMBIE_ENTRIES.has(entry) && !entry.endsWith('.tsbuildinfo'))
    if (unknown.length > 0) {
      throw new Error(`verify-build-residue: refusing to remove ${relDir} (no package.json); unknown entries remain: ${unknown.sort().join(', ')}`)
    }
  }
  for (const relDir of zombies) rmSync(join(root, relDir), { recursive: true })
  return zombies
}

// CLI: report (and with --prune, delete) build residue. Guarded so the spec
// can import the collectors without side effects.
if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const root = resolve(import.meta.dirname, '..')
  const prune = process.argv.includes('--prune')
  const residue = prune ? pruneBuildResidue(root) : collectBuildResidue(root)
  const zombies = prune ? pruneZombiePackages(root) : collectZombiePackages(root)
  if (prune) {
    for (const relPath of residue) console.log(`verify-build-residue: pruned ${relPath}`)
    for (const relDir of zombies) console.log(`verify-build-residue: pruned zombie package dir ${relDir}`)
  }
  if (residue.length > 0 || zombies.length > 0) {
    if (!prune) {
      for (const relPath of residue) console.error(`verify-build-residue: ${relPath} has no src counterpart`)
      for (const relDir of zombies) console.error(`verify-build-residue: ${relDir} is a zombie package dir (no package.json)`)
      console.error(`verify-build-residue: ${residue.length} orphaned tsc output(s), ${zombies.length} zombie package dir(s); rerun with --prune to delete`)
      process.exit(1)
    }
    console.log(`verify-build-residue: pruned ${residue.length} orphaned tsc output(s), ${zombies.length} zombie package dir(s)`)
  } else {
    console.log('verify-build-residue: no orphaned tsc outputs, no zombie package dirs')
  }
}
