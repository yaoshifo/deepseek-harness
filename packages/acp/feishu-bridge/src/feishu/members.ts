/**
 * Chat member listing and addition, ported from cc-connect
 * platform/feishu/feishu_members.go: the member lister keeps the last attempt's
 * partial page on failure (a dispatch member-copy must not silently zero out),
 * and AddChatMembers batches at Feishu's 50-user per-call cap, best-effort per
 * batch.
 *
 * @module dsh-feishu-bridge/feishu-members
 */

import { extractFeishuChatID } from './spawn.ts'

export { extractFeishuChatID as chatIDFromSessionKey }

/** Per-request cap on AddChatMembers (Feishu limits each call to 50 users). */
export const chatMembersAddBatch = 50

/**
 * Drop empty ids, the bot's own id, and duplicates, preserving first-seen
 * order.
 * @param ids - Candidate open_ids.
 * @param botID - The bot's own open_id.
 * @returns Deduplicated ids.
 */
export function dedupMemberIDs(ids: string[] | undefined, botID: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids ?? []) {
    if (id === '' || id === botID) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
