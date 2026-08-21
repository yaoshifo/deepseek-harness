/**
 * allow_from allowlist check ported from cc-connect core/message.go
 * (AllowList): '*' or empty permits everyone; a comma-separated list is
 * matched case-insensitively.
 *
 * @module dsh-feishu-bridge/feishu-allowlist
 */

/**
 * Whether userID is permitted by the comma-separated allowFrom string.
 * @param allowFrom - Raw allow_from value: '*' or empty permits everyone; otherwise a comma-separated ID list.
 * @param userID - Sender open ID to check.
 * @returns True when the sender is permitted.
 */
export function AllowList(allowFrom: string, userID: string): boolean {
  const trimmed = allowFrom.trim()
  if (trimmed === '' || trimmed === '*') return true
  for (const id of trimmed.split(',')) {
    if (id.trim().toLowerCase() === userID.toLowerCase()) return true
  }
  return false
}
