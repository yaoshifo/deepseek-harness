# Agent Note: feishu-bridge card-action form values — wire key is `form_value`

Status: implemented

English | [中文](2026-08-20-feishu-bridge-card-action-form-value-key.zh.md)

## Problem

A user submitted an AskUserQuestion multi-select card (34 unported commands) and the agent received only the bare protocol string `askq:0` — the checked options were gone, so the answer carried no selection. The same silent loss affected two untested paths: the permission card's deny reason (`deny_reason`) and hint-button input-field values (`hint_arg_*`), both of which also come back on form submits.

The ported `CardActionTriggerEvent` type declared the callback's form payload as `action.formValue` (camelCase), and every read site used that key. Feishu's wire payload uses snake_case `form_value` inside `action`; the node-sdk's `EventDispatcher.invoke` → `RequestHandle.parse` path unwraps the v2 envelope's `event` object and passes keys through unmodified, so `action.formValue` was `undefined` at runtime, `collectAskqMultiSelected(undefined)` returned an empty list, and the dispatched answer was the question index alone. The earlier fix that introduced collection (4e484936ab, "multi submit collects form indices") looked correct in tests because the test payloads mirrored the same wrong key.

The confusing part of the incident report: the on-call agent in the affected group diagnosed "the daemon hasn't been reloaded, the fix is only in the repo." That was wrong on mechanism — commit 4e484936ab landed 2026-08-19 22:47 and the daemon restarted 2026-08-20 18:02 with a fresh build, so the fix was live and still lost the selections. The daemon reload that was genuinely pending covered two later commits (in-place card swap, frozen answer cards), which the report conflated with this one.

## Decision

Rename the field to the wire key and read only that: `CardActionTriggerEvent.action.form_value` (`Record<string, unknown>`), with the four read sites updated — the perm deny-reason reads (dispatch content and fallback card body), `collectAskqMultiSelected(action.form_value)`, and the `cmd:` hint input lookup. The interface JSDoc now states what was actually verified how: root nesting confirmed against live payloads, the `form_value` key name confirmed against the Go oapi-sdk-go card event struct's json tag (`card/model.go`: `FormValue map[string]interface{} \`json:"form_value"\``) — the production Go bridge has always read it through that tag. The prior "confirmed against live payloads" comment overstated what had been verified and helped the wrong key survive review.

The multi-select test that should have caught this asserted only `isAskqCardAction`, which stays true with an empty selection; it now asserts the dispatched content carries the collected indices (`askq:0:2,10`).

## Alternatives considered

**Accepting both keys (`formValue ?? form_value`).** Tolerated the wrong key forever and left the type lying about the wire format; the SDK passes wire keys through verbatim, so there is exactly one correct name.

**Verifying against a live payload before fixing.** The running daemon logs nothing about raw card-action payloads, and adding logging would itself require the reload we were trying to avoid. The Go SDK json tag plus the production Go bridge working on the same cards is authoritative; the real-machine smoke test after reload is the final confirmation.

## Consequences

Multi-select answers reach the engine with their checked indices, deny reasons and hint input values survive the callback, and the frozen confirm card (which marks the checked subset) now has real indices to mark. No wire-format ambiguity remains in the type. Engine-side note for a later decision: a multi-submit with zero collected indices currently dispatches the bare protocol string and the engine surfaced it to the model as a user message — whether an empty submission should instead prompt "no option selected" is an engine-policy question, out of scope here.

## Testing

`tests/feishu/card-action.spec.ts` payloads switched from `formValue` to `form_value`: the red run failed exactly the live symptom (6 failures — deny reason body lost, hint args lost, frozen cards with no ✅ marks, indices missing from the dispatched content), and the multi-select index test now asserts `content === 'askq:0:2,10'`. Full package suite 1930 green after the fix.
