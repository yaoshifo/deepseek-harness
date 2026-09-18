/**
 * Plan mode is logged per-agent collaboration state: while active, a
 * deployment-owned guidance section is included in each model request, and
 * `exit_plan_mode` presents the completed plan for user review, while the
 * `/plan off` command lets a user leave directly. Sandbox mode and approval
 * policy enforce restrictions independently and do not read or write plan
 * state.
 *
 * The `plan` projection folds the session log, so resume and fork restore the
 * state. User selections remain pending until the next accepted in-turn
 * pre-step. The service includes the selected state in the proposed step
 * assembly, then appends `plan/mode` from `agent/pre-step` only when the step
 * is accepted. Same-step request retries reuse their assembly.
 *
 * The exit tool remains registered while plan mode is inactive, so entering
 * or leaving plan mode changes only the prompt section, not the request tool
 * catalog.
 *
 * Agent Note:
 * - .agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md
 *
 * @module @deepseek-ai/dsh-plan-mode
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { CommandDefinitionId, CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { PlanProjection, PlanUnitState } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whether plan mode is in force from this point on: log-only, non-surface,
     * whole-value replace. The last `plan/mode` wins; a log with none folds to
     * inactive through the projection unit's fold.
     */
    'plan/mode': { active: boolean }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    planMode: PlanModeController
  }
}

/**
 * The model-facing exit tool's name. It stays registered while plan mode is
 * inactive so the request tool catalog is stable across transitions.
 */
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** Deployment-owned plan guidance. */
export interface PlanModeConfig {
  /** Guidance rendered as the `plan:policy` prompt section while plan mode is active. */
  section: string
  /**
   * Hold `exit_plan_mode` for the rest of the turn after a rejected review:
   * same-turn re-presentations bounce, and the user speaking again lifts the
   * hold — their next message, or their answer to a question card. Off
   * (default) keeps the classic revise-and-present-again rhythm.
   */
  rejectionHold?: boolean
}

/** The review question's id, echoed in the answer this tool reads. */
const REVIEW_ID = 'plan-review'

/** The review question's approve option label. */
const APPROVE_LABEL = 'Approve'

/** The review question's keep-planning option label. */
const KEEP_PLANNING_LABEL = 'Keep planning'

// Mechanism only: how the agent acts on rejection feedback is deployment-owned
// policy in the plan-mode section, so the description stays policy-free.
const EXIT_DESCRIPTION
  = 'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
  + 'Send the COMPLETE plan as markdown, starting with a # heading that names it — `plan` carries the '
  + 'plain-language layer, `details` the implementation-detail layer. '
  + 'The user may approve (carry out the plan from your next step) or keep '
  + 'planning — their feedback comes back in the tool result.'
  + ' An optional `details` argument carries an implementation-detail annex after the plan; capable UIs present it collapsed by default.'
  + ' An inlined details section is rejected unless its content rides in `details`.'

/** The plan's first markdown heading (any level), or `undefined` when it has none. */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/** Whitespace-only `details` submissions read as absent; a real annex keeps its original text untrimmed. */
function normalizeDetails(details: string | undefined): string | undefined {
  return details !== undefined && details.trim() !== '' ? details : undefined
}

/** Heading titles that mark an inlined implementation-details section in the
 * plan; a match without a submitted `details` annex is a mislayered exit.
 * English titles are held lowercase and matched case-insensitively. */
const EMBEDDED_DETAILS_TITLES = new Set([
  '实施细节',
  '技术细节',
  'implementation detail',
  'implementation details',
  'implementation note',
  'implementation notes',
])

/** The plan's inlined implementation-details heading title, or `undefined`
 * when the plan carries no such section. Matches ATX headings of levels 2-6
 * outside fenced code blocks: a heading inside a fence is quoted content,
 * not a plan section. */
function embeddedDetailsHeading(plan: string): string | undefined {
  let inFence = false
  // CRLF input leaves a trailing `\r` on each `split('\n')` line; strip it
  // once so the fence and heading patterns below stay line-ending agnostic.
  for (const rawLine of plan.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    // A fence-marker line opens a fence (an info string may follow); inside
    // a fence only a bare marker closes it, regardless of the opening run's
    // length. Tilde fences are not tracked.
    if (/^ {0,3}`{3}/.test(line)) {
      if (!inFence || /^ {0,3}`{3,}[ \t]*$/.test(line)) inFence = !inFence
      continue
    }
    if (inFence) continue
    const title = /^#{2,6}[ \t]+(.+?)[ \t]*$/.exec(line)?.[1]
    if (title !== undefined && EMBEDDED_DETAILS_TITLES.has(title.toLowerCase())) return title
  }
  return undefined
}

