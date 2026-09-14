import type { ProgressContent, ProgressStatus } from '../../src/core/types.ts'

/**
 * Render recorded preview content to a string so assertions stay text-based.
 *
 * @param content - Preview content recorded from a platform call.
 * @returns The display body.
 */
export function previewText(content: ProgressContent): string {
  return content.text
}

/**
 * Structured status of recorded preview content, if any.
 *
 * @param content - Preview content recorded from a platform call.
 * @returns The status, or undefined when the content carries none.
 */
export function statusOf(content: ProgressContent): ProgressStatus | undefined {
  return content.status
}
