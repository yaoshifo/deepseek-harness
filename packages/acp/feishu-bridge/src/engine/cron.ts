/**
 * Cron domain ported from cc-connect core/cron.go: the persisted CronJob and
 * CronStore (jobs.json under `<dataDir>/crons/`, Go field names on disk), the
 * CronScheduler that fires jobs by injecting synthetic messages into engines
 * (plan MIGRATION.md §2: NOT mapped onto dsh schedule — the standard cron
 * expression grammar, session reuse/new-per-run, mute, and edit semantics are
 * ported as-is), the mute platform wrapper, and the human-readable cron
 * expression renderer.
 *
 * The Go robfig/cron dependency becomes a small standard-parser here: five
 * fields, numbers/ranges/steps/lists. robfig's month/weekday names
 * (`JAN`, `MON`) and `@every` descriptors are not supported — the stored jobs
 * and all ported tests use numeric fields only.
 *
 * @module dsh-feishu-bridge/cron
 */

import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../atomicwrite.ts'
import type { Platform } from '../core/types.ts'
import type { Engine } from './engine.ts'
import {
  langChinese,
  langJapanese,
  langSpanish,
  langTraditionalChinese,
  type Language,
} from '../i18n/index.ts'

/** How long the scheduler waits for a job run by default (Go defaultCronJobTimeout). */
export const defaultCronJobTimeoutMs = 30 * 60_000

/** A persisted scheduled task (Go CronJob). On-disk keys stay snake_case. */
export class CronJob {
  /** Unique job id (8 hex chars from {@link generateCronID}). */
  id: string = ''
  /** Project (engine) name the job executes on. */
  project: string = ''
  /** Key of the chat session the job was created in. */
  sessionKey: string = ''
  /** Standard 5-field cron expression. */
  cronExpr: string = ''
  /** Prompt injected on each run; empty for exec jobs. */
  prompt: string = ''
  /** Shell command; mutually exclusive with prompt. */
  exec: string = ''
  /** Working directory for exec; empty = agent work_dir. */
  workDir: string = ''
  /** Optional user label shown in listings; '' falls back to prompt/exec. */
  description: string = ''
  /** Whether the scheduler fires this job. */
  enabled: boolean = false
  /** Suppress the start notification; undefined = use the global default. */
  silent: boolean | undefined
  /** Suppress ALL messages (start + result); the job runs silently. */
  mute: boolean = false
  /** '' or 'reuse' = share the active session; 'new_per_run' = fresh session each run. */
  sessionMode: string = ''
  /** Permission mode override for this job; '' = project default. */
  mode: string = ''
  /** undefined = default 30m wait; 0 = no limit; >0 = minutes. */
  timeoutMins: number | undefined
  /** Creation time (ISO string; '' = never). */
  createdAt: string = ''
  /** Last run time (ISO string; '' = never). */
  lastRun: string = ''
  /** Error message of the last run; '' when it succeeded. */
  lastError: string = ''

  /**
   * True when the job runs a shell command directly.
   *
   * @returns Whether exec is set instead of a prompt.
   */
  isShellJob(): boolean {
    return this.exec !== ''
  }

  /**
   * How long the scheduler waits for the job run to finish (Go
   * ExecutionTimeout): undefined uses 30 minutes, 0 waits without a limit,
   * >0 means that many minutes.
   *
   * @returns The timeout in milliseconds (0 = unlimited).
   */
  executionTimeoutMs(): number {
    if (this.timeoutMins === undefined) return defaultCronJobTimeoutMs
    if (this.timeoutMins <= 0) return 0
    return this.timeoutMins * 60_000
  }

  /**
   * Whether each run should use a new engine session instead of the active one.
   *
   * @returns Whether session_mode normalizes to 'new_per_run'.
   */
  usesNewSessionPerRun(): boolean {
    return normalizeCronSessionMode(this.sessionMode) === 'new_per_run'
  }

