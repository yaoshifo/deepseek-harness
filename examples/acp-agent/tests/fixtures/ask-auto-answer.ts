import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-user-questions'

/** Snapshot-only provider that answers every question deterministically. */
export const name = 'ask-auto-answer'

/** User-interaction service required by the auto-answer provider. */
export const inject = ['userQuestions']

/** Register a provider that selects the first option of every question. */
export function apply(ctx: Context): void {
  ctx.userQuestions.registerProvider({
    async ask(request) {
      return {
        answers: request.questions.map(question => ({
          id: question.id,
          selected: question.options !== undefined && question.options.length > 0
            ? [question.options[0]!.label]
            : [],
        })),
      }
    },
  })
}
