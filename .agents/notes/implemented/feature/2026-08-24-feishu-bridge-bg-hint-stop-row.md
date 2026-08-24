# Agent Note: feishu-bridge background-task hint rides the stop-button row

Status: implemented

English | [中文](2026-08-24-feishu-bridge-bg-hint-stop-row.zh.md)

## Problem

The background-task hint (`bg_task_running`, wired by the [unsolicited reader](2026-08-24-feishu-bridge-unsolicited-reader.md)) rendered as the last line of the progress-card body — always one line above the ⏹ 停止执行 button row injected per PATCH. It spent a full vertical line on a short status string and split two pieces of live turn state (background count, stop control) across two rows.

## Decision

On running (non-terminal) cards the hint leaves the body and renders inside the stop-button row; the copy is shortened to `💡 %d 个后台任务`:

- `TextPreviewContent` (`src/core/types.ts`) gains an optional `bgTaskHint` field. `StreamPreview.progressContentLocked` attaches it, and `flushLocked`'s content re-wrap preserves it — the re-wrap rebuilds `{kind, text, status}` and would otherwise drop the field.
- `buildProgressDisplayLocked` appends the hint line to the body only on terminal renders (`completed`/`failed`); running cards carry the hint solely as the structured field.
- `injectStopButton(cardJSON, sessionKey, hint)` appends a grey notation column after the danger button when the hint is non-empty. `sendPreviewStart` / `updateMessage` pass the field through; the column shape is the `notationColumn` helper shared with `injectReplyButtons`' render-status line.

The placement is deliberately asymmetric across card states. Terminal (green/red) cards keep the hint as a body line under the answer: the stop-button row disappears when the card greens, and the body line preserves the information without caching the hint for the `updateRenderStatus` / `markCardStopped` rebuild paths. The user-stopped card (⏹ 已停止 + ▶ 继续执行) does not re-inject the hint — it rebuilds from the last pre-button running render, where the hint lived in the (now dropped) button row.

## Alternatives considered

**Rendering the hint in a button row on every card state, the green reply row included.** Would keep the position constant but requires per-messageID hint caching for the green-card rebuild and stopped-card re-injection — plumbing disproportionate to the informational value, since the terminal body line already exists.

**Shortening the copy but keeping it in the body.** The complaint was the layout; a shorter string still occupies its own line above the button.

## Consequences

Running cards show `⏹ 停止执行 | 💡 N 个后台任务` on one row; terminal cards render as before except the shortened copy. Costs: the user-stopped card no longer shows the hint (accepted — the stop itself is the stronger signal, and the count clears with the completion turn), and the hint visibly moves (button row → body line) when a card greens.

## Testing

`tests/feishu/progress.spec.ts` — hint column beside the button, single-column row without a hint, terminal no-op with a hint. `tests/streaming.spec.ts` — the content field carries and clears the hint; the completed card keeps the body line. `tests/feishu/preview-send.spec.ts` — platform-level create/PATCH render beside `cmd:/stop`. Full feishu-bridge suite: 2279 passing.