  /**
   * Parse one persisted row (Go json.Unmarshal); Go zero times become ''.
   *
   * @param raw - Untyped JSON object with the Go snake_case keys.
   * @returns The populated job; unknown fields are ignored.
   */
  static fromJSON(raw: Record<string, unknown>): CronJob {
    const j = new CronJob()
    j.id = asString(raw.id)
    j.project = asString(raw.project)
    j.sessionKey = asString(raw.session_key)
    j.cronExpr = asString(raw.cron_expr)
    j.prompt = asString(raw.prompt)
    j.exec = asString(raw.exec)
    j.workDir = asString(raw.work_dir)
    j.description = asString(raw.description)
    j.enabled = raw.enabled === true
    j.silent = typeof raw.silent === 'boolean' ? raw.silent : undefined
    j.mute = raw.mute === true
    j.sessionMode = asString(raw.session_mode)
    j.mode = asString(raw.mode)
    j.timeoutMins = typeof raw.timeout_mins === 'number' ? raw.timeout_mins : undefined
    j.createdAt = zeroToEmpty(asString(raw.created_at))
    j.lastRun = zeroToEmpty(asString(raw.last_run))
    j.lastError = asString(raw.last_error)
    return j
  }

  /**
   * Serialize with the Go snake_case keys; empty optionals are omitted.
   *
   * @returns A JSON-ready object of the job's set fields.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: this.id,
      project: this.project,
      session_key: this.sessionKey,
      cron_expr: this.cronExpr,
      prompt: this.prompt,
      description: this.description,
      enabled: this.enabled,
    }
    if (this.exec !== '') out.exec = this.exec
    if (this.workDir !== '') out.work_dir = this.workDir
    if (this.silent !== undefined) out.silent = this.silent
    if (this.mute) out.mute = this.mute
    if (this.sessionMode !== '') out.session_mode = this.sessionMode
    if (this.mode !== '') out.mode = this.mode
    if (this.timeoutMins !== undefined) out.timeout_mins = this.timeoutMins
    if (this.createdAt !== '') out.created_at = this.createdAt
    if (this.lastRun !== '') out.last_run = this.lastRun
    if (this.lastError !== '') out.last_error = this.lastError
    return out
  }
}

/** Go's zero time ("0001-01-01...") reads back as the empty sentinel. */
function zeroToEmpty(v: string): string {
  return v.startsWith('0001-01-01') ? '' : v
}

/** Read one untyped JSON row value as a string ('' for anything else). */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Map CLI/API session-mode aliases to the canonical '' / 'new_per_run'.
 *
 * @param s - Raw session-mode string (case-insensitive).
 * @returns The canonical mode, or the input unchanged when unrecognized.
 */
export function normalizeCronSessionMode(s: string): string {
  const low = s.trim().toLowerCase()
  if (low === '' || low === 'reuse') return ''
  if (low === 'new_per_run' || low === 'new-per-run') return 'new_per_run'
  return s
}

/** The permission modes a cron-job override or a project agent.mode may name (Go validateCronJob). */
export const validJobModes = new Set(['default', 'bypassPermissions', 'acceptEdits', 'plan', 'auto', 'dontAsk'])

/**
 * Validate a job's session_mode/mode/timeout_mins (Go validateCronJob).
 *
 * @param j - The job to check.
 */
export function validateCronJob(j: CronJob): void {
  const mode = normalizeCronSessionMode(j.sessionMode)
  if (mode !== '' && mode !== 'new_per_run') {
    throw new Error(`invalid session_mode "${j.sessionMode}" (want reuse, new_per_run, or new-per-run)`)
  }
  if (j.mode !== '' && !validJobModes.has(j.mode)) {
    throw new Error(`invalid mode "${j.mode}" (want default, bypassPermissions, acceptEdits, plan, auto, or dontAsk)`)
  }
  if (j.timeoutMins !== undefined && j.timeoutMins < 0) {
    throw new Error('timeout_mins must be >= 0')
  }
}

/** Persist cron jobs to a JSON file (Go CronStore). */
export class CronStore {
  /** Absolute path of the jobs.json file. */
  readonly path: string
  private jobs: CronJob[] = []

  /**
   * @param dataDir - Root data directory; jobs live in `<dataDir>/crons/jobs.json`.
   */
  constructor(dataDir: string) {
    const dir = join(dataDir, 'crons')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'jobs.json')
    this.load()
  }

