import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const run = promisify(execFile)

const scriptPath = fileURLToPath(new URL('../reload.sh', import.meta.url))
const label = 'com.dsh.feishu-bridge'

/** Staged environment: real reload.sh driven through stubbed launchctl/pgrep/ps. */
interface Staging {
  root: string
  callsPath: string
  plistPath: string
  env: NodeJS.ProcessEnv
  /** launchctl subcommands in call order, e.g. ["unload", "load", "list"]. */
  kinds: () => Promise<string[]>
}

const stubs: string[] = []

/**
 * Build a stub bin dir plus temp plist and log dir. `pgrepStuck` keeps the
 * old-daemon wait loop spinning (abort path); `psDaemon` makes the ppid walk
 * see a daemon-shaped ancestor (fallback guard path).
 */
async function stage(pgrepStuck: boolean, psDaemon: boolean, sessionStore = 'feishu-bridge'): Promise<Staging> {
  const root = await mkdtemp(join(tmpdir(), 'reload-spec-'))
  stubs.push(root)
  const bin = join(root, 'bin')
  const logDir = join(root, 'logs')
  await mkdir(bin)
  await mkdir(logDir)
  const callsPath = join(root, 'launchctl-calls')
  const plistPath = join(root, `${label}.plist`)
  const stdoutPath = join(logDir, 'feishu-bridge-stdout.log')
  const dshHome = join(root, '.dsh')
  const sessionJsonl = join(dshHome, `${sessionStore}-sessions`, 'workdir', 'cc-1', 'session.jsonl.zstd')
  await writeFile(plistPath, 'stub plist\n')

  await writeFile(join(bin, 'launchctl'), [
    '#!/bin/sh',
    `echo "$*" >> ${callsPath}`,
    'case "$1" in',
    '  load) printf "ws client ready\\n" >> "$FB_SPEC_STDOUT" ;;',
    '  list) printf "12345\\t0\\tcom.dsh.feishu-bridge\\n" ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 })
  await writeFile(join(bin, 'pgrep'), [
    '#!/bin/sh',
    `exit ${pgrepStuck ? 0 : 1}`,
  ].join('\n'), { mode: 0o755 })
  // ps -o ppid= -p PID / ps -o command= -p PID: pid 4242 is the (fake)
  // ancestor — the daemon under test or plain launchd.
  await writeFile(join(bin, 'ps'), [
    '#!/bin/sh',
    'case "$2" in',
    '  ppid=*) if [ "$4" = 4242 ]; then echo 1; else echo 4242; fi ;;',
    '  command=*) if [ "$4" = 4242 ]; then echo "$FB_SPEC_ANCESTOR"; else echo "/bin/bash -c stub"; fi ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    PLIST: plistPath,
    LOG_DIR: logDir,
    FB_SPEC_STDOUT: stdoutPath,
    FB_SPEC_ANCESTOR: psDaemon
      ? 'node /nowhere/apps/cli/lib/bin.js --profile feishu-bridge'
      : '/sbin/launchd',
    // Mirror a dsh bash-tool environment: DSH_* exports name the hosting
    // daemon's session store, and the sandbox rewrites XPC_SERVICE_NAME to a
    // literal 0 — never the label (verified on the 2026-08-20 outage).
    DSH_HOME: dshHome,
    DSH_SESSION_ID: 'cc-20260820-155538-71889f086cd6',
    DSH_SESSION_JSONL: sessionJsonl,
    XPC_SERVICE_NAME: '0',
  }
  const kinds = () =>
    readFile(callsPath, 'utf8')
      .then(s => s.split('\n').filter(Boolean).map(line => line.split(' ')[0] ?? ''))
      .catch(() => [])
  return { root, callsPath, plistPath, env, kinds }
}

async function runScript(env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  try {
    await run('sh', [scriptPath, '--skip-build'], { env })
    return { code: 0, stderr: '' }
  } catch (error) {
    const e = error as { code?: number; stderr?: string }
    return { code: e.code ?? 1, stderr: e.stderr ?? '' }
  }
}

describe.skipIf(process.platform !== 'darwin')('reload.sh', () => {
  afterAll(async () => {
    await Promise.all(stubs.map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('refuses inside the daemon via DSH_SESSION_JSONL even when ps is sandboxed away', async () => {
    const s = await stage(false, false)
    const result = await runScript(s.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('inside the com.dsh.feishu-bridge daemon')
    expect(await s.kinds()).toEqual([])
  }, 10000)

  it('does not refuse a cc-connect-hosted session (different session store)', async () => {
    const s = await stage(false, false, 'cc-connect')
    const result = await runScript(s.env)
    expect(result.code).toBe(0)
    expect((await s.kinds()).filter(k => k !== 'list')).toEqual(['unload', 'load'])
  }, 10000)

  it('still refuses via the ppid walk for a manually started daemon', async () => {
    const s = await stage(false, true, 'none')
    const result = await runScript(s.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('inside the com.dsh.feishu-bridge daemon')
    expect(await s.kinds()).toEqual([])
  }, 10000)

  it('re-loads the service when the old-daemon abort path fires', async () => {
    const s = await stage(true, false, 'none')
    const result = await runScript(s.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('old daemon still running')
    const kinds = await s.kinds()
    expect(kinds[0]).toBe('unload')
    expect(kinds.at(-1)).toBe('load')
  }, 30000)

  it('re-loads the service when killed mid-restart (the 2026-08-20 outage)', async () => {
    const s = await stage(true, false, 'none')
    const child = spawn('sh', [scriptPath, '--skip-build'], { env: s.env })
    const code = await new Promise<number>((resolve) => {
      child.on('exit', (c, signal) => { resolve(c ?? (signal === 'SIGTERM' ? 143 : 1)) })
      setTimeout(() => child.kill('SIGTERM'), 1500)
    })
    expect(code).not.toBe(0)
    const kinds = await s.kinds()
    expect(kinds[0]).toBe('unload')
    expect(kinds.at(-1)).toBe('load')
  }, 30000)

  it('completes the happy path from a plain terminal', async () => {
    const s = await stage(false, false, 'none')
    const result = await runScript(s.env)
    expect(result.code).toBe(0)
    expect((await s.kinds()).filter(k => k !== 'list')).toEqual(['unload', 'load'])
  }, 10000)

  it('FB_RELOAD_FROM_DAEMON=1 bypasses the ppid walk (the /reload detached spawn)', async () => {
    const s = await stage(false, true, 'none')
    const result = await runScript({ ...s.env, FB_RELOAD_FROM_DAEMON: '1' })
    expect(result.code).toBe(0)
    expect((await s.kinds()).filter(k => k !== 'list')).toEqual(['unload', 'load'])
  }, 10000)

  it('FB_RELOAD_FROM_DAEMON=1 still refuses a daemon-hosted session (DSH_SESSION_JSONL guard stays)', async () => {
    const s = await stage(false, false)
    const result = await runScript({ ...s.env, FB_RELOAD_FROM_DAEMON: '1' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('inside the com.dsh.feishu-bridge daemon')
    expect(await s.kinds()).toEqual([])
  }, 10000)
})

/** Linux staging: real reload.sh driven through stubbed uname/systemctl/journalctl. */
interface LinuxStaging {
  env: NodeJS.ProcessEnv
  /** Full systemctl argument lines in call order, e.g. ["--user cat feishu-bridge"]. */
  calls: () => Promise<string[]>
}

/**
 * Build a stub bin dir for the systemd path. `unitExists` makes the
 * `systemctl cat` precheck fail; `wsOk` controls whether `systemctl restart`
 * appends the WS-ready line to the (stubbed) journal; `psDaemon` makes the
 * ppid walk see a daemon-shaped ancestor; `sessionStore` names the hosting
 * daemon for the DSH_SESSION_JSONL guard.
 */
async function stageLinux(
  opts: { unitExists?: boolean; wsOk?: boolean; psDaemon?: boolean; sessionStore?: string } = {},
): Promise<LinuxStaging> {
  const { unitExists = true, wsOk = true, psDaemon = false, sessionStore = 'none' } = opts
  const root = await mkdtemp(join(tmpdir(), 'reload-linux-spec-'))
  stubs.push(root)
  const bin = join(root, 'bin')
  const logDir = join(root, 'logs')
  await mkdir(bin)
  await mkdir(logDir)
  const callsPath = join(root, 'systemctl-calls')
  const journalPath = join(root, 'journal.log')
  const dshHome = join(root, '.dsh')
  const sessionJsonl = join(dshHome, `${sessionStore}-sessions`, 'workdir', 'cc-1', 'session.jsonl.zstd')
  await writeFile(join(bin, 'uname'), [
    '#!/bin/sh',
    'echo Linux',
  ].join('\n'), { mode: 0o755 })
  // systemctl --user cat|restart UNIT — `cat` reports unit existence; `restart`
  // simulates the new daemon writing its WS-ready line to the journal.
  await writeFile(join(bin, 'systemctl'), [
    '#!/bin/sh',
    `echo "$*" >> ${callsPath}`,
    'case "$2" in',
    `  cat) exit ${unitExists ? 0 : 1} ;;`,
    '  restart) if [ "$FB_SPEC_WS_OK" = 1 ]; then printf "ws client ready\\n" >> "$FB_SPEC_JOURNAL"; fi; exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 })
  // journalctl --user -u UNIT [--since stamp | -n N]: replay the journal file.
  await writeFile(join(bin, 'journalctl'), [
    '#!/bin/sh',
    `cat ${journalPath} 2>/dev/null`,
    'exit 0',
  ].join('\n'), { mode: 0o755 })
  // No-op sleep so the 60-iteration WS probe exhausts in milliseconds.
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(bin, 'pgrep'), [
    '#!/bin/sh',
    'exit 1',
  ].join('\n'), { mode: 0o755 })
  await writeFile(join(bin, 'ps'), [
    '#!/bin/sh',
    'case "$2" in',
    '  ppid=*) if [ "$4" = 4242 ]; then echo 1; else echo 4242; fi ;;',
    '  command=*) if [ "$4" = 4242 ]; then echo "$FB_SPEC_ANCESTOR"; else echo "/bin/bash -c stub"; fi ;;',
    'esac',
    'exit 0',
  ].join('\n'), { mode: 0o755 })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    // Never written: the Linux branch must not consult the plist — its
    // basename only keeps the daemon label right in guard messages.
    PLIST: join(root, 'com.dsh.feishu-bridge.plist'),
    LOG_DIR: logDir,
    FB_SPEC_WS_OK: wsOk ? '1' : '0',
    FB_SPEC_JOURNAL: journalPath,
    FB_SPEC_ANCESTOR: psDaemon
      ? 'node /nowhere/apps/cli/lib/bin.js --profile feishu-bridge'
      : '/sbin/launchd',
    DSH_HOME: dshHome,
    DSH_SESSION_ID: 'cc-20260822-174246-8add9cd530a3',
    DSH_SESSION_JSONL: sessionJsonl,
    XPC_SERVICE_NAME: '0',
  }
  const calls = () =>
    readFile(callsPath, 'utf8')
      .then(s => s.split('\n').filter(Boolean))
      .catch(() => [] as string[])
  return { env, calls }
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('reload.sh on Linux/systemd', () => {
  afterAll(async () => {
    await Promise.all(stubs.map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('restarts via systemctl and probes the journal for WS readiness', async () => {
    const s = await stageLinux()
    const result = await runScript(s.env)
    expect(result.code).toBe(0)
    expect(await s.calls()).toEqual(['--user cat feishu-bridge', '--user restart feishu-bridge'])
  }, 10000)

  it('refuses inside the daemon via DSH_SESSION_JSONL', async () => {
    const s = await stageLinux({ sessionStore: 'feishu-bridge' })
    const result = await runScript(s.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('inside the com.dsh.feishu-bridge daemon')
    expect(await s.calls()).toEqual([])
  }, 10000)

  it('fails loud before restart when the systemd unit is missing', async () => {
    const s = await stageLinux({ unitExists: false })
    const result = await runScript(s.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('systemd unit')
    expect(await s.calls()).toEqual(['--user cat feishu-bridge'])
  }, 10000)

  it('exits non-zero with the journal tail when WS readiness never appears', async () => {
    const s = await stageLinux({ wsOk: false })
    const result = await runScript(s.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("no 'ws client ready'")
  }, 10000)

  it('FB_RELOAD_FROM_DAEMON=1 bypasses the ppid walk (the /reload detached spawn)', async () => {
    const s = await stageLinux({ psDaemon: true })
    const result = await runScript({ ...s.env, FB_RELOAD_FROM_DAEMON: '1' })
    expect(result.code).toBe(0)
    expect(await s.calls()).toEqual(['--user cat feishu-bridge', '--user restart feishu-bridge'])
  }, 10000)

  it('FB_RELOAD_FROM_DAEMON=1 still refuses a daemon-hosted session (DSH_SESSION_JSONL guard stays)', async () => {
    const s = await stageLinux({ sessionStore: 'feishu-bridge' })
    const result = await runScript({ ...s.env, FB_RELOAD_FROM_DAEMON: '1' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('inside the com.dsh.feishu-bridge daemon')
    expect(await s.calls()).toEqual([])
  }, 10000)
})
