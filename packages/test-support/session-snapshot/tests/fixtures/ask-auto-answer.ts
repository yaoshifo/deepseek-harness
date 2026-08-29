import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-user-questions'

/** Snapshot-only answerer that answers every question deterministically. */
export const name = 'ask-auto-answer'

/** User-interaction service required by the auto-answer answerer. */
export const inject = ['userQuestions']

/** Register an answerer that selects the first option of every question. */
export function apply(ctx: Context): void {
  ctx.on('user-questions/request', async request => ({
    answers: request.questions.map(question => ({
      id: question.id,
      selected: question.options !== undefined && question.options.length > 0
        ? [question.options[0]!.label]
        : [],
    })),
  }))
}