  private load(): void {
    let data: string
    try {
      data = readFileSync(this.path, 'utf8')
    } catch {
      return
    }
    try {
      const raw = JSON.parse(data) as unknown
      if (Array.isArray(raw)) this.jobs = raw.map(r => CronJob.fromJSON(r as Record<string, unknown>))
    } catch (error) {
      console.error(`cron: failed to load jobs (${this.path}): ${String(error)}`)
    }
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.path, new TextEncoder().encode(JSON.stringify(this.jobs.map(j => j.toJSON()), null, 2)), 0o644)
    } catch (error) {
      console.warn(`cron: failed to save jobs: ${String(error)}`)
    }
  }

  /**
   * Append a job and persist.
   *
   * @param job - The job to store.
   */
  add(job: CronJob): void {
    this.jobs.push(job)
    this.save()
  }

  /**
   * Remove a job by id; false when absent.
   *
   * @param id - Job id to remove.
   * @returns Whether a job was removed.
   */
  remove(id: string): boolean {
    const idx = this.jobs.findIndex(j => j.id === id)
    if (idx === -1) return false
    this.jobs.splice(idx, 1)
    this.save()
    return true
  }

  /**
   * Flip the enabled flag of a job; false when absent.
   *
   * @param id - Job id to update.
   * @param enabled - New enabled value.
   * @returns Whether the job was found.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const j = this.jobs.find(j => j.id === id)
    if (j === undefined) return false
    j.enabled = enabled
    this.save()
    return true
  }

  /**
   * Set the mute flag of a job; false when absent.
   *
   * @param id - Job id to update.
   * @param mute - New mute value.
   * @returns Whether the job was found.
   */
  setMute(id: string, mute: boolean): boolean {
    const j = this.jobs.find(j => j.id === id)
    if (j === undefined) return false
    j.mute = mute
    this.save()
    return true
  }

  /**
   * Toggle mute and return [newState, found].
   *
   * @param id - Job id to toggle.
   * @returns The new mute state and whether the job was found.
   */
  toggleMute(id: string): [newState: boolean, ok: boolean] {
    const j = this.jobs.find(j => j.id === id)
    if (j === undefined) return [false, false]
    j.mute = !j.mute
    this.save()
    return [j.mute, true]
  }

  /**
   * Stamp the last-run time and error of a job.
   *
   * @param id - Job id that just ran.
   * @param err - Failure message to record; undefined marks success.
   */
  markRun(id: string, err?: string): void {
    const j = this.jobs.find(j => j.id === id)
    if (j === undefined) return
    j.lastRun = new Date().toISOString()
    j.lastError = err ?? ''
    this.save()
  }

  /**
   * All jobs (shallow copy).
   *
   * @returns A copy of the stored jobs.
   */
  list(): CronJob[] {
    return [...this.jobs]
  }

  /**
   * Jobs belonging to one project.
   *
   * @param project - Project name to filter by.
   * @returns The matching jobs.
   */
  listByProject(project: string): CronJob[] {
    return this.jobs.filter(j => j.project === project)
  }

  /**
   * Jobs bound to one session key.
   *
   * @param sessionKey - Session key to filter by.
   * @returns The matching jobs.
   */
  listBySessionKey(sessionKey: string): CronJob[] {
    return this.jobs.filter(j => j.sessionKey === sessionKey)
  }

  /**
   * Look up one job.
   *
   * @param id - Job id to find.
   * @returns The job, or undefined when absent.
   */
  get(id: string): CronJob | undefined {
    return this.jobs.find(j => j.id === id)
  }

  /**
   * Modify one field of a cron job (Go CronStore.Update). id, created_at,
   * last_run, and last_error are read-only; false when the job is missing or
   * the field/value pair is invalid.
   *
   * @param id - Job id to update.
   * @param field - Snake_case field name to set.
   * @param value - New value; must match the field's type.
   * @returns Whether the field was applied and persisted.
   */
  update(id: string, field: string, value: unknown): boolean {
    const readOnlyFields = new Set(['id', 'created_at', 'last_run', 'last_error'])
    if (readOnlyFields.has(field)) return false
    const j = this.jobs.find(j => j.id === id)
    if (j === undefined) return false
    if (!updateJobField(j, field, value)) return false
    this.save()
    return true
  }
}

/**
 * Editable snake_case field names mapped to their {@link CronJob} properties.
 * Unlike Go's reflection-based updateJobField, the property names differ from
 * the on-disk keys for the camelCase fields.
 */
const editableStringFields: Readonly<Record<string, string>> = {
  project: 'project',
  session_key: 'sessionKey',
  cron_expr: 'cronExpr',
  prompt: 'prompt',
  exec: 'exec',
  work_dir: 'workDir',
  description: 'description',
  session_mode: 'sessionMode',
  mode: 'mode',
}

