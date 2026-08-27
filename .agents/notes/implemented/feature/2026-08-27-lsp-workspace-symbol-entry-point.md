# Agent Note: LSP workspaceSymbol name-based entry point

Status: implemented

English | [中文](2026-08-27-lsp-workspace-symbol-entry-point.zh.md)

## Problem

The `lsp` tool shipped with four operations (`goToDefinition`/`findReferences`/`goToImplementation`/`hover`), all of which require `file_path` plus one-based UTF-16 `line`/`character` on the symbol. A model therefore cannot answer its most frequent navigation intent — "where is symbol X?" — in one call: it must first read the file and count the column, and an off-symbol position returns nothing.

Session-log analysis over 1,801 sessions (~37,000 tool calls) measured the consequence: 14 `lsp` calls total (0.04%), every one of them the feature's own development or smoke sessions; organic adoption after mounting was zero across 700+ sessions in which grep was called 731 times for symbol-style searches. Prompt guidance existed (the tool section and the grep cross-reference nudge) and the tool worked, so the barrier was structural: the input contract, not discovery or breakage.

Upstream status at decision time: `packages/lsp/` matched upstream master exactly, upstream had been quiet since 2026-08-21 with no open PRs, its issue tracker is disabled, and its documentation declares symbols outside the four-operation contract. Waiting for an upstream equivalent had no timetable.

## Decision

The `lsp` tool exposes a fifth, name-based operation: `workspaceSymbol` takes a non-empty `query` and no coordinates. Its description and prompt guidance lead with it and teach the workflow chain — `workspaceSymbol` returns `path:line:character` the position operations accept verbatim.

The seam grows a separate `LspService.symbol()` method rather than a fifth `LspOperation`: symbol lookup has a different request schema (no file, no position) and no extension to route on, so the service fans the request out to every registered provider in registration order and merges their groups. A provider whose server lacks `workspaceSymbolProvider` contributes nothing; if every provider lacks it the call fails `LSP_UNSUPPORTED_OPERATION`; other errors propagate. The grep tool description's cross-reference now names the entry point ("prefer the lsp tool (workspaceSymbol for a symbol name)").

The real-server e2e floor caught a deployment-blocking quirk before ship: tsserver's `navto` answers `No Project` until a document opens and unloads the project when the last document closes, so under the transient-open host a bare symbol query always fails there. The request therefore carries an optional `seedFilePath`: the provider reads that file, derives its language id from its own mapping, and the instance opens it transiently around `workspace/symbol` and remembers it for later seedless queries; without a seed the instance re-opens the last document it opened. The tool exposes the seed as a recommended `file_path` on `workspaceSymbol` (smoke testing showed cold first queries push the model back to grep, so the description recommends it up front).

Cross-language generalization followed from the mixed-deployment reality: a seedless query must not sink one provider's failure (a cold tsserver) into the other providers' answers, and a seed whose language no configured server covers must be perceivable instead of silently empty. `symbol()` therefore routes a seeded request to the one provider covering the seed's extension (mirroring `query()`'s extension routing), returns an install suggestion for an uncovered seed extension without querying, and merges a seedless fan-out with per-provider failure notes. Modern servers (pyright, gopls, rust-analyzer) index the whole workspace at startup and need no seed — the seed mechanism is a tsserver compatibility shim that composes harmlessly with them.

Adoption is measured, not assumed: the pre-declared criterion is ≥10% of deepseek-harness coding sessions showing an organic `lsp` call within a week of deployment, with the operation mix attributing which lever (schema ergonomics vs prompt guidance) moved. The session-log scan methodology from the problem analysis is the measurement instrument.

## Alternatives considered

**Prompt-only intervention** — strengthen the persona or tool guidance without changing the schema. Rejected as the sole measure: the guidance already present had produced zero organic use, and no wording can let a coordinate-only interface answer a by-name query in one call. Retained as a complementary lever.

**Automatic grep-to-LSP delegation** — have grep detect symbol-shaped patterns and consult the seam implicitly. Rejected: implicit behavior violates the explicit-at-boundaries convention, makes grep's contract untestable, and hides the LSP unavailability path from the model.

**Wait for upstream** — keep `packages/lsp/` untouched to avoid a local diff. Rejected: upstream showed no signal of shipping this (quiet, no PRs, no issue channel, documented four-operation closure), while the zero-adoption cost accrues daily. The diff is localized to three packages and a future upstream equivalent merges semantically.

## Consequences

The model can find symbols by name in one call, matching grep's input ergonomics while returning semantically resolved declarations; coordinate operations gain a natural pipeline step instead of a barrier. The tsserver seed mechanism adds one remembered-document field and a bounded seed read per provider, and a cold seedless query on a project-loading server surfaces the server error honestly rather than retrying silently. The fork now carries a local extension of the upstream seam and tool contract — a future upstream symbol API needs a semantic merge, and the READMEs flag the divergence. Unresolved `WorkspaceSymbol` entries render without a position instead of resolving through `workspace/symbol/resolve`; empty-query match-all semantics are rejected at the tool to bound server load. Adoption remains unproven until the measured criterion is evaluated; if it fails, the next lever (result enrichment, or accepting grep dominance) is a separate decision.

## Verification

Package tests cover the seam (seeded routing to the covering provider, uncovered-extension result without queries, fan-out merge order, unsupported folded to empty, failure retention alongside groups, all-failed aggregation, no-provider and all-unsupported failures, signal forwarding, HMR disposal), the provider path (capability gate, seed read and language-id derivation, seed and remembered-document opens, seed persistence for later seedless queries, cancellation and transport replacement, symbol normalization and kind mapping), and the tool layer (schema, per-operation argument validation through the executor, seed passthrough, failure notes and install-suggestion rendering, rendering with caps and no-location entries, presentation). The real `typescript-language-server` e2e pins all three symbol paths: the cold seedless `No Project` failure, the seeded query, and the remembered-document fallback after a position query. The keyless `lsp-symbol` ACP snapshot drives the real Loader composition end to end against a fixture stdio server, pinning the routed seeded query, the uncovered-extension install suggestion, and the `maxLocations` omission marker; `lsp-definition` and `fs-glob-sampling` expected outputs were refreshed for the prompt, schema, and grep description changes.
