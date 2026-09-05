/** Integration coverage for the hook-facing `--cached` check of the pairing gate. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { gitBlobHash } from './translation-pairing-git.ts'
import { translationPairPaths } from './translation-pairing-record.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const script = fileURLToPath(new URL('./verify-translation-pairing.ts', import.meta.url))
const tsxLoader = import.meta.resolve('tsx/esm')
const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))
const fixtures: string[] = []

interface Fixture {
  env: NodeJS.ProcessEnv
  root: string
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeFixtureSafely(fixture)
})

function git(fixture: Fixture, args: string[]): string {
  return execFileSync('git', ['-C', fixture.root, ...args], {
    encoding: 'utf8',
    env: fixture.env,
  }).trim()
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function readManifest(): string {
  return readFileSync(join(workspaceRoot, 'scripts', 'translation-pairing.manifest.json'), 'utf8')
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-verify-translation-pairing-'))
  fixtures.push(root)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'pairing@example.test',
    GIT_AUTHOR_NAME: 'Pairing Test',
    GIT_COMMITTER_EMAIL: 'pairing@example.test',
    GIT_COMMITTER_NAME: 'Pairing Test',
    GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DEFAULT_HASH: 'sha1',
    // The script pins its repository root to its own source location, so the
    // spawned Git subprocesses are redirected into this fixture instead.
    GIT_DIR: join(root, '.git'),
    GIT_WORK_TREE: root,
  }
  const fixture = { env, root }
  execFileSync('git', ['init', '--quiet', '--initial-branch=master', root], { env })
  symlinkSync(join(workspaceRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  write(root, 'scripts/translation-pairing.manifest.json', readManifest())
  git(fixture, ['add', 'scripts/translation-pairing.manifest.json'])
  git(fixture, ['commit', '-m', 'manifest'])
  return fixture
}

function commitPair(fixture: Fixture): void {
  const paths = translationPairPaths('docs/guide.md')
  const source = '# Guide\n\nEnglish | [中文](guide.zh.md)\n\nAlpha.\n'
  const zh = '# 指南\n\n[English](guide.md) | 中文\n\n甲。\n'
  write(fixture.root, paths.source, source)
  write(fixture.root, paths.zh, zh)
  const record = [
    '# Consistency record',
    `guide.md: ${gitBlobHash(Buffer.from(source))}`,
    `guide.zh.md: ${gitBlobHash(Buffer.from(zh))}`,
    '',
  ].join('\n')
  write(fixture.root, paths.meta, record)
  git(fixture, ['add', '.'])
  git(fixture, ['commit', '-m', 'pair'])
}

function runCached(fixture: Fixture, anchors: string[]) {
  return spawnSync(process.execPath, ['--import', tsxLoader, script, '--cached', ...anchors], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: fixture.env,
  })
}

describe('verify-translation-pairing --cached (hook mode)', () => {
  it('rejects a staged English side whose recorded counterpart hash is stale', () => {
    const fixture = createFixture()
    commitPair(fixture)
    write(fixture.root, 'docs/guide.md', '# Guide\n\nEnglish | [中文](guide.zh.md)\n\nAlpha changed.\n')
    git(fixture, ['add', 'docs/guide.md'])

    const result = runCached(fixture, ['docs/guide.md'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/guide.md: out of sync')
  })

  it('rejects a staged Chinese side whose recorded counterpart hash is stale', () => {
    const fixture = createFixture()
    commitPair(fixture)
    write(fixture.root, 'docs/guide.zh.md', '# 指南\n\n[English](guide.md) | 中文\n\n甲改。\n')
    git(fixture, ['add', 'docs/guide.zh.md'])

    const result = runCached(fixture, ['docs/guide.zh.md'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/guide.zh.md: out of sync')
  })

  it('skips a staged out-of-corpus Markdown file instead of rejecting the anchor', () => {
    const fixture = createFixture()
    write(fixture.root, 'htmls/note.md', '# Notes\n\nOutside the pairing corpus.\n')
    git(fixture, ['add', 'htmls/note.md'])

    const result = runCached(fixture, ['htmls/note.md'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 named staged pair(s) consistent')
  })

  it('skips a staged in-scope Markdown file that has no pairing record yet', () => {
    const fixture = createFixture()
    write(fixture.root, 'docs/unpaired.md', '# Unpaired\n\nEnglish only so far.\n')
    git(fixture, ['add', 'docs/unpaired.md'])

    const result = runCached(fixture, ['docs/unpaired.md'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 named staged pair(s) consistent')
  })

  it('accepts a complete three-file pair deletion', () => {
    const fixture = createFixture()
    commitPair(fixture)
    git(fixture, ['rm', '-q', 'docs/guide.md', 'docs/guide.zh.md', 'docs/guide.i18n.yaml'])

    const result = runCached(fixture, ['docs/guide.md'])

    expect(result.status).toBe(0)
  })
})
