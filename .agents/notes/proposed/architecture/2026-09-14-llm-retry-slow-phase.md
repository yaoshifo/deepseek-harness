# Agent Note: Slow-phase retry budget for sustained rate-limit windows

Status: proposed

English | [中文](2026-09-14-llm-retry-slow-phase.zh.md)

## Problem

Parallel subtask fan-out on one rate-limited provider key can sustain a 429 window longer than the whole retry budget, and budget exhaustion kills the turn. On 2026-09-14 (chat oc_7cc55d35d47b058d17becd902ff39dda), five research subtasks plus two plan-render one-shot sessions shared the mify-dsh key: 429 retries totaled 414 across seven sessions over roughly nine minutes of peak contention. Two subtasks exhausted the then-configured 8-retry / ≈110 s budget mid-window and their turns ended with `turn/end {kind: 'error', error: {code: 'RATE_LIMIT'}}`. The child sessions survived as idle with full context and were re-woken by the parent, but only after the parent observed the gather failure brief — one extra round trip and visible failure.

The same failure mode occurred on 2026-09-11 (chat oc_4e9fa583, eight agents, then-default 5-retry / ≈16 s budget, all fan-out turns died). That incident's fix raised the budget to 8 retries / 30 s cap; the 2026-09-14 incident shows a raised budget narrows but does not close the gap, because the window length tracks the contention period itself: as long as several agents keep retrying against one key, the window does not close.

The mitigation shipped on 2026-09-14 (config-only: 15 retries / 60 s cap, total ≈10 minutes, both machines, [`cordis.patch.yml` retryPolicy under `providers.mify-dsh` / dev `providers.glm`]) covers the observed nine-minute pressure period with modest margin. This proposal owns the design for the residual case: a sustained window that outlasts even that budget.

## Why the obvious fail-soft does not work

The initially imagined fix — "return the rate-limit error to the agent and let it back off and continue" — is not implementable. A RATE_LIMIT failure means the model request itself failed; there is no model to receive an error message and decide anything. The request-error path in the agent loop (`packages/core/agent-loop/src/agent.ts`, the `agent/request-error` waterfall with a default that throws `LlmError`) runs entirely below the model. Every viable design keeps the decision inside the harness; the only question is which layer waits.

## Proposal

Add an optional slow phase to the normal retry mode of `dsh-llm-retry`, in the provider-owned `retryPolicy` configuration (`packages/llm/llm/src/retry-policy.ts`):

```yaml
retryPolicy:
  mode: normal
  maxRetries: 8                 # fast phase: exponential 800ms → maxDelayMs (current behavior)
  backoff: {initialDelayMs: 800, maxDelayMs: 30000, jitterRatio: 0.3}
  slowPhase:                    # optional; absent = current behavior exactly
    maxRetries: 5               # slow phase: fixed cooldown attempts after fast exhausts
    cooldownMs: 300000          # jittered ±30%
```

Mechanics:

- **Executor branch.** `dsh-llm-retry` (`packages/llm/llm-retry/src/index.ts`) currently returns `next()` — handing the failure to the waterfall default, which throws — when `previousRetry >= policy.maxRetries` (line 223). With `slowPhase` configured, that branch instead schedules a slow retry while `previousRetry < maxRetries + slowPhase.maxRetries`, waiting `cooldownMs` with the existing jitter and cancellation semantics. The slow phase inherits the fast phase's `retryableCodes` gate: auth-class hard failures never enter it and keep failing fast. When the slow budget also exhausts, `next()` runs as today and the turn still ends — bounded, visible, not masked.
- **Continuous counter, no projection change.** The `llmRetry` projection state keeps its `{retry, retryId}` shape: the counter continues across the phase boundary (fast 1..8, slow 9..13). The phase is derivable from existing event fields (`retry > maxRetries`), so `LlmRetryEventData` gains no new field and the session-event schema stays as is.
- **Policy key.** `retryPolicyKey` for normal mode appends the slow-phase parameters, so a config change re-keys the per-step retry state rather than mis-crediting counts across policies.
- **Config validation.** `slowPhase` joins the accepted top-level keys of the policy schema (`validateKeys` rejects unknown flat keys today); `resolveRetryPolicy` defaults, validates, and freezes it. `maxDelayMs` does not cap `cooldownMs` — the two answer different questions (per-attempt backoff ceiling vs. phase-two wait), and capping would silently delete the configured margin.
- **Invariant.** `dsh-llm-retry`'s `invariant` companion extends its history checks to accept `retry` counts beyond fast `maxRetries` when the session's policy key carries a slow phase, and to reject them otherwise.

Why this shape rather than a bigger fast budget: a single exponential curve that must cover a multi-minute window either wastes its early retries inside a window that will not close soon, or caps so high that transient blips also wait minutes. Two phases keep transient recovery at today's speed and spend the long waits only after the fast budget has proven the window sustained. Typical total resilience with the shape above: fast ≈2 minutes plus 5×5 minutes ≈27 minutes.

## Alternatives considered

- **`mode: 'always'` (already implemented).** Retries every failure — including auth and other hard errors — until success, cancellation, or disposal. Rejected for shared-key production routes: a misconfigured credential would hold the turn indefinitely instead of failing fast and surfacing.
- **Turn-level auto-resume.** End the turn as today, then a plugin schedules a delayed continuation message (the wake path the parent used manually). More moving parts — synthetic-message semantics, a timer owner outside the session, interaction with gather's settle-then-failure-brief ordering — for the same recovery the slow phase achieves without ever ending the turn. Revisit only if a failure class appears that genuinely requires the turn to end first.
- **Provider-key concurrency semaphore.** Cap in-flight requests per key so fan-out cannot trip the limiter at all. The root-cause fix, but it crosses sessions (daemon-global state), its safe concurrency for the mify key is unknown, and queueing changes throughput characteristics for every consumer. Out of scope here; if fan-out rate-limit incidents recur after the slow phase ships, this is the next escalation, owned by a separate proposal.

## Implementation gate

Implementation is deliberately deferred. The 15-retry / 60 s cap deployed on 2026-09-14 must first prove insufficient — i.e., a future incident where a subtask turn dies to RATE_LIMIT exhaustion with the new `policyKey` visible in its `llm/retry` events (the triage fingerprint for this class now records how to check). Until then this note owns the design so implementation is a decision, not an investigation.

## Verification plan (for the implementing change)

- `resolveRetryPolicy` unit tests: `slowPhase` absent → behavior identical to today; present → defaults, validation (rejects flat keys, non-positive values), frozen output.
- Executor tests (`dsh-llm-retry`): fast-exhaust with `slowPhase` schedules a cooldown retry instead of `next()`; slow-exhaust reaches `next()`; non-retryable codes never enter the slow phase; abort during a slow wait settles without a further attempt.
- Invariant tests: history with `retry > maxRetries` accepted under a slow-phase policy key, rejected without one.
- A recorded-session snapshot exercising a retry loop is unaffected (no event-shape change) — confirm via the existing snapshot suite for the llm-retry surface.
