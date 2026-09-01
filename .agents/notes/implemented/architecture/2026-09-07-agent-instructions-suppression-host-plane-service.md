# Agent Note: The agent-instructions suppression seam lives on the host plane

Status: implemented

English | [中文](2026-09-07-agent-instructions-suppression-host-plane-service.zh.md)

## Problem

The fork had converted `dsh-agent-instructions` from upstream's function plugin into a Cordis `Service` so the bridge adapter could call `suppress()` on it for bare-persona and render-fork sessions (Go `--bare` parity: those sessions get no workspace-instruction injection). The upstream agent-presets mount rule that arrived with the 2026-08-29 sync rejects a preset row that publishes a process-global service, and the shipped presets mount this plugin as a plain row — so all 13 web-agent-presets e2e tests failed with `row(s) published process-global service(s) [agentInstructions]`. The bridge deployment never hit the rule (it mounts the plugin host-plane via dsh-base), which is why the breakage surfaced only in the web-app suites.

## Decision

The plugin returns to upstream's serviceless function-plugin shape, and the suppression state moves to a dedicated `AgentInstructionSuppression` service exported from the `@deepseek-ai/dsh-agent-instructions/suppression` subpath. The subpath resolves to `lib/types/` — the same tsc-emitted convention `dsh-tool-subagent-control/list-agents` uses — so a scoped `tsc -b` of the package is enough to produce it.

- The plugin reads the registry optionally (`ctx.get('agentInstructionSuppression')`); a missing registry suppresses nothing, so a preset mount publishes no service and passes the mount rule.
- Only the bridge composition mounts the registry — a host row in `packages/acp/feishu-bridge/cordis.patch.yml` — and the adapter's two session-start call sites read `agentCtx.get('agentInstructionSuppression')`.
- Suppression semantics are unchanged: caller-scope markers through the service proxy, the scope-chain walk (an enclosing scope suppresses descendant agents), and disposal restoring injection. `tests/suppression.spec.ts` pins all of it, now mounting the registry beside the plugin.

## Alternatives considered

**Wrapping the preset's `agent-instructions` row in an `isolate` group and migrating the adapter to `serviceForAgent`.** Rejected: it adds a permanent structural divergence to three upstream-owned preset YAMLs (which already carry the plan-mode text diff), a bridge→agent-presets dependency, and a silent-failure mode — behind an entry-local realm `agentCtx.get` returns undefined, so a missed migration would skip suppression without any error.

**Reverting the plugin and dropping `suppress()` outright.** Rejected: the bare-persona and render-fork parity features are load-bearing bridge behavior; removing the seam breaks them.

## Consequences

Upstream-owned files are untouched again — the preset YAMLs and the plugin's shape match upstream, shrinking future sync friction — and the suppression seam survives as an explicit host-plane capability the fork can propose upstream once stable (the fork principles prefer proposing seams over re-grafting them at every absorption). The costs: compositions that want suppression must mount one extra row, and the subpath needs a hand-written tsconfig alias because the paths generator covers only bare names and `src/invariant.ts`. Verified by the 32/32 web-agent-presets e2e file, the 181-test agent-instructions suite, and the bridge adapter specs.