/** Set one field by its snake_case name (Go updateJobField, sans reflection). */
function updateJobField(job: CronJob, field: string, value: unknown): boolean {
  const prop = editableStringFields[field]
  if (prop !== undefined) {
    if (typeof value === 'string') {
      ;(job as unknown as Record<string, string>)[prop] = value
      return true
    }
    return false
  }
  switch (field) {
    case 'enabled':
      if (typeof value === 'boolean') {
        job.enabled = value
        return true
      }
      return false
    case 'silent':
      if (typeof value === 'boolean') {
        job.silent = value
        return true
      }
      return false
    case 'mute':
      if (typeof value === 'boolean') {
        job.mute = value
        return true
      }
      return false
    case 'timeout_mins':
      if (typeof value === 'number') {
        job.timeoutMins = Math.trunc(value)
        return true
      }
      return false
    default:
      return false
  }
}

// ── cron expression parsing (robfig/cron v3 ParseStandard subset) ─────────

interface CronField {
  values: Set<number>
  star: boolean
}

/** A parsed standard 5-field cron expression. */
export interface CronSchedule {
  /** The next matching time strictly after `from`. Throws when nothing matches within ~4 years. */
  next(from: Date): Date
}

interface FieldDef {
  name: string
  min: number
  max: number
  /** Maps 7 to Sunday=0 like robfig's day-of-week handling. */
  wrapTo?: number
}

const fieldDefs: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7, wrapTo: 0 },
]

/**
 * Parse a standard 5-field cron expression (`m h dom mon dow`) supporting
 * numbers, `*`, ranges, steps, and lists. Throws on any other syntax
 * (Go cron.ParseStandard error surface).
 *
 * @param expr - The raw expression string.
 * @returns A schedule that computes the next matching time.
 */
export function parseCronStandard(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5 || fields[0] === '') {
    throw new Error(`expected exactly 5 fields, found ${fields.length}: [${fields.join(' ')}]`)
  }
  const minuteF = fieldOf(fields, 0)
  const hourF = fieldOf(fields, 1)
  const domF = fieldOf(fields, 2)
  const monthF = fieldOf(fields, 3)
  const dowF = fieldOf(fields, 4)

  return {
    next(from: Date): Date {
      const t = new Date(from)
      t.setSeconds(0, 0)
      t.setMinutes(t.getMinutes() + 1)
      // Generous cap (~4 years of minutes) instead of an infinite loop.
      for (let i = 0; i < 2_200_000; i++) {
        if (!monthF.values.has(t.getMonth() + 1)) {
          t.setMonth(t.getMonth() + 1, 1)
          t.setHours(0, 0, 0, 0)
          continue
        }
        const domOk = domF.star || domF.values.has(t.getDate())
        const dowOk = dowF.star || dowF.values.has(t.getDay())
        // Vixie cron: when both day fields are restricted, either may match.
        const dayOk = domF.star && dowF.star
          ? true
          : domF.star ? dowOk : dowF.star ? domOk : domOk || dowOk
        if (!dayOk) {
          t.setDate(t.getDate() + 1)
          t.setHours(0, 0, 0, 0)
          continue
        }
        if (!hourF.values.has(t.getHours())) {
          t.setHours(t.getHours() + 1, 0, 0, 0)
          continue
        }
        if (!minuteF.values.has(t.getMinutes())) {
          t.setMinutes(t.getMinutes() + 1, 0, 0)
          continue
        }
        return new Date(t)
      }
      throw new Error('cron: no matching time within 4 years')
    },
  }
}

/** Parse one positional field against its definition. */
function fieldOf(fields: string[], i: number): CronField {
  const def = fieldDefs[i]
  if (def === undefined) throw new Error(`cron: missing field definition ${i}`)
  return parseCronField(fields[i] ?? '', def)
}

