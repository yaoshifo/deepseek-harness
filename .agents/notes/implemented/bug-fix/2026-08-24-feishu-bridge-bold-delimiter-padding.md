# Agent Note: Feishu card markdown pads glued bold delimiters before rendering

Status: implemented

English | [中文](2026-08-24-feishu-bridge-bold-delimiter-padding.zh.md)

## Problem

Feishu card markdown (schema 2.0 rich-text component) renders `**bold**` only when the delimiters keep whitespace on both sides — the platform docs state "若加粗效果未显示，请确保加粗语法前后保留一个空格". Agent replies routinely emit the CommonMark-legal form `**……上。**mico 服务器……`, where the closing `**` is glued to the next character; Feishu refuses the pair and the raw `**` shows on the card (group oc_5dd09d0ef27a0ddc0ff07e0916c75bd4, 2026-08-24). An offline replay of the stored reply through `buildPreviewCardJSON` proved the bridge pipeline passed the markers through verbatim — the defect was the platform parser, not text corruption on our side.

## Decision

`padBoldDelimiters` (`src/feishu/markdown.ts`) inserts one space on each glued side of a matched `**…**` / `__…__` pair, following the platform's own remedy. It runs line-wise, skips fenced code blocks and masks inline code spans so code content is never altered, and its lookarounds leave 3+ delimiter runs (`***x***`, the form the docs call out as unreliable) untouched. The step is wired into both card-markdown assembly points: `finalizeFeishuCardMarkdown` (standalone reply cards and every structured-card `{kind:'markdown'}` projection) and the `buildPreviewCardJSON` text path (streaming preview and completed/stopped cards — the surface the bug was observed on). Tool progress entries stay unpadded: their text renders inside code blocks. The export button delivers the original reply file, which never passes through this pipeline.

## Alternatives considered

**Rewrite glued pairs as `<b>…</b>` (already on the tag whitelist).** Rejected as the first move: no visible text change, but every rewritten pair must stay balanced or the card fails to send with API error 11311, and nested inline formatting inside the tags needs its own escaping story. Padding is the platform-documented remedy with no failure mode.

**Ask the model to emit spaced bold.** Rejected: prompt-level conventions do not survive every model and every language; the renderer is the only chokepoint all replies cross.

## Consequences

Glued bold pairs gain a half-width space on the glued side (e.g. `……。** mico`), a minor CJK typography change that is the cost of the pair rendering at all. If live verification later shows Feishu still refuses some padded form, the `<b>` rewrite remains the fallback behind the same `padBoldDelimiters` seam. Runs of 3+ delimiters and code content keep today's behavior.

## Testing

`tests/feishu/markdown.spec.ts` (`padBoldDelimiters`): table-driven cases for closing glued to a letter / CJK / fullwidth punctuation, opening glued, both sides, already-spaced and line-boundary pairs unchanged, code fence and inline code untouched, 3-/4-star runs untouched, underscore variant, unpaired delimiters; plus the bug-repro sentence and a `finalizeFeishuCardMarkdown` pipeline assertion. `tests/feishu/card.spec.ts` (`buildPreviewCardJSON` pads bold delimiters): the real reply first sentence replayed through the preview-card pipeline. Offline replay of the full stored mico reply reports zero glued pairs remaining.
