# Agent Note: feishu-bridge /stop success is silent — the stopped card is the feedback

Status: implemented

English | [中文](2026-08-21-feishu-bridge-stop-silent.zh.md)

## Problem

Stopping a running turn sent two confirmations. The progress card's ⏹ 停止执行 button (`cmd:/stop`, synthesized into a plain `/stop` message by the `cmd:` dispatch branch) and a hand-typed `/stop` both reached the session command handler, which replied with the text "⏹ 执行已停止。" (`execution_stopped`). Meanwhile `cmdStop` → `stopInteractiveSession` → `markStopped` already PATCHes the same card to the red ⏹ 已停止 header with the ▶ 继续执行 footer, so the text message duplicated what the card header showed a moment later.

## Decision

The stop handler replies only when there was nothing to stop (`no_execution`); a successful stop is silent regardless of origin (card button or typed command). The stopped-card PATCH is the success feedback.

The `execution_stopped` i18n key and translations stay in `keys.ts`/`messages.ts` even though no code consumes them now: both files are 1:1 ports of the Go cc-connect i18n table with a stated regeneration contract ("regenerate against that file when it changes"), and deleting one entry would silently fork the table — the next regeneration would resurrect it.

Known trade-off, accepted by product decision: with `useInteractiveCard` disabled there is no stopped card, so a successful hand-typed `/stop` gives no feedback at all. If that mode ever matters, the origin flag approach (mark `cmd:`-synthesized messages and silence only those) is the upgrade path.

## Alternatives considered

**Silencing only card-button stops (per-origin flag on `Message`).** Needed a new `isCardCommand` field threaded through `dispatch()` just to keep the text reply for typed `/stop`. Rejected when the product decision extended silence to typed `/stop` too — the flag then has no consumer.

**Removing the i18n key with the behavior.** Diverges the generated 1:1 Go table; see Decision.

## Consequences

One fewer message per stop in card mode. Stale-card clicks (nothing running) still get the "没有正在执行的任务" text. All other `cmd:` buttons are unaffected — only the stop handler changed.

## Testing

`tests/engine/commands.spec.ts`: a new handler-level test drives `dispatchCommand('/stop')` both ways — with an active interactive state it must leave `p.sent` empty, without one it must reply `no_execution`. The existing blocked-close test dropped its manual replica of the old reply and now asserts no message reaches the platform. Full package suite 1948 green; repo typecheck green.
