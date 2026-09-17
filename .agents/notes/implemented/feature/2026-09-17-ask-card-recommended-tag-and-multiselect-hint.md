# Agent Note: Ask-card recommended tag and the multi-select hint

Status: implemented

English | [中文](2026-09-17-ask-card-recommended-tag-and-multiselect-hint.zh.md)

## Problem

Two model-behavior gaps surfaced by one live ask (session cc-20260917-090512, chat oc_1c55, 2026-09-17; the session log's `tool/call` row is the evidence):

1. The question text said multiple selections were allowed (「想真正把采集节奏拉到 10 秒级，你要哪条？（可多选，比如并发化 + 缩小范围一起）」), but the call carried no `multi_select` (neither key spelling; the question's keys were only `header`/`id`/`options`/`question`). Omitted defaults to false, so the card rendered single-select and the user could not pick two options on the card.
2. On that single-select card the only recommendation signal was the primary button highlight, so the model hand-wrote「（推荐）」into the recommended option's label to compensate — tagging depended entirely on model discretion.

## Decision

1. `tool-ask-user`'s `multi_select` field description now carries the guidance: when the question text tells the user multiple selections are allowed, set true, otherwise the card renders single-select. The `recommended` field description states the UI tags recommended options and forbids writing the marker into the label.
2. A single-select recommended option renders a double signal: the primary button (existing) plus a localized recommended suffix on its label (new `ask_recommended_suffix` entry, five locales). Multi-select cards and the followups card stay untagged — pre-checking is already a complete action-level signal. Settled snapshots stay untagged: `settledOptionMarks` is shared with the dispatched selection message, and the wire-facing data must never carry the render-only tag.
3. Duplicate-tag guard: the suffix is appended only when the label carries none of the message table's standard forms anywhere, compared after `foldTagForm` folding — lowercase, every bracket glyph (full/half-width, square, lenticular) to its ASCII pair, all whitespace removed — so half-width, bracketed, cased, and spaced variants all compare equal. The detection set derives from `messages.ask_recommended_suffix` itself — a single source of truth; a registered subtable cannot override a main-table key, so the static derivation can never drift from the rendered value. Both failure modes fall on the safe side: a miss leaves the item without the text signal (highlight remains), never a doubled tag.
4. `extra.askq_label` and answer `selected` always keep the raw label — the model-read data plane stays untagged.

## Alternatives considered

- **Guidance-only (no render change): tell the model to write the marker itself.** Rejected: it demotes the structured `recommended` field back to a free-text convention — the exact discretion this fixes — and a model-authored marker flows into the wire-facing label and answers.
- **`endsWith` for the duplicate guard.** Rejected: a mid-label marker (compound option 「X（推荐）+ Y」) slips through and double-tags; `includes` covers it and its misses stay cosmetic.
- **Bare「推荐」in the detection set.** Rejected: an option labeled 「不推荐」 contains the substring and would be misread as already tagged.

## Consequences

Bought: a single-select recommended option carries a deterministic highlight-plus-tag signal instead of relying on the model to hand-write one, and the「可多选」text-vs-card mismatch now has a contract-level nudge at the exact field the model omits. Cost: recommended labels render a few characters longer (narrow cards may wrap the row), the tool description grows by ~50 tokens per session, and the duplicate guard recognizes only bracketed marker forms (compared after folding case, spacing, and bracket glyphs) — a bare marker word without brackets (「推荐：X」, an option named 「不推荐」) or a markdown-emphasized marker still double-tags on display (the data plane stays raw either way).
