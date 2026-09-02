# Agent Note: Unmount the lsp tool from feishu-bridge profiles after the adoption verdict failed

Status: implemented

English | [中文](2026-09-02-lsp-tool-unmount-adoption-failure.zh.md)

## Problem

The lsp tool ships as a three-package capability seam ([2026-07-15](../architecture/2026-07-15-lsp-capability-seam.md)). Mounting it in the feishu-bridge profiles — the live profiles on both bridge hosts plus the bundled profile — declared `lsp`, `lsp-stdio`, and `tool-lsp`, injected the LSP prompt section into every request, and cross-referenced the tool from the grep description (b650ab0fab). The deployment carried a pre-registered verdict: at least 10% of harness coding sessions should contain an organic lsp call within one week of mounting, terminal date 2026-09-03.

## Decision

The verdict failed, and the profiles no longer mount the lsp tool. The removal is assembly-level only; the three packages, their tests, and the lsp snapshot profiles (`snapshots/acp/lsp-symbol`, `snapshots/session/lsp-definition`) stay.

Measured on 2026-09-02 over the 5.8 days since mounting (2026-08-27 19:20), scanning 3,874 session logs across both bridge hosts:

- 31,350 tool calls in-window; 9 lsp calls (0.029%), of which 8 were deployment verification or self-test sessions. The one organic call was an audit subagent's `workspaceSymbol` lookup, and it succeeded.
- 148 harness coding sessions (created in-window with at least one code-tool call); 0.4–0.7% contained an organic lsp call, versus the 10% criterion.
- Mount rate was 100% on both hosts across recent sessions, so the zero is not a mount failure; identifier-shaped grep patterns — the substitution scenario for `workspaceSymbol` — ran 118 times in the same window.

Keeping the tool mounted cost about 550 tokens per model request (a 1,541-char tool entry plus the ~640-char prompt section) in every session on both hosts. The grep cross-reference sentence is removed with the spec assertion inverted to `not.toContain('lsp')`; snapshot fixtures and the tool catalog follow the source.

## Alternatives considered

**A second adoption-engineering round (description refinement, failure-recovery text, approval-free calls, or intercepting the grep family).** Rejected: the verdict gap is 15×, the one organic call already succeeded — tool quality was not the bottleneck, tool selection at query time was — and interception only works by blocking the whole grep family, a cost disproportionate to a 0.03% call share.

**Freezing the assembly as mounted.** Rejected: it keeps paying the per-request token cost and the link-package maintenance for a tool the model does not choose.

**Deleting packages/lsp.** Rejected: the packages are upstream-owned, so a fork-side deletion re-appears at every upstream sync. The seam stays intact for a potential diagnostics consumer.

## Consequences

The live and bundled profiles no longer declare the lsp plugins or their server-binary dependencies, and the daemon's model surface loses the lsp tool and its prompt section. Diagnostics injection — the remaining LSP direction with a working precedent — needs only the `ctx.lsp` provider, not the model-facing tool; the seam note's deferral of freshness and accumulation semantics still governs it. Remounting is configuration-only: restore the three profile entries and the server-binary dependencies, run `pnpm install` in the profile, and reload.
