# Agent Note: Remove the bridge-level compress path

Status: implemented

English | [中文](2026-09-16-remove-bridge-compress-path.zh.md)

## Problem

The bridge carried two compression surfaces: the `autoCompress` config (auto-compact when projected occupancy crosses a cap) and the manual `/compress` command. The dev server ran `autoCompress {maxTokens: 100k}` from the migration until 2026-09-07, when the estimator fix made the threshold measurable and 100k proved too aggressive for 1M windows — the config was removed by ruling and the defense unified on the core layer (`compaction-basic`, auto on at 0.8); the Mac never configured it. `/compress` has zero typed invocations in 21 days of session logs (2.4 GB, both bots).

## Decision

The bridge ships without its own compression path: the `autoCompress` config keys and wiring, the turn-end trigger, `/compress` and its `compact` alias, `runCompress`, the `SessionCompressor` capability and its adapter `compress()` (the bridge's only `compactNow` caller), `projectedContextTokens` (the trigger's occupancy read), and five i18n keys. A leftover `autoCompress` key fails at load with removal instructions (the progressStyle guard class). `compactionCount` stays: native `compaction` events from the agent session remain its writer and feed the status footer's "N zip" segment.

## Alternatives considered

**Keep `/compress` as a manual escape hatch.** Zero usage in three weeks of logs; the core layer owns compaction.

**Keep `autoCompress` for deployments without the core layer.** Both deployments run `compaction-basic`; carrying a second, once-miscalibrated trigger for a hypothetical deployment is the speculative-generality cost this removal pays down.

## Consequences

Core-layer compaction is the only context-pressure defense; a deployment that removes it loses automatic compression entirely. Context pressure remains observable through the `/context` card's projection headline, which reads the same token-meter source the trigger used.
