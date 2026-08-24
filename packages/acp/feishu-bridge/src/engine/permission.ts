/**
 * Permission keyword matching (the card-less platform fallback) and the
 * unsolicited-permission surfacing rules. The Go-era answer resolution and
 * deny-message builders moved with B2: ask payloads parse through
 * engine/ask.ts's converged parser, and deny notes ride the native
 * ApprovalAnswer (the tools layer folds them into the rejection text).
 *
 * @module dsh-feishu-bridge/engine/permission
 */

/**
 * Lowercase trimmed string matches an "allow" keyword (Go isAllowResponse).
 * @param s - Lowercase trimmed user input.
 * @returns True when the input is an "allow" keyword.
 */
export function isAllowResponse(s: string): boolean {
  const words = ['allow', 'yes', 'y', 'ok', '允许', '同意', '可以', '好', '好的', '是', '确认', 'approve']
  return words.includes(s)
}

/**
 * Lowercase trimmed string matches a "deny" keyword (Go isDenyResponse).
 * @param s - Lowercase trimmed user input.
 * @returns True when the input is a "deny" keyword.
 */
export function isDenyResponse(s: string): boolean {
  const words = ['deny', 'no', 'n', 'reject', '拒绝', '不允许', '不行', '不', '否', '取消', 'cancel']
  return words.includes(s)
}

/**
 * Lowercase trimmed string matches an "allow all" keyword (Go isApproveAllResponse).
 * @param s - Lowercase trimmed user input.
 * @returns True when the input is an "allow all" keyword.
 */
export function isApproveAllResponse(s: string): boolean {
  const words = [
    'allow all', 'allowall', 'approve all', 'yes all',
    '允许所有', '允许全部', '全部允许', '所有允许', '都允许', '全部同意',
  ]
  return words.includes(s)
}

/**
 * Whether an unsolicited (background-reader) permission request should
 * surface to the user instead of being auto-denied (Go
 * shouldSurfaceUnsolicitedPermission). Auto-approve never surfaces;
 * AskUserQuestion and stall-retried turns always surface.
 *
 * @param _toolName - Unused in the ported rules (kept for Go parity).
 * @param isAskQuestion - Whether the request is an AskUserQuestion call.
 * @param stallRetried - Whether the turn already retried after a stall.
 * @param autoApprove - Whether auto-approve is enabled for the chat.
 * @returns True when the request should surface to the user.
 */
export function shouldSurfaceUnsolicitedPermission(
  _toolName: string,
  isAskQuestion: boolean,
  stallRetried: boolean,
  autoApprove: boolean,
): boolean {
  if (autoApprove) return false
  return isAskQuestion || stallRetried
}
