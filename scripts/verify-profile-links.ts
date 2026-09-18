/**
 * Verify a dsh profile manifest's `link:` dependencies against the tree they
 * point into. Upstream regroups packages between syncs (the present tool moved
 * from `packages/fs/` to `packages/deliverables/` on 2026-09-18), and a live
 * profile carries those targets as literal paths: a moved package leaves the
 * link dangling until the next `reload.sh` preflight fails on it. Run this
 * before merging so the breakage surfaces in the merge, not at restart.
 *
 * `@FORK_DIR@` is the template placeholder `install.sh` substitutes; the
 * repository template keeps it literal.
 *
 * @module verify-profile-links
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One `link:` dependency whose target cannot be loaded. */
export interface ProfileLinkProblem {
  /** Dependency name as written in the manifest. */
  readonly name: string
  /** Raw specifier, placeholder included. */
  readonly specifier: string
  /** Resolved absolute path the specifier points at. */
  readonly target: string
  /** Why the target is unusable. */
  readonly reason: 'missing-target' | 'missing-directory' | 'missing-manifest'
}

/** One manifest to verify and the directories its specifiers resolve against. */
export interface ProfileLinkBasis {
  /** Directory holding the manifest; relative targets resolve against it. */
  readonly profileDir: string
  /** Substituted for `@FORK_DIR@`; the repository root for the template. */
  readonly forkDir: string
}

/**
 * Resolve one `link:` specifier to the absolute directory it names.
 * @param specifier - the `link:` value, `@FORK_DIR@` allowed.
 * @param basis - resolution basis for the manifest.
 * @returns the absolute target path, whether or not it exists.
 */
export function resolveProfileLink(specifier: string, basis: ProfileLinkBasis): string {
  const path = specifier.slice('link:'.length).replaceAll('@FORK_DIR@', basis.forkDir)
  return isAbsolute(path) ? path : resolve(basis.profileDir, path)
}

/**
 * Find every `link:` dependency of one manifest that cannot be loaded.
 * @param manifest - parsed profile manifest (only `dependencies` is read).
 * @param basis - resolution basis for the manifest.
 * @returns one problem per unusable link, in declaration order; empty when all resolve.
 */
export function findBrokenProfileLinks(
  manifest: { readonly dependencies?: Readonly<Record<string, string>> },
  basis: ProfileLinkBasis,
): ProfileLinkProblem[] {
  const problems: ProfileLinkProblem[] = []
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (!specifier.startsWith('link:')) continue
    if (specifier.slice('link:'.length).trim() === '') {
      problems.push({ name, specifier, target: '', reason: 'missing-target' })
      continue
    }
    const target = resolveProfileLink(specifier, basis)
    if (!existsSync(target)) problems.push({ name, specifier, target, reason: 'missing-directory' })
    else if (!existsSync(join(target, 'package.json'))) problems.push({ name, specifier, target, reason: 'missing-manifest' })
  }
  return problems
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultProfiles = [join(repositoryRoot, 'packages/acp/feishu-bridge/profile/package.json')]

function main(argv: readonly string[]): number {
  const named = argv.filter(argument => argument !== '--profile')
  const profiles = named.length === 0 ? defaultProfiles : named
  let failed = false
  for (const profile of profiles) {
    const problems = findBrokenProfileLinks(
      JSON.parse(readFileSync(profile, 'utf8')) as { dependencies?: Record<string, string> },
      { profileDir: dirname(profile), forkDir: repositoryRoot },
    )
    if (problems.length === 0) {
      console.log(`verify-profile-links: ${profile} — all link: dependencies resolve`)
      continue
    }
    failed = true
    for (const problem of problems) {
      console.error(`verify-profile-links: ${profile}: ${problem.name} → ${problem.target} (${problem.reason})`)
    }
  }
  return failed ? 1 : 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