/** Parse one field into its allowed value set (Go robfig field parser). */
function parseCronField(text: string, def: FieldDef): CronField {
  const values = new Set<number>()
  let star = false
  for (const part of text.split(',')) {
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      range = part.slice(0, slash)
      step = Number.parseInt(part.slice(slash + 1), 10)
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid step in field ${def.name}: "${part}"`)
      }
    }
    let lo: number, hi: number
    if (range === '*' || range === '') {
      if (range === '' && slash === -1) {
        throw new Error(`empty range in field ${def.name}: "${text}"`)
      }
      lo = def.min
      hi = def.max
      if (slash === -1) star = true
    } else {
      const dash = range.indexOf('-')
      if (dash !== -1) {
        lo = Number.parseInt(range.slice(0, dash), 10)
        hi = Number.parseInt(range.slice(dash + 1), 10)
      } else {
        lo = Number.parseInt(range, 10)
        hi = slash !== -1 ? def.max : lo
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < def.min || hi > def.max || lo > hi) {
      throw new Error(`invalid value in field ${def.name}: "${part}" (range ${def.min}-${def.max})`)
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(def.wrapTo !== undefined && v === def.max ? def.wrapTo : v)
    }
  }
  if (values.size === 0) {
    throw new Error(`empty field ${def.name}: "${text}"`)
  }
  return { values, star }
}

// ── scheduler ─────────────────────────────────────────────────────────────

/** One scheduled entry: the job's parsed schedule and its next fire time. */
interface CronEntry {
  schedule: CronSchedule
  next: Date
}

/**
 * Runs cron jobs by injecting synthetic messages into engines (Go
 * CronScheduler). One instance serves every project's engine; the store is
 * shared process-wide.
 */
export class CronScheduler {
  private readonly storeValue: CronStore
  private readonly engines = new Map<string, Engine>()
  private readonly entries = new Map<string, CronEntry>()
  private timer: ReturnType<typeof setInterval> | undefined
  private defaultSilent = false
  private defaultSessionMode = ''

  constructor(store: CronStore) {
    this.storeValue = store
  }

  /**
   * The backing store (Go Store()).
   *
   * @returns The shared job store.
   */
  store(): CronStore {
    return this.storeValue
  }

  /**
   * Map a project name to the engine its jobs execute on.
   *
   * @param name - Project name jobs reference.
   * @param e - Engine that will run those jobs.
   */
  registerEngine(name: string, e: Engine): void {
    this.engines.set(name, e)
  }

  /**
   * Global default for suppressing cron start notifications.
   *
   * @param silent - Default silent value for jobs without their own setting.
   */
  setDefaultSilent(silent: boolean): void {
    this.defaultSilent = silent
  }

  /**
   * Global default session mode ('' / 'reuse' / 'new_per_run').
   *
   * @param mode - Raw mode string; normalized before storing.
   */
  setDefaultSessionMode(mode: string): void {
    this.defaultSessionMode = normalizeCronSessionMode(mode)
  }

  /**
   * Whether the job should suppress the start notification.
   *
   * @param job - The job being asked about.
   * @returns The job's own silent flag, or the global default.
   */
  isSilent(job: CronJob): boolean {
    if (job.silent !== undefined) return job.silent
    return this.defaultSilent
  }

  /**
   * Whether the job should create a fresh session per run, honoring defaults.
   *
   * @param job - The job being asked about.
   * @returns The job's resolved session mode outcome.
   */
  usesNewSession(job: CronJob): boolean {
    if (job.sessionMode !== '') return job.usesNewSessionPerRun()
    return this.defaultSessionMode === 'new_per_run'
  }

  /** Schedule every enabled stored job and start the tick loop. */
  start(): void {
    const jobs = this.storeValue.list()
    for (const job of jobs) {
      if (job.enabled) {
        try {
          this.scheduleJob(job)
        } catch (error) {
          console.warn(`cron: failed to schedule job (${job.id}): ${String(error)}`)
        }
      }
    }
    this.timer ??= setInterval(() => { this.tick() }, 1000)
    this.timer.unref()
    console.info(`cron: scheduler started (jobs: ${jobs.length})`)
  }

  /** Stop the tick loop (Go Stop; entries stay for a later restart). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Validate, normalize, persist, and schedule one job (Go AddJob).
   *
   * @param job - The job to add; must carry a valid expression.
   */
  addJob(job: CronJob): void {
    validateCronJob(job)
    job.sessionMode = normalizeCronSessionMode(job.sessionMode)
    try {
      parseCronStandard(job.cronExpr)
    } catch (error) {
      throw new Error(`invalid cron expression "${job.cronExpr}": ${String(error instanceof Error ? error.message : error)}`)
    }
    this.storeValue.add(job)
    if (job.enabled) this.scheduleJob(job)
  }

  /**
   * Remove a stored job and its schedule; false when absent.
   *
   * @param id - Job id to remove.
   * @returns Whether a job was removed.
   */
  removeJob(id: string): boolean {
    this.entries.delete(id)
    return this.storeValue.remove(id)
  }

  /**
   * Enable and schedule a job; throws when absent.
   *
   * @param id - Job id to enable.
   */
  enableJob(id: string): void {
    if (!this.storeValue.setEnabled(id, true)) throw new Error(`job "${id}" not found`)
    const job = this.storeValue.get(id)
    if (job !== undefined) this.scheduleJob(job)
  }

  /**
   * Disable a job and drop its schedule; throws when absent.
   *
   * @param id - Job id to disable.
   */
  disableJob(id: string): void {
    if (!this.storeValue.setEnabled(id, false)) throw new Error(`job "${id}" not found`)
    this.entries.delete(id)
  }

  /**
   * Modify a field of a job and reschedule when needed (Go UpdateJob).
   * Throws when the job is missing, the field is read-only, or the value is
   * invalid.
   *
   * @param id - Job id to update.
   * @param field - Snake_case field name to set.
   * @param value - New value; must match the field's type.
   */
  updateJob(id: string, field: string, value: unknown): void {
    const job = this.storeValue.get(id)
    if (job === undefined) throw new Error(`job "${id}" not found`)

    if (field === 'cron_expr') {
      if (typeof value !== 'string') throw new Error('cron_expr must be a string')
      try {
        parseCronStandard(value)
      } catch (error) {
        throw new Error(`invalid cron expression "${value}": ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    if (field === 'mode' && typeof value === 'string' && value !== '' && !validJobModes.has(value)) {
      throw new Error(`invalid mode "${value}" (want default, bypassPermissions, acceptEdits, plan, auto, or dontAsk)`)
    }
    if (field === 'session_mode' && typeof value === 'string' && value !== '') {
      const mode = normalizeCronSessionMode(value)
      if (mode !== '' && mode !== 'new_per_run') {
        throw new Error(`invalid session_mode "${value}" (want reuse, new_per_run, or new-per-run)`)
      }
    }

    const needsReschedule = field === 'cron_expr' || field === 'enabled'
    if (needsReschedule) this.entries.delete(id)

    if (!this.storeValue.update(id, field, value)) {
      throw new Error(`failed to update field "${field}" (may be read-only or invalid type)`)
    }

    if (needsReschedule) {
      const updatedJob = this.storeValue.get(id)
      if (updatedJob !== undefined && updatedJob.enabled) this.scheduleJob(updatedJob)
    }
  }

  /**
   * The next scheduled run time for a job, or undefined when unscheduled.
   *
   * @param jobID - Job id to look up.
   * @returns The next fire time, or undefined when not armed.
   */
  nextRun(jobID: string): Date | undefined {
    return this.entries.get(jobID)?.next
  }

  /** Parse and arm one job's schedule (Go scheduleJob, with replacement). */
  private scheduleJob(job: CronJob): void {
    const schedule = parseCronStandard(job.cronExpr)
    this.entries.set(job.id, { schedule, next: schedule.next(new Date()) })
  }

  /** Fire every due entry (Go cron's 1s resolution loop). */
  private tick(): void {
    const now = Date.now()
    for (const [id, entry] of this.entries) {
      if (entry.next.getTime() <= now) {
        try {
          entry.next = entry.schedule.next(new Date(now))
        } catch (error) {
          console.warn(`cron: dropping job with no future schedule (${id}): ${String(error)}`)
          this.entries.delete(id)
          continue
        }
        void this.executeJob(id).catch((error: unknown) => {
          console.error(`cron: execute job crashed (${id}): ${String(error)}`)
        })
      }
    }
  }

  /** Jobs whose previous fire is still running; the tick skips these. */
  private readonly runningJobs = new Set<string>()

  /** Run one job with its execution timeout and record the outcome (Go executeJob). */
  private async executeJob(jobID: string): Promise<void> {
    const job = this.storeValue.get(jobID)
    if (job === undefined || !job.enabled) return

    // Overlap guard: a slow (or timed-out-but-still-running) job must not
    // stack a second concurrent run on the same schedule slot.
    if (this.runningJobs.has(jobID)) {
      console.warn(`cron: job still running from its previous fire, skipping (${jobID})`)
      return
    }
    this.runningJobs.add(jobID)
    try {
      await this.executeJobLocked(jobID, job)
    } finally {
      this.runningJobs.delete(jobID)
    }
  }

  private async executeJobLocked(jobID: string, job: CronJob): Promise<void> {
    const engine = this.engines.get(job.project)
    if (engine === undefined) {
      console.error(`cron: project not found (job ${jobID}, project ${job.project})`)
      this.storeValue.markRun(jobID, `project "${job.project}" not found`)
      return
    }

    console.info(`cron: executing job (id ${jobID}, project ${job.project}, prompt ${truncateStr(job.prompt, 60)})`)

    const timeout = job.executionTimeoutMs()
    let err: unknown
    // The controller cancels the running turn when the timeout fires —
    // racing the await alone leaves the underlying turn burning.
    const cancel = new AbortController()
    const run = engine.executeCronJob(job, cancel.signal).then(() => undefined, (e: unknown) => e)
    if (timeout > 0) {
      err = await Promise.race([
        run,
        new Promise<unknown>((resolve) => { setTimeout(() => { cancel.abort(); resolve(new Error(`job timed out after ${timeout}ms`)) }, timeout).unref() }),
      ])
    } else {
      err = await run
    }

    this.storeValue.markRun(jobID, err === undefined ? undefined : errMessage(err))

    if (err !== undefined) {
      console.error(`cron: job failed (id ${jobID}): ${errMessage(err)}`)
    } else {
      console.info(`cron: job completed (id ${jobID})`)
    }
  }
}

