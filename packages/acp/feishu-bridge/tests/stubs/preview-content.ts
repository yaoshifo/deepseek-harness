import type { ProgressContent, ProgressStatus } from '../../src/core/types.ts'

/**
 * Render recorded preview content to a string so assertions stay text-based:
 * text content passes through verbatim, card content serializes its payload.
 *
 * @param content - Preview content recorded from a platform call.
 * @returns The text body, or the serialized payload for card content.
 */
export function previewText(content: ProgressContent): string {
  return content.kind === 'card' ? JSON.stringify(content.payload) : content.text
}

/**
 * Structured status of recorded preview content, if any.
 *
 * @param content - Preview content recorded from a platform call.
 * @returns The text path's status, or undefined for card content.
 */
export function statusOf(content: ProgressContent): ProgressStatus | undefined {
  return content.kind === 'text' ? content.status : undefined
}
