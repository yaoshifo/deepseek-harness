# Agent Note: Bridge bundle patch owns the plan-mode guidance section

Status: implemented

English | [中文](2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.zh.md)

## Problem

The plan-mode section's delegation sentence must name a delegation tool the model can actually call. In bridge compositions the generic `subagent`/`subagent_fork` tools are disabled (single delegation entry point: their children are invisible to the engine), so dsh-base's tool-neutral wording — "background subagent delegations" — names tools the model cannot use here.

Since 2026-08-21 the deployment carried the adapted wording as a per-profile `cordis.patch.yml` override: a hand-maintained local copy of the whole section, whose own comment said to delete it once the upstream dsh-base release carried the text. Two failure modes followed. Registry-pinned dsh-base releases lag the repository text, so every guidance evolution meant re-copying the section into each machine's profile — on 2026-09-01 the [parallel-exploration rewording](../feature/2026-08-31-parallel-exploration-default-guidance.md) reached the repository and the dev profile was missed (Mac re-copied 08-31, dev still served the 2026-08-21 wording), leaving half the deployment without the default-parallel guidance. And the awaited upstream text is tool-neutral anyway, so deletion on arrival would have restored a sentence naming disabled tools.

## Decision

- The bridge-adapted plan-mode section lives in the bridge package's own bundle patch (`packages/acp/feishu-bridge/cordis.patch.yml`) as an id-targeted config override on the `plan-mode` row dsh-base mounts. Profile bundle order (dsh-base → feishu-bridge → chatroom) makes the later bundle's override replace the earlier row's config, and link-mounted packages take source updates on `/reload` — guidance evolution reaches bridge deployments through the normal pull-and-reload channel, with no per-machine editing.
- Every paragraph stays verbatim from dsh-base's section; the only delta is the one delegation sentence ("start them together as background subagent delegations in one assistant message, each with a focused, self-contained prompt" → "dispatch them together as `feishu_bridge_subtask` spawns in one assistant message, each with a focused, self-contained brief").
- The per-profile overrides retire: the 2026-08-21 shim's end condition is superseded — the override is permanent because the tool-neutral upstream sentence does not fit this composition, not temporary pending a release.
- `tests/bundle-patch.spec.ts` pins both facts through the real `applyEntryPatches` composition: base+bridge patches yield the adapted section (no plan-mode patch warnings), and the section stays in lockstep with dsh-base's modulo exactly that one sentence — any base rewording fails the spec until the adaptation is re-synced.

## Alternatives considered

- **Keep per-profile overrides and hand-sync them.** The drift class this change removes; the dev profile proved it fires in practice.
- **Wait for the dsh-base release and delete the override** (the 2026-08-21 end condition). The release carries the tool-neutral sentence naming disabled tools; the adaptation must live somewhere regardless, and registry-pinned dsh-base still updates per machine on profile installs.
- **Link dsh-base into the live profile.** Flows repository text automatically but stays tool-neutral, and moves the whole base composition onto local source for one sentence.
- **A plan-mode plugin extension point where the bridge appends a delegation section instead of overriding the whole section.** Removes the two-copy residual entirely; a plugin API change for one consumer, deferred as a possible upstream proposal.

## Consequences

- Forgetting a per-machine copy is no longer possible; the profile patch layer remains available as an emergency override (it applies after every bundle layer).
- The residual drift risk moves inside the repository: dsh-base's section and the bridge adaptation are two copies, and a base rewording must re-adapt the bridge sentence — the lockstep spec turns that drift into a red gate instead of a silent deployment gap.
- Semantic widening: every composition mounting the bridge bundle (repo specs, registry installs, future deployments) now receives the adapted section. `feishu_bridge_subtask` is registered by the bridge plugin itself, so the wording is valid wherever the bundle mounts.
- Rollout ordering constraint: a profile may delete its shim only once the linked package carries the override; deleting first falls back to dsh-base's tool-neutral section until the next reload.
