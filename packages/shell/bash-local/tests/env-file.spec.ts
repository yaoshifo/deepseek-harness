import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor, parseEnvFile } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-env-file-spec-'))

async function setup(config: ConstructorParameters<typeof LocalBashExecutor>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(LocalBashExecutor, { graceMs: 200, ...config })
  const bash = ctx.shell as LocalBashExecutor
  return { ctx, bash }
}

/** Boot with the system-prompt service so prompt-section registration is observable. */
async function setupWithPrompt(config: ConstructorParameters<typeof LocalBashExecutor>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(LocalBashExecutor, { graceMs: 200, ...config })
  const bash = ctx.shell as LocalBashExecutor
  return { ctx, bash }
}

function envFile(entries: Record<string, string>): string {
  const path = join(spillDir, `env-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  return path
}

describe('LocalBashExecutor envFile', () => {
  it('exposes file entries to the command under their original names', async () => {
    const { bash } = await setup({ envFile: envFile({ TEST_ENVFILE_SECRET: 'alpha' }) })
    const result = await bash.run(bash.resolve({ command: 'printf %s "$TEST_ENVFILE_SECRET"' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('alpha')
  })

  it('layers file entries under caller env and trusted dshEnv, over terminal overrides', async () => {
    const { bash } = await setup({
      envFile: envFile({ TERM: 'xterm-256color', TEST_ENVFILE_LAYER: 'file' }),
    })
    const result = await bash.run(bash.resolve({
      command: 'printf %s "$TERM/$TEST_ENVFILE_LAYER/$DSH_TEST_LAYER"',
      env: { TEST_ENVFILE_LAYER: 'caller' },
      dshEnv: { DSH_TEST_LAYER: 'trusted' },
    }))
    // The terminal override (TERM=dumb) loses to the file, the caller's own
    // entry beats the file, and the trusted dshEnv namespace stays reachable.
    expect(result.stdout.text).toBe('xterm-256color/caller/trusted')
  })

  it('re-reads the envFile at each command, so edits apply to the next one', async () => {
    const path = envFile({ TEST_ENVFILE_ROTATE: 'before' })
    const { bash } = await setup({ envFile: path })
    const first = await bash.run(bash.resolve({ command: 'printf %s "$TEST_ENVFILE_ROTATE"' }))
    expect(first.stdout.text).toBe('before')

    writeFileSync(path, 'TEST_ENVFILE_ROTATE=after\nTEST_ENVFILE_ADDED=later\n')
    const second = await bash.run(bash.resolve({
      command: 'printf %s "$TEST_ENVFILE_ROTATE/$TEST_ENVFILE_ADDED"',
    }))
    expect(second.stdout.text).toBe('after/later')
  })

  it('merges envFile entries into background commands at their spawn', async () => {
    const { bash } = await setup({ envFile: envFile({ TEST_ENVFILE_BG: 'bg-value' }) })
    const proc = bash.start(bash.resolve({
      command: 'printf %s "$TEST_ENVFILE_BG"; sleep 30',
    }))
    try {
      let all = ''
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        all += proc.readOutput().delta
        if (all.includes('bg-value')) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(all).toContain('bg-value')
    } finally {
      proc.kill()
      await proc.done
    }
  })
})

describe('parseEnvFile', () => {
  it('keeps the value intact after the first separator, skips comments and blanks', () => {
    expect(parseEnvFile('# header\n\nA=b=c\nB =x\r\n', 'f.env')).toEqual({ A: 'b=c', 'B ': 'x' })
  })

  it('rejects lines without a separator, empty keys, and empty values by line number', () => {
    expect(() => parseEnvFile('A=1\nB=2\nplainline\n', 'f.env')).toThrow('f.env line 3')
    expect(() => parseEnvFile('=value\n', 'f.env')).toThrow('f.env line 1')
    expect(() => parseEnvFile('A=\n', 'f.env')).toThrow('f.env line 1')
  })
})

describe('LocalBashExecutor envFile failure modes', () => {
  it('fails plugin load when the envFile is missing or malformed', async () => {
    await expect(setup({ envFile: join(spillDir, 'absent.env') })).rejects.toThrow(/absent\.env/)
    const malformed = join(spillDir, 'malformed.env')
    writeFileSync(malformed, 'GOOD=1\nbroken\n')
    await expect(setup({ envFile: malformed })).rejects.toThrow('malformed.env line 2')
  })

  it('fails the command loudly when the envFile disappears mid-run', async () => {
    const path = envFile({ TEST_ENVFILE_GONE: 'x' })
    const { bash } = await setup({ envFile: path })
    rmSync(path)
    await expect(bash.run(bash.resolve({ command: 'true' }))).rejects.toThrow(/envFile .* unreadable/)
  })
})

describe('LocalBashExecutor envFile model visibility', () => {
  it('registers a prompt section and injects the key-name marker when envFile is configured', async () => {
    const { ctx, bash } = await setupWithPrompt({ envFile: envFile({ TEST_ENVFILE_SECRET: 'alpha' }) })
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'bash:env-file')
    expect(section?.text).toContain('whitelist')
    expect(section?.text).toContain('daemon process environment')
    expect(section?.text).toContain('never print')

    const result = await bash.run(bash.resolve({ command: 'printf %s "$DSH_ENVFILE_KEYS"' }))
    expect(result.stdout.text).toBe('TEST_ENVFILE_SECRET')
  })

  it('registers no section and no marker without envFile (behavior unchanged)', async () => {
    const { ctx, bash } = await setupWithPrompt()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(s => s.name === 'bash:env-file')).toBeUndefined()
    const result = await bash.run(bash.resolve({ command: 'printf %s "${DSH_ENVFILE_KEYS:-absent}"' }))
    expect(result.stdout.text).toBe('absent')
  })

  it('appended keys appear in the marker on the next command (names re-read per spawn)', async () => {
    const path = envFile({ TEST_ENVFILE_FIRST: '1' })
    const { bash } = await setupWithPrompt({ envFile: path })
    const first = await bash.run(bash.resolve({ command: 'printf %s "$DSH_ENVFILE_KEYS"' }))
    expect(first.stdout.text).toBe('TEST_ENVFILE_FIRST')
    writeFileSync(path, 'TEST_ENVFILE_FIRST=1\nTEST_ENVFILE_SECOND=2\n')
    const second = await bash.run(bash.resolve({ command: 'printf %s "$DSH_ENVFILE_KEYS"' }))
    expect(second.stdout.text).toBe('TEST_ENVFILE_FIRST,TEST_ENVFILE_SECOND')
  })
})
