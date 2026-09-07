# Agent Note: Fork conflict-surface reduction wave

Status: implemented

English | [中文](2026-09-06-fork-conflict-surface-reduction.zh.md)

## Problem

The 2026-09-06 dev×master audit (706 fork commits over master d347e70390; 1074 files added, 381 upstream files modified) confirmed the placement principle works — fork-local packages appeared in neither recent sync's both-sides intersection (88 and 193 files) — and located the recurring merge cost in structural misplacements: a dead duplicated tsconfig reference block, plan-mode guidance prose grafted into four upstream-owned files, four empty invariant companions the upstream gate rejects, four vitest lanes still on native tsconfig resolution after the main lane's revert, three stale hand-written adapter slices whose drift `as` casts silently absorb, unrelated wording edits in AGENTS.md, and no standing inventory of the seam grafts principle 2 requires proposing upstream.

## Decision

Twelve commits land the reduction wave:

1. **Subtraction** — the session-controller tsconfig reference block collapses to upstream order plus the single real mcp-workspace reference (76 lines); three unrelated AGENTS.md wording edits revert; the root chatroom extraction-plan draft is deleted and the committed htmls/ artifacts untracked.
2. **Empty invariant companions omitted** on feishu-bridge, feishu-bridge-chatroom, mcp-workspace, and tool-subagent-report; each README pair records the package-specific reason; `verify-package-invariants` is green.
3. **Plan-mode guidance relocated** — the three preset files and the base bundle patch return to upstream verbatim; the bridge bundle patch owns the fork guidance, and the lockstep spec pins exactly three deltas: parallel exploration dispatched through `feishu_bridge_subtask`, parallel/serial group marking, and the rejection discussion round. Non-bridge compositions see upstream guidance; bridge deployments are unchanged.
4. **vitest reunified** — all five lanes resolve through `vite-tsconfig-paths`; the 2026-08-27 note records the two-step revert; the development/testing doc hunks and their pairing records return to upstream text.
5. **The mcp-workspace absent warning** rides the scoped logger (the entry composition points' channel) instead of raw `console.warn`, and the sixteen-line snapshot-harness special-case collapses to empty-stderr assertions.
6. **Compile-time slice conformance** — `src/agent-dsh/conformance.ts` pins every hand-written `*Like` slice to the real exported service; three stale slices (the persistence list signature and the subagent prompt/content/source erasures) were corrected with it. Upstream signature drift now fails typecheck instead of shipping through a silent cast — the flat/wrapped SessionEvent incident's class.
7. **auto-compress** triggers from `contextPressure.projectedTokens` — the provider-anchored occupancy the /context card reads, falling back the moment a compaction lands — deleting the chars-per-rune second token account ([feature note](../feature/2026-09-06-feishu-bridge-auto-compress-projection-source.md)).
8. **dsh-context provenance corrected** — the aggregate/chartspec port headers name the actual source: bowenliang123/dsh-context, a separate repository the live profile links, never a workspace dependency of this repo.
9. **The upstream graft ledger** lives in the sync skill's references, pointed to from the fork-policy notes: every fork change sitting on an upstream-owned seam with its proposal status, so principle 2's workload is visible and rows retire when upstream equivalents land.
10. **mcp-workspace mounts continuable children through the setup seam** — the package registers its own `registerContinuableSetup` contribution (the seam gained async contributions; awaited child plugins must install before the first prompt assembly), and the subagent and in-process-driver packages drop their direct dependency on the fork-local package. The one-shot mount stays in child-agent behind a local minimal interface, pinned by mcp-workspace's integration spec ([architecture note](../architecture/2026-09-06-mcp-workspace-continuable-setup-contribution.md)).

## Alternatives considered

- **Keep grafting.** Every absorption re-pays each graft; the audit's both-sides intersections priced the status quo.
- **Propose everything upstream immediately.** The seam proposals are the durable fix but are external batched actions; this wave removes everything no proposal is needed for. The pilot (the acp race fix) and the S-tier batch remain queued behind the ledger.
- **Import dsh-context directly.** Cross-repo, not a workspace dependency; the profile link cannot become a repo dependency.

## Consequences

- Thirteen upstream files return to zero fork diff (381 → 368 modified; docs 54 → 48): the presets, the development/testing pairs and their pairing records, the four companion wirings, and the harness special-case.
- Non-bridge compositions (headless demos) see upstream plan guidance again, and continuable children in mcp-workspace-less deployments no longer warn — the upstream package no longer knows the optional feature exists.
- The conformance file turns the next upstream signature drift into a typecheck failure in this repo rather than a silent runtime change; the same protection covers the one-shot mount through mcp-workspace's integration spec.
- The per-run vite migration warning returns on every vitest invocation: the accepted cost of toolchain parity.
- Remaining structural items wait on one upstream seam — the generic agent-setup contribution — which retires the one-shot mount, the session-controller wrap, and the duck-typed interface together.