/**
 * Wrap a platform discarding all outgoing messages (Go mutePlatform): Reply
 * and Send become no-ops while every other capability delegates to the inner
 * platform.
 *
 * @param inner - The platform whose message sends should be suppressed.
 * @returns The muting wrapper.
 */
export function mutePlatform(inner: Platform): Platform {
  return {
    name: () => inner.name(),
    start: handler => inner.start(handler),
    reply: async () => {},
    send: async () => {},
    stop: () => inner.stop(),
  }
}

/**
 * Generate an 8-hex-char job id (Go GenerateCronID).
 *
 * @returns A random id, unique with overwhelming probability.
 */
export function generateCronID(): string {
  return randomBytes(4).toString('hex')
}

/** Render an unknown job failure as a display string. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}

/**
 * Truncate a string to n runes with an ellipsis (Go truncateStr).
 *
 * @param s - The string to shorten.
 * @param n - Maximum rune count before truncation.
 * @returns The original string, or the first n runes plus '...'.
 */
export function truncateStr(s: string, n: number): string {
  const runes = Array.from(s)
  if (runes.length <= n) return s
  return `${runes.slice(0, n).join('')}...`
}

// ── human-readable rendering (Go CronExprToHuman) ─────────────────────────

const cronWeekdays: Record<string, string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  'zh-TW': ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
  ja: ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
}

