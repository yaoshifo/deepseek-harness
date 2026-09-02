# Agent Note: Feishu card line caps count with the renderer's line endings

Status: implemented

English | [中文](2026-09-02-feishu-bridge-card-line-counts-renderer-rule.zh.md)

## Problem

The streaming progress card fixes each tool entry's code-block height by counting lines — `padToFixedLines` in `packages/acp/feishu-bridge/src/streaming.ts` (1 input line + `---` + 3 result lines) and `padProgressLines` in `src/feishu/progress.ts` (6 lines on the payload path, plus a 120-char per-line cap). All of them counted with `split('\n')`, but Feishu schema 2.0 card markdown follows CommonMark line endings: a lone `\r` also breaks a line. Tool output carrying `\r`-separated progress updates (git worktree/checkout through `2>&1 | tail -N`, curl, npm progress) packs dozens of rendered lines into one `\n`-line: the caps saw "3 lines", passed ~1.6 KB of raw `\r` text through every sanitization stage (all `\n`-based), and the renderer exploded it into 38 visual lines — the card height blew past its window.

## Decision

Line counting now uses the renderer's rule, and line width is capped with it. `src/feishu/markdown.ts` owns both geometry rules beside the other schema 2.0 line-break normalization: `splitCardLines` splits on `/\r\n|\r|\n/`, and `capProgressLineChars` caps one line at `maxProgressLineChars` (120 code points plus `...`, moved there from `feishu/progress.ts` so both card paths share it). `padToFixedLines` and `truncateToMaxLines` (streaming.ts) count and rejoin through `splitCardLines`; `padToFixedLines` and `padProgressLines` (feishu/progress.ts) additionally cap every line. Card text never carries a raw `\r`, no line wraps past the code-block width, and every fixed-height window truncates with an honest `... (N more lines)` marker. The rules live in the line-fixing functions, not at tool-result ingress: `ProgressEntry.result` feeds only `render()`, and fixing at the counting seam covers every ingress at once — streaming updates, payload cards, offline replay.

## Alternatives considered

**Normalize `\r` in `updateToolResult`.** Rejected as the sole fix: it covers the streaming card but leaves the payload path (`formatProgressToolResult`) counting `\n`-lines, where the 120-char cap keeps mid-line-cutting `\r` progress into garbage.

**Normalize in the card pipeline (`buildPreviewCardJSON`).** Rejected: by then `padToFixedLines` has already decided the text fits; normalizing after counting re-inflates the rendered height past the window.

## Consequences

Tool results with `\r` progress render as an honest truncation (first lines + overflow marker) on both card paths, and an over-long single `\n`-line (a one-line JSON result) caps at 120 code points instead of wrapping the streaming card's window tall; output with no `\r` and no long line is byte-identical to before. Raw tool output still reaches the model and exports unchanged.

## Testing

`tests/streaming.spec.ts`: the git-worktree `updateToolResult` case (36 `\r`-separated updates through `tail -3`) and the `line fixing counts lines with the renderer rule` describe (line-ending counting plus the per-line wrap cap). `tests/feishu/progress.spec.ts`: `formatProgressToolResult renderer line counting`.
