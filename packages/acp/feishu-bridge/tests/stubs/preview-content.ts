import type { ProgressContent } from '../../src/core/types.js'

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