/**
 * Validate deployment-owned plan guidance. Missing, blank, non-string, or
 * unknown fields fail at plugin load rather than being ignored.
 *
 * @param config Raw plugin config.
 * @returns A detached validated config with `rejectionHold` defaulted.
 */
export function resolveConfig(config: PlanModeConfig): PlanModeConfig {
  const section = (config as Partial<PlanModeConfig>).section
  if (typeof section !== 'string') {
    throw new Error('PlanModeConfig needs a string `section`')
  }
  if (section.trim() === '') {
    throw new Error('PlanModeConfig needs a non-empty `section`')
  }
  const rejectionHold = (config as Partial<PlanModeConfig>).rejectionHold
  if (rejectionHold !== undefined && typeof rejectionHold !== 'boolean') {
    throw new Error('PlanModeConfig needs a boolean `rejectionHold`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'section' && key !== 'rejectionHold')
  if (unknown.length > 0) {
    throw new Error(`PlanModeConfig has unknown key(s) ${unknown.join(', ')} — config is { section, rejectionHold }`)
  }
  return { section, rejectionHold: rejectionHold ?? false }
}

const planUnitStateSchema: ZodType<PlanUnitState> = zod.object({
  active: zod.boolean(),
  wanted: zod.boolean().nullable(),
  running: zod.object({
    commandId: zod.string() as unknown as ZodType<CommandId>,
    wanted: zod.boolean(),
  }).strict().nullable(),
  activeAtLastHeader: zod.boolean().nullable(),
}).strict()

/** Wire payload schema of the `plan` projection. */
const planProjectionSchema: ZodType<PlanProjection> = zod.object({
  active: zod.boolean(),
  pending: zod.boolean(),
})

/** Projection of logged plan selections and committed mode. */
export const planProjectionDefinition = {
  key: 'plan',
  stateVersion: 3,
  stateSchema: planUnitStateSchema,
  init: () => ({ active: false, wanted: null, running: null, activeAtLastHeader: null }),
  apply: (state, event) => {
    if (event.type === 'command/run' && event.data.name === 'plan') {
      if (event.data.args === undefined) return state
      const wanted = event.data.args.trim() !== 'off'
      return { ...state, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done' && event.data.commandId === state.running?.commandId) {
      const wanted = event.data.kind === 'success' && state.running.wanted !== state.active
        ? state.running.wanted
        : null
      return { ...state, wanted, running: null }
    }
    if (event.type === 'plan/mode') {
      return { ...state, active: event.data.active, wanted: null }
    }
    if (event.type === 'request/header') {
      return { ...state, activeAtLastHeader: state.active }
    }
    return state
  },
  wire: {
    viewSchema: planProjectionSchema,
    view: (state) => {
      const wanted = state.running?.wanted ?? state.wanted
      return { active: state.active, pending: wanted !== null && wanted !== state.active }
    },
  },
} satisfies ProjectionDefinition<'plan', PlanUnitState>

/**
 * `ctx.planMode`: owns logged plan state, applies and narrates selected state at step start,
 * the `plan:policy` section, the `/plan` command, and the stable exit tool.
 * Client carriers expose the projection's cropped `{ active, pending }` view.
 */
export class PlanModeController extends Service {
  static inject = ['tools', 'systemPrompt', 'sessionProjections']

  /** Validated deployment-owned guidance. */
  private readonly section: string

  /** Whether a rejected review holds `exit_plan_mode` until the user speaks again. */
  private readonly rejectionHold: boolean

  /**
   * Latest selection per session awaiting the next accepted in-turn pre-step.
   * `narrate` is true for user selections and false for the exit tool, whose
   * result already narrates the transition.
   */
  private readonly pendingIntents = new WeakMap<Session, { active: boolean; narrate: boolean }>()

  /**
   * Open turn's start seq per session whose review was rejected, while
   * `rejectionHold` is enabled: `exit_plan_mode` bounces until the user speaks
   * again — their next message (a new turn or a mid-turn steer) or their answer
   * to a question card both lift it — or until a later turn.
   */
  private readonly heldTurns = new WeakMap<Session, number>()

  constructor(ctx: Context, config: PlanModeConfig = { section: '' }) {
    super(ctx, 'planMode')
    const resolved = resolveConfig(config)
    this.section = resolved.section
    this.rejectionHold = resolved.rejectionHold ?? false
    let disposed = false
    // Pre-step is outside Session.append publication, so it can append the
    // log-only mode event inside an open turn without re-entering the session.
    // A failed append remains pending for a later accepted in-turn pre-step,
    // and policy cannot block the step.
    ctx.on('agent/pre-step', async (
      { agent, signal, messages },
      next,
    ): Promise<PreStepDecision> => {
      // Any user message claimed by this step — the turn-opening prompt or a
      // mid-turn steer — is the user speaking: it lifts a rejection hold.
      if (this.heldTurns.has(agent.session) && messages.some(message => message.source.kind === 'user')) {
        this.heldTurns.delete(agent.session)
      }
      const decision = await next()
      const pending = this.pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      const narration = this.narration(agent.session, pending.active)
      try {
        this.onBoundary(agent.session)
      } catch (error) {
        ctx.logger.warn('dsh-plan-mode: failed to append selected plan mode at step start: %o', error)
        return decision
      }
      return !pending.narrate || narration === undefined
        ? decision
        : { ...decision, messages: [...decision.messages, narration] }
    })
    ctx.effect(() => () => { disposed = true }, 'dsh-plan-mode: close service lifetime')

    if (this.rejectionHold) {
      // A human answer to any question is the user speaking, exactly like a
      // typed message, so it lifts the hold. The plugin's own review settle is
      // not new input — the hold is armed only after the review returns — and
      // excluding it keeps the hold intact even if the announcement ever moves
      // past the asker's continuation.
      ctx.on('user-questions/answered', ({ agent, answer }) => {
        if (!this.heldTurns.has(agent.session)) return
        if (answer.answers.some(item => item.id === REVIEW_ID)) return
        this.heldTurns.delete(agent.session)
      })
    }

    ctx.systemPrompt.section({
      name: 'plan:policy',
      order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
      text: (context) => {
        if (context.agent === undefined) return ''
        const pending = this.pendingIntents.get(context.agent.session)
        return (pending?.active ?? this.loggedActive(context.agent.session)) ? this.section : ''
      },
    })

    ctx.sessionProjections.register(planProjectionDefinition)

    // The command child activates only when a command registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-plan-mode'),
        name: 'plan',
        description: 'Enter or leave plan mode',
        input: { hint: '[off|message]', attachments: true },
        handler: ({ agent, rawInput, attachments }) => {
          const message = rawInput.trim()
          if (message === 'off' && attachments.length > 0) {
            return { kind: 'error', text: 'Attachments cannot accompany /plan off.' }
          }
          if (message === 'off') {
            switch (this.set(agent, false)) {
              case 'committed':
                return { kind: 'success', text: 'Plan mode off.' }
              case 'queued':
                return { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
              case 'cancelled':
                return { kind: 'success', text: 'Plan mode entry cancelled.' }
              case 'noop':
                // Repeat the queued wording while an exit still awaits the
                // next accepted pre-step; only a truly inactive session reads
                // idempotent.
                return this.loggedActive(agent.session)
                  ? { kind: 'success', text: 'Leaving plan mode (applies from the next step).' }
                  : { kind: 'success', text: 'Plan mode is already inactive.' }
            }
          }
          const outcome = this.set(agent, true)
          if (message !== '' || attachments.length > 0) {
            agent.steer(createUserMessage({
              content: [
                ...attachments,
                ...(message === '' ? [] : [{ type: 'text' as const, text: message }]),
              ],
              source: { kind: 'user' },
            }))
          }
          switch (outcome) {
            case 'committed':
              return { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' }
            case 'queued':
              return { kind: 'success', text: 'Entering plan mode (applies from the next step). Use /plan off to leave.' }
            case 'cancelled':
              return { kind: 'success', text: 'Plan mode exit cancelled — still in plan mode. Use /plan off to leave.' }
            case 'noop':
              // Repeat the queued wording while an entry still awaits the
              // next accepted pre-step; only a truly active session reads
              // idempotent.
              return this.loggedActive(agent.session)
                ? { kind: 'success', text: 'Plan mode is already active.' }
                : { kind: 'success', text: 'Entering plan mode (applies from the next step). Use /plan off to leave.' }
          }
        },
      })
    })

    ctx.tools.register(defineTool({
      name: EXIT_PLAN_MODE,
      description: EXIT_DESCRIPTION,
      parameters: {
        plan: { type: 'string', required: true, description: 'The plan\'s plain-language layer, as markdown, starting with a # heading that names it.' },
        details: { type: 'string', description: 'Implementation-detail annex appended after the plan; capable UIs present it collapsed by default. Put implementation detail here instead of inlining a details section into the plan; omit only when the plan carries no implementation detail.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean', const: true, required: true },
          },
        },
        render: () => [{ type: 'text', text: 'Plan approved — plan mode exited; carry out the plan starting with your next step.' }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${EXIT_PLAN_MODE} requires a calling agent (no session to switch)`)
        // The same optimistic read as the plan:policy section — a selection
        // awaiting the next accepted in-turn pre-step already counts — so the
        // guidance the model sees and this gate cannot disagree.
        const pending = this.pendingIntents.get(agent.session)
        if (!(pending?.active ?? this.loggedActive(agent.session))) {
          throw new Error(`${EXIT_PLAN_MODE} is only available in plan mode`)
        }
        if (this.rejectionHold) {
          const held = this.heldTurns.get(agent.session)
          if (held !== undefined) {
            // The hold is turn-scoped: a later turn (cron wake, resumed
            // session) lifts it even without an intervening user message.
            const open = this.openTurnStartSeq(agent.session)
            if (open !== null && open === held) {
              throw new Error(`${EXIT_PLAN_MODE} is held for the rest of this turn: the user kept planning earlier in this turn. `
                + 'Finish replying in text and end your turn; their next message lifts the hold — typed, or their answer to a question card.')
            }
            this.heldTurns.delete(agent.session)
          }
        }
        if (!/^#\s+\S/.test(args.plan.trim())) {
          throw new Error(`${EXIT_PLAN_MODE} requires a non-empty markdown plan starting with a # heading`)
        }
        const details = normalizeDetails(args.details)
        if (details === undefined) {
          const embedded = embeddedDetailsHeading(args.plan)
          if (embedded !== undefined) {
            throw new Error(`exit_plan_mode: the "${embedded}" section inlined in the plan belongs in the details argument. `
              + 'Move that section\'s content into details (the plan keeps the plain-language layer only) and call again.')
          }
        }
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) {
          throw new Error('no user-questions channel is available to review the plan; ask the user to switch the session mode instead')
        }
        const answer = await interaction.ask({
          questions: [{
            id: REVIEW_ID,
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            // Generic consumers read the complete plan; `intent.layers` carries
            // the plain/annex split for capable UIs.
            detail: details === undefined ? args.plan : `${args.plan}\n\n${details}`,
            options: [
              { label: APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: KEEP_PLANNING_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
            // Presentation only: a capable UI renders the plan as a review
            // decision instead of a generic question, and answers with one of
            // the labels above either way.
            intent: {
              kind: 'plan-review',
              approve: APPROVE_LABEL,
              ...details === undefined ? {} : { layers: { plain: args.plan, details } },
            },
          }],
          agent,
          signal: exec.signal,
        }).catch((cause: unknown) => {
          // A dismissed review is not a failed one: the user took the turn back
          // to say something the two options do not cover. Say so, because the
          // generic channel message names ask_user_question, which the model
          // never called. An abort (turn cancel, provider teardown) keeps its
          // own message — there is no user to wait for.
          if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
            throw new Error('The user dismissed the plan review to speak instead; '
              + 'stay in plan mode, stop here, and wait for their message.')
          }
          throw cause
        })
        // A review may outlive this plugin fiber. Without its pre-step listener,
        // an approved selection could never be appended, so fail and keep planning.
        if (disposed) {
          throw new Error('the plan-mode service was reloaded while the plan was under review; present the plan again')
        }
        const reviewItems = answer.answers.filter(entry => entry.id === REVIEW_ID)
        const item = reviewItems.length === 1 ? reviewItems[0] : undefined
        if (item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined) {
          const feedback = item?.custom ?? ''
          if (this.rejectionHold) {
            // A review always settles inside an open turn in practice; with no
            // open turn there is no same-turn re-presentation to hold.
            const open = this.openTurnStartSeq(agent.session)
            if (open !== null) this.heldTurns.set(agent.session, open)
            throw new Error(feedback === ''
              ? 'The user chose to keep planning without further feedback.\n'
                + `${EXIT_PLAN_MODE} is held for the rest of this turn — ask what to change and end your turn. `
                + 'Present the updated plan after the user asks for it; a typed message or an answered question card lifts the hold.'
              : `The user chose to keep planning; their feedback: ${feedback}\n`
                + `${EXIT_PLAN_MODE} is held for the rest of this turn — respond to the feedback in your reply text and end your turn. `
                + 'Present the updated plan after the user asks for it; a typed message or an answered question card lifts the hold.')
          }
          throw new Error(feedback === ''
            ? 'The user chose to keep planning; revise the plan and present it again.'
            : `The user chose to keep planning; their feedback: ${feedback}`)
        }
        // Keep plan guidance for the rest of this assistant tool batch. The
        // silent selection is appended at the next accepted in-turn pre-step,
        // before its request assembly.
        this.pendingIntents.set(agent.session, { active: false, narrate: false })
        return { approved: true }
      },
      presentCall: (args) => {
        const details = normalizeDetails(args.details)
        return {
          card: 'generic',
          title: firstHeading(args.plan) ?? 'Plan',
          kind: 'other',
          content: details === undefined
            ? [{ type: 'text', text: args.plan }]
            : [{ type: 'text', text: args.plan }, { type: 'text', text: details }],
        }
      },
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'Plan review',
        content: result.content,
      }),
    }))
  }

  private loggedActive(session: Session): boolean {
    return this.planState(session).active
  }

  private hasOpenTurn(session: Session): boolean {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined) throw new Error('plan-mode requires the turnBoundary session projection')
    return state.openTurnStartSeq !== null
  }

  /** The open turn's start seq, or null between turns; fail-loud on a missing projection. */
  private openTurnStartSeq(session: Session): number | null {
    const state = this.ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (state === undefined) throw new Error('plan-mode requires the turnBoundary session projection')
    return state.openTurnStartSeq
  }

  private loggedActiveAtLastHeader(session: Session): boolean | undefined {
    return this.planState(session).activeAtLastHeader ?? undefined
  }

  /** Read the required plan projection state or fail at the first service access. */
  private planState(session: Session): PlanUnitState {
    const state = this.ctx.sessionProjections.stateOf(session, 'plan')
    if (state === undefined) throw new Error('plan-mode requires the plan session projection')
    return state
  }

  /**
   * Read the logged plan state and any selected state awaiting the next
   * accepted in-turn pre-step.
   *
   * @param agent The agent to read.
   * @returns Current logged state plus a pending selection, when present.
   */
  get(agent: Agent): { active: boolean; pending?: boolean } {
    const active = this.loggedActive(agent.session)
    const pending = this.pendingIntents.get(agent.session)
    return pending === undefined ? { active } : { active, pending: pending.active }
  }

  /**
   * Select whether plan mode should be active. Between turns the method
   * appends the change immediately because no in-turn pre-step will run until
   * another prompt starts a turn. The open-turn fold is the idle signal:
   * agent status stays `running` through post-turn checkpointing, when no
   * further in-turn pre-step runs. During an open turn the selection remains
   * pending until the next accepted in-turn pre-step. Repeated selection of
   * the current or already-pending state is a no-op.
   *
   * @param agent The agent to switch.
   * @param active Whether plan mode should be active.
   * @returns what happened: `committed` (logged now), `queued` (awaiting the
   * next accepted in-turn pre-step), `cancelled` (an opposite pending selection
   * was cleared; the logged state already matches), or `noop` (already in that
   * state).
   */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    const session = agent.session
    const pending = this.pendingIntents.get(session)
    const target = pending?.active ?? this.loggedActive(session)
    if (active === target) return 'noop'
    if (this.hasOpenTurn(session)) {
      this.pendingIntents.set(session, { active, narrate: true })
      return this.loggedActive(session) === active ? 'cancelled' : 'queued'
    }
    // No open turn: commit now. Delete only after append succeeds so a
    // failed durable write leaves the selection retryable, not dropped.
    if (active === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return 'cancelled'
    }
    session.append('plan/mode', { active })
    this.pendingIntents.delete(session)
    const narration = this.narration(session, active)
    if (narration !== undefined) agent.inject(narration)
    return 'committed'
  }

  /** Append one pending selection before the next request assembly. */
  private onBoundary(session: Session): void {
    const pending = this.pendingIntents.get(session)
    if (pending === undefined) return
    const target = pending.active
    if (target === this.loggedActive(session)) {
      this.pendingIntents.delete(session)
      return
    }
    session.append('plan/mode', { active: target })
    // Delete only after append succeeds so a later accepted in-turn pre-step
    // can retry a failed durable write.
    this.pendingIntents.delete(session)
  }

  /** Build a user-switch notice when the last logged header described the other mode. */
  private narration(session: Session, target: boolean): UserMessage | undefined {
    const told = this.loggedActiveAtLastHeader(session)
    if (told === undefined || told === target) return
    const text = target
      ? 'The user switched this session to plan mode.'
      : 'The user switched this session back to the default mode.'
    return createUserMessage({
      content: [{ type: 'text', text }],
      // The narration is already one sentence, so it is its own summary.
      source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice', summary: text },
    })
  }
}

export default PlanModeController
