import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { isSecretScanExcluded, scanContentForSecrets } from './no-secrets.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function gitFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-no-secrets-'))
  fixtureRoots.push(root)
  const git = (args: string[]): void => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  git(['init', '--initial-branch=master'])
  git(['config', 'user.email', 'no-secrets@example.com'])
  git(['config', 'user.name', 'No Secrets Tests'])
  return root
}

function runVerifyNoSecrets(root: string, files: string[]) {
  return spawnSync(process.execPath, [tsxCli, join(repositoryRoot, 'scripts/verify-no-secrets.ts'), '--cached', ...files], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}

describe('scanContentForSecrets', () => {
  it('flags an AWS access key id', () => {
    const findings = scanContentForSecrets('const aws = "AKIAIOSFODNN7EXAMPLE"\n') // no-secrets: allow
    expect(findings).toHaveLength(1)
    expect(findings[0]?.pattern).toBe('aws-access-key-id')
    expect(findings[0]?.line).toBe(1)
  })

  it('flags a private key block header', () => {
    const findings = scanContentForSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n') // no-secrets: allow
    expect(findings.map(f => f.pattern)).toEqual(['private-key-block'])
    expect(findings[0]?.line).toBe(1)
  })

  it('flags the known prefixed token families', () => {
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['github classic PAT', 'token = ghp_16C7e42F292c6912E7710c838347Ae178B4a'], // no-secrets: allow
      ['github fine-grained PAT', 'token = github_pat_11AABBCC0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'], // no-secrets: allow
      ['OpenAI/DeepSeek-style API key', 'key = sk-e2efixture1234567890abcdefabcdef12'], // no-secrets: allow
      ['Slack bot token', 'slack = xoxb-123456789012-ABCDEFGHIJ'], // no-secrets: allow
    ]
    for (const [label, sample] of samples) {
      expect(scanContentForSecrets(sample), label).toHaveLength(1)
    }
  })

  it('skips lines carrying the explicit allow marker', () => {
    const content = 'const sample = "AKIAIOSFODNN7EXAMPLE" // no-secrets: allow\n'
    expect(scanContentForSecrets(content)).toEqual([])
  })

  it('reports the line of a later match', () => {
    const findings = scanContentForSecrets('a\nb\nconst aws = "AKIAIOSFODNN7EXAMPLE"') // no-secrets: allow
    expect(findings).toEqual([{ pattern: 'aws-access-key-id', line: 3 }])
  })

  it('does not flag short or placeholder keys', () => {
    const content = [
      'const fixtureKey = \'sk-e2efixture1234567890\'',
      'const placeholder = \'sk-test\'',
      'const aws = "AKIA example with spaces in between"',
    ].join('\n')
    expect(scanContentForSecrets(content)).toEqual([])
  })

})

describe('isSecretScanExcluded', () => {
  it('excludes vendored upstream sources and nothing else', () => {
    expect(isSecretScanExcluded('vendor/cordis/src/index.ts')).toBe(true)
    expect(isSecretScanExcluded('packages/acp/feishu-bridge/src/index.ts')).toBe(false)
    expect(isSecretScanExcluded('not-vendor/src/index.ts')).toBe(false)
  })
})

describe('verify-no-secrets CLI', () => {
  it('rejects a staged file containing a credential', () => {
    const root = gitFixture()
    writeFileSync(join(root, 'leaky.ts'), 'const key = "AKIAIOSFODNN7EXAMPLE"\n') // no-secrets: allow
    spawnSync('git', ['-C', root, 'add', 'leaky.ts'])
    const result = runVerifyNoSecrets(root, ['leaky.ts'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('leaky.ts:1')
    expect(result.stderr).toContain('aws-access-key-id')
  })

  it('accepts staged clean, binary, and deleted files', () => {
    const root = gitFixture()
    writeFileSync(join(root, 'clean.ts'), 'export const answer = 42\n')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))
    const gone = join(root, 'gone.ts')
    writeFileSync(gone, 'export const x = 1\n')
    for (const file of ['clean.ts', 'binary.bin', 'gone.ts']) {
      const added = spawnSync('git', ['-C', root, 'add', file], { encoding: 'utf8' })
      expect(added.status).toBe(0)
    }
    const deleted = spawnSync('git', ['-C', root, 'rm', '--cached', 'gone.ts'], { encoding: 'utf8' })
    expect(deleted.status).toBe(0)
    const result = runVerifyNoSecrets(root, ['clean.ts', 'binary.bin', 'gone.ts'])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