const cronMonths: Record<string, string[]> = {
  en: ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  zh: ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  'zh-TW': ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  ja: ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
  es: ['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
}

function cronLangNames(lang: Language): { weekdays: string[]; months: string[] } {
  return {
    weekdays: cronWeekdays[lang] ?? (cronWeekdays.en as string[]),
    months: cronMonths[lang] ?? (cronMonths.en as string[]),
  }
}

function isZhLikeLang(lang: Language): boolean {
  return lang === langChinese || lang === langTraditionalChinese || lang === langJapanese
}

/** Parse a cron step field (a star-slash prefix like 5-minute steps) and return the step. */
function parseStep(field: string): number | undefined {
  if (!field.startsWith('*/')) return undefined
  const n = Number.parseInt(field.slice(2), 10)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function padZero(s: string): string {
  return s.length === 1 ? `0${s}` : s
}

/**
 * Convert a standard 5-field cron expression to a human-readable string
 * (Go CronExprToHuman); unrecognized shapes return the raw expression.
 *
 * @param expr - The raw 5-field cron expression.
 * @param lang - Language to render weekday/month names in.
 * @returns The localized description, or the raw expression when unparseable.
 */
export function cronExprToHuman(expr: string, lang: Language): string {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return expr
  const minute = fields[0] ?? ''
  const hour = fields[1] ?? ''
  const dom = fields[2] ?? ''
  const month = fields[3] ?? ''
  const dow = fields[4] ?? ''
  const { weekdays, months } = cronLangNames(lang)
  const cjk = isZhLikeLang(lang)
  const allWild = dom === '*' && month === '*' && dow === '*'

  // Pure interval: */N * * * * → "Every N minutes"
  const minStep = parseStep(minute)
  if (minStep !== undefined && hour === '*' && allWild) {
    switch (lang) {
      case langChinese: return `每${minStep}分钟`
      case langTraditionalChinese: return `每${minStep}分鐘`
      case langJapanese: return `${minStep}分ごと`
      case langSpanish: return `Cada ${minStep} min`
      default: return `Every ${minStep} min`
    }
  }

  // Hour interval: M */N * * * → "Every N hours (:MM)"
  const hourStep = parseStep(hour)
  if (hourStep !== undefined && allWild) {
    const m = minute === '*' ? '00' : padZero(minute)
    switch (lang) {
      case langChinese: return `每${hourStep}小时 (:${m})`
      case langTraditionalChinese: return `每${hourStep}小時 (:${m})`
      case langJapanese: return `${hourStep}時間ごと (:${m})`
      case langSpanish: return `Cada ${hourStep} h (:${m})`
      default: return `Every ${hourStep} h (:${m})`
    }
  }

  const parts: string[] = []

  // Weekday
  if (dow !== '*') {
    const n = Number.parseInt(dow, 10)
    if (Number.isInteger(n) && n >= 0 && n <= 6) {
      parts.push(cjk ? (weekdays[n] ?? '') : `Every ${weekdays[n] ?? ''}`)
    } else {
      parts.push(`weekday(${dow})`)
    }
  }

  // Month
  if (month !== '*') {
    const n = Number.parseInt(month, 10)
    if (Number.isInteger(n) && n >= 1 && n <= 12) {
      parts.push(months[n] ?? '')
    }
  }

  // Day of month
  if (dom !== '*') {
    parts.push(cjk ? `${dom}日` : `day ${dom}`)
  }

  // Time
  if (hour !== '*' && minute !== '*') {
    if (minStep !== undefined) {
      switch (lang) {
        case langChinese: case langTraditionalChinese:
          parts.push(`${padZero(hour)}时 每${minStep}分钟`)
          break
        case langJapanese:
          parts.push(`${padZero(hour)}時 ${minStep}分ごと`)
          break
        default:
          parts.push(`hour ${padZero(hour)} every ${minStep} min`)
      }
    } else {
      parts.push(`${padZero(hour)}:${padZero(minute)}`)
    }
  } else if (hour !== '*') {
    parts.push(cjk ? `${hour}時` : `hour ${hour}`)
  } else if (minute !== '*') {
    if (minStep !== undefined) {
      switch (lang) {
        case langChinese: parts.push(`每${minStep}分钟`); break
        case langTraditionalChinese: parts.push(`每${minStep}分鐘`); break
        case langJapanese: parts.push(`${minStep}分ごと`); break
        default: parts.push(`every ${minStep} min`)
      }
    } else {
      switch (lang) {
        case langChinese: case langTraditionalChinese:
          parts.push(`每小时第${minute}分`)
          break
        case langJapanese:
          parts.push(`毎時${minute}分`)
          break
        default:
          parts.push(`minute ${minute} of every hour`)
      }
    }
  }

  // Frequency hint
  if (allWild) {
    switch (lang) {
      case langChinese: case langTraditionalChinese:
        return `每天 ${parts.join(' ')}`
      case langJapanese:
        return `毎日 ${parts.join(' ')}`
      case langSpanish:
        return `Diario ${parts.join(' ')}`
      default:
        return `Daily at ${parts.join(' ')}`
    }
  }
  if (dow !== '*' && month === '*' && dom === '*') {
    switch (lang) {
      case langChinese: case langTraditionalChinese:
        return `每${parts.join(' ')}`
      case langJapanese:
        return `毎${parts.join(' ')}`
      default:
        return parts.join(' at ')
    }
  }
  if (dom !== '*' && month === '*' && dow === '*') {
    switch (lang) {
      case langChinese: case langTraditionalChinese:
        return `每月${parts.join(' ')}`
      case langJapanese:
        return `毎月${parts.join(' ')}`
      case langSpanish:
        return `Mensual, ${parts.join(', ')}`
      default:
        return `Monthly, ${parts.join(', ')}`
    }
  }

  return cjk ? parts.join(' ') : parts.join(', ')
}
