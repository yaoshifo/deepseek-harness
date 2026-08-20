# Agent Note: feishu-bridge permission-card click feedback and plan-before-approval ordering

Status: implemented

English | [中文](2026-08-20-feishu-bridge-permission-card-update-and-order.zh.md)

## Problem

Two user-visible defects on the `‼️ 权限请求` approval card, both Go-cc-connect behaviors lost in the TS port. First, clicking Allow/Deny/Allow-All left the card untouched: Go's `onCardAction` perm branch (`platform/feishu/feishu_dispatch.go`) returns a `CardActionTriggerResponse` carrying a replacement card — title flips to `✅ 已允许` / `❌ 已拒绝` / `✅ 已全部允许` — and Feishu swaps the card from the callback response. The TS port rendered the button `extra` fields (`perm_label`/`perm_color`/`perm_body`) into the button value map and wrote `permBodyCache`, but never read either, so the callback response was empty. Second, the approval card sometimes arrived before the plan card: Go's `sendPlanCard` and `sendPermissionPrompt` are synchronous blocking calls, so plan → approval order is structural; the TS port fire-and-forget both sends, and two concurrent Feishu HTTP calls race by server receive time — the small approval card regularly beats the large plan card.

## Decision

The perm branch of `onCardAction` builds the resolved card exactly as Go does — extras from `action.value` when present, otherwise fixed fallback labels (`✅ 已允许` green / `❌ 已拒绝` red / `✅ 已全部允许` green), deny reason quoted as the body, remaining body from `permBodyCache` (read-then-delete), color defaulting to green — and returns it as `{ card: { type: 'raw', data: renderCardMap(...) } }`. The card travels back over the WS long connection: the node-sdk `WSClient` base64-encodes the `EventDispatcher` handler's return value into the callback response payload (`es/index.js` `handleEventData`), the same mechanism the Go oapi-sdk-go uses. To let the value flow, `wsEventRegistrations` and the `wsStart` raw-event callback now propagate handler return values; the other routed events keep returning `undefined`, so their responses stay empty as before. For ordering, `sendPlanCard` returns the send promise (handle recording stays in `.then`), `sendPlanContent`/`sendInlinePlanContent` await it, and the `permission_request` branch awaits the plan card send before `await sendPermissionPrompt(...)` — restoring Go's synchronous send order before the loop parks on the user's answer.

## Alternatives considered

**PATCHing the pressed card instead of a callback response.** The `act:`/`nav:` branches already use the `refreshCard`/`cardActionMsgIDs` PATCH pattern, so this was the in-house precedent. Rejected as primary path: PATCH is a second network round trip and races the user's next view; the callback response is atomic and is exactly what Go does. If the WS callback response ever proves unreliable on real hardware, the PATCH pattern is the documented fallback.

**Serializing all sends through the per-session AsyncSender.** Would fix ordering globally, but the AsyncSender exists for preview PATCH coalescing, not chat ordering; routing every card send through it changes latency characteristics far beyond the reported defect.

**i18n keys for the three fallback labels.** Go hardcodes the Chinese labels at the platform layer, and the platform's dispatch paths already hardcode user-facing Chinese (`export:` failure notices). Adding an i18n dependency to the platform layer for three strings was scope expansion; parity literals won.

## Consequences

Click feedback is instant and atomic — the card the user pressed becomes the outcome state with no extra message. `permBodyCache` entries are now consumed (read-then-delete) on the fallback path, and remain overwritten on the next permission card otherwise, matching Go's `LoadAndDelete`-when-empty semantics. The plan card send now blocks the event loop until Feishu accepts it (or the fallback plain send completes); a slow plan-card send delays the approval card by one RTT — the same trade Go makes. Both fixes need the real-machine smoke test (reload.sh + trigger a plan-mode turn) before M8 cutover; the WS callback response path has never been exercised by this port before.

## Testing

`tests/feishu/card-action.spec.ts` (perm branch: extras path, form_submit fallback + cache consumption, deny reason as quoted body, allow_all label, no card response for non-perm actions) and `tests/feishu/ws-registrations.spec.ts` (return-value propagation). `tests/engine/engine-m3-plan.spec.ts` `PlanCardBeforePermissionCard` gates the plan-card send and asserts the permission card does not start until the gate opens — the red run reproduced the reported inversion exactly. Full package suite 1883 green; `tsc --noEmit` and `verify-export-jsdoc` clean.
