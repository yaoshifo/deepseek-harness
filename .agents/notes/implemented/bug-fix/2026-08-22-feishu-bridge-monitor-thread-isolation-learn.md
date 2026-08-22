# Agent Note: feishu-bridge monitor-chat `/learn` quoting skipped under thread isolation

Status: implemented

English | [中文](2026-08-22-feishu-bridge-monitor-thread-isolation-learn.zh.md)

## Problem

With `threadIsolation: true` (the production profile enables it for every project), `makeSessionKey` derives a `root:`/`thread:` session key for every group message — when `root_id`/`thread_id` are absent it falls back to the message's own id — so `isThreadSessionKey` is always true in group chats. Two behaviors keyed on that predicate then misfired for monitored chats:

- `dispatchWithQuote` skipped `fetchQuotedMessage`, so a quoted message in the monitored group never populated `extraContent`, and `/learn` always answered "⚠️ 请引用一条消息再发 /learn" even when the user had quoted one.
- `shouldReplyInThread` made every monitor ack (including that error) go out with `reply_in_thread: true`, opening a new topic in the monitoring group on each reply.

The skip's rationale — "the thread already carries the context and a long prefix would drown the user's text" — presumes an interactive agent session; monitored chats never run one, and the quote is `/learn`'s data, not session context. The condition matches the retired Go original verbatim (`platform/feishu/feishu_dispatch.go` dispatch), so this is not a port regression: it fired only once the deployment enabled threadIsolation fleet-wide with a monitored group. Tests missed the combination: platform-quote cases all used `chat_type: 'p2p'`, and the isolated-thread case asserted only the no-parent branch.

## Decision

Monitored chats are exempt from both thread-isolation behaviors on the platform:

- The quote-fetch skip in `dispatchWithQuote` gains `&& !this.isMonitorChat(chatID)`.
- `shouldReplyInThread` returns false for monitored chats, so text and card acks reply inline — matching the polling path, which already replies inline because `pollItemToMessage` builds per-user session keys.

## Alternatives considered

**Deriving non-thread session keys for monitored chats in `makeSessionKey`.** Same visible outcome, but session keys also feed clarification-answer matching and the seen-set dedup; changing key derivation for monitor traffic has a wider blast radius than two localized predicate tweaks.

## Consequences

Quotes reach `/learn` in monitored groups under thread isolation, and monitor acks (🔍 spawn notices, completion cards, `/learn` acks) reply inline instead of opening topics. Non-monitored groups, spawned groups, p2p chats, and `threadIsolation`-off deployments behave unchanged. `/learn` still cannot quote poll-path-ingested messages (README Known Limitations).

## Testing

`platform-quote.spec.ts` gains four cases: a monitored group under threadIsolation fetches the quote (red before the fix), a non-monitored group still skips with zero `getMessage` calls, a monitored chat replies inline, and a non-monitored chat still threads. Package suite green (2080 tests), tsc/oxlint clean. Real-device smoke: quote + `/learn --ignore` in the monitored group → inline ✅ ack, example persisted to `monitor_examples.json`, no new topic.
