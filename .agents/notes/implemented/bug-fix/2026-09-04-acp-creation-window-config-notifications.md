# Agent Note: Silent ACP session-creation window for config-option notifications

Status: implemented

English | [中文](2026-09-04-acp-creation-window-config-notifications.zh.md)

## Problem

Every ACP `session/new` could emit a `config_option_update` `session/update` notification right after the response, duplicating the `configOptions` the response itself carries. The emission was an asynchronous side effect, not a designed step: composing a session mounts agent-scope provider plugins, their adapter registration fires `llm/adapters-updated`, and the bridge's `topologyChanged()` then resolves options off-chain and queues the notification on the session's output tail. Whether the notification reached the client before the session closed was therefore a race. The `cancel` snapshot scenario — prompt, readiness file, immediate cancel — lost that race roughly one run in four: the notification either landed after the client stopped reading or was dropped by `topologyChanged`'s closing guard, and the expected stdout lost its second line. The suite's only scenario flake traced to this product nondeterminism.

## Decision

The session-creation window is silent: `AcpSession` starts with topology notifications unarmed, and `topologyChanged()` returns early while unarmed or closing. The creating handler — `session/new` and `session/resume` alike — arms notifications only after its response's option discovery has resolved, immediately before returning. The response is the initial configuration state (the ACP contract already puts `configOptions` on it); `config_option_update` publishes only topology changes that happen after it. A topology change landing inside the window is not lost: the response's awaited discovery reflects the state it produced.

## Alternatives considered

**Emit the creation-time notification deterministically before the response.** Keeps the current wire bytes but needs deduplication against the incidental in-window emission (both would fire) and an ordering guarantee against the RPC response write — machinery serving an echo no client consumes. Lost to silence.

**Have the snapshot harness wait for the notification before cancelling.** Would pin the scenario while leaving the product race in place for every real fast client. Rejected as flake-masking.

**Normalize the notification line away in the snapshot suite.** Violates the fixtures-over-normalizers rule and hides the product behavior change from review.

## Consequences

External ACP clients no longer receive a `config_option_update` echo at session creation; they read the initial state from the creating response, which the ACP protocol already provides. No in-repo client consumed the notification (the only emission site was the bridge itself; subagent-acp, the SDK, and the API BFF have no listener). Mid-session topology changes — adapter registration, replacement, or disposal after the creating response — still publish complete options exactly as before, pinned by the existing bridge specs. The `cancel` scenario is now byte-stable: ten consecutive replays green, and the full keyless snapshot suite replays green.

## Testing

The regression is deterministic, not probabilistic: a bridge spec injects one adapter registration inside the creation window (through a `listModels` spy that registers a provider mid-discovery) and one after it, then asserts exactly one `config_option_update` arrives — from the post-window registration, advertising the post-window provider. Before the fix that assertion saw two notifications; after it, one. All 54 bridge specs and the refreshed ten ACP scenario expected outputs (each losing the redundant line) replay green.

## Related

- [LLM model catalog and ACP selection](../../archived/architecture/2026-07-15-llm-model-catalog-and-acp-selection.md) — the catalog and selection machinery whose per-session mounting fires the topology events this note silences in the creation window.
