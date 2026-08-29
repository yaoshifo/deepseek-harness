---
description: "The subagent delegation seam for users and maintainers choosing a provider backend, composing delegation tools, or debugging child-agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

## Summary

`dsh-subagent` is the service behind child-agent delegation: an agent hands a task to a named child, collects the finished result, and — for continuable children — keeps sending follow-up work across turns. Multiple providers coexist under one contract, so a single composition can offer in-process children, out-of-process ACP or SDK children, and real Codex or Claude Code children side by side. Children come in two shapes: one-shot runs that settle with a single result, and continuable children whose durable session accepts later messages and can be interrupted. The same service answers discovery questions — which children exist, their mode, activity, and lineage — without loading or resuming them. Mount it with at least one provider backend and a delegation tool; the backends and the model-facing tools live in sibling packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This package is the contract every delegation setup shares. You enable it by mounting the service together with one or more provider backends and the model-facing delegation tool; from then on, an agent can delegate work and the service routes each request to the named provider.

### Enabling delegation

Mount the service with a provider and the delegation tool. The provider registers under the name you configure (the in-process spawn backend defaults to `spawn`); the tool row names that provider so the model sees a static tool. A minimal one-shot setup:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

An agent that calls the tool gets the child's final answer as the tool result. Mounting the service alone changes nothing: nothing can delegate until a provider and a tool are composed.

### One-shot and continuable children

One-shot children run once and settle with a single result, plus an optional structured output and a safe diagnostic on failure. A start request may override the child Agent's provider, model, reasoning effort, and output-token limit through `agentOptions`; every requested option requires the provider's matching capability. Continuable children keep a durable session and accept later messages in order: the caller receives a stable child id, sends follow-ups, and can interrupt the current turn without destroying the child. The tool row's `backgroundMode` picks the shape (`one-shot` by default, or `continuable` on providers that support it).

### Following up, interrupting, and discovering

Continuable children answer follow-up messages as their next turns, and the parent can interrupt a running turn or list its children at any time. Discovery covers both shapes: the service lists direct children and the full descendant tree — mode, activity, and lineage — reading live session state and optional persistence, without loading any child.

### Failure and recovery

Requests that need a capability the chosen provider lacks fail loudly at start rather than being silently ignored. A failed child run returns a stop reason, and provider backends add a safe diagnostic; a cancelled request settles as `aborted`. Children are isolated: a crashed or misbehaving child cannot corrupt the parent's session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service is built and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One service, many providers.** The service is a named-provider registry; each backend registers under a unique name and a request picks one by name.
- **Two child shapes.** One-shot runs transfer ownership at publication; continuable children keep a durable Session and at most one process-local Activation.
- **Fulfillment is publication.** A provider's `start()` fulfills only after a real child exists, so the caller always owns a live run or nothing.
- **Trusted same-process values.** Requests, descriptors, and results are borrowed immutable; serialization and hostile-input validation belong at process and wire boundaries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: provider registry, start and continuation API, lifecycle events |
| [`src/continuation.ts`](src/continuation.ts) | Continuable children: identity reservation, Activation residency, follow-up, interrupt, settlement |
| [`src/types.ts`](src/types.ts) | Public request, result, and provider contracts |
| [`src/descriptor.ts`](src/descriptor.ts) | Versioned `subagent/descriptor` session-event vocabulary |
| [`src/child-agent.ts`](src/child-agent.ts) | Child composition, delegated policy, depth helpers |
| [`src/list-children.ts`](src/list-children.ts) | Discovery over the live session store and optional persistence |
| [`src/control.ts`](src/control.ts) | Browser control assembly: catalog activity sampling, browser-zone validation, failure codes |
| [`src/control-types.ts`](src/control-types.ts) | Client-safe catalog row, control requests, receipts, and failures |

### One-shot flow

A request is validated against the provider's advertised capabilities, a durable descriptor is snapshotted, and the provider builds the child. Both in-process providers advertise `agentOptions`: child creation merges requested fields over the provider, model, and reasoning effort in the parent's latest logged request, falls back to creation options before the first request, and retains the configured token limit. A route change without an explicit effort clears the inherited route-owned effort so the selected model resolves its default. DSH SDK also advertises this capability and publishes immutable `agentRouteDefaults`, which supply its instance provider/model defaults before exact-route preflight; `start()` still owns direct callers and the output cap. ACP, Codex, and Claude Code reject agent-route overrides rather than silently ignoring them. On success the run is published and ownership transfers to the caller; on failure the provider rolls back every unpublished resource. The result carries the child's final output, an optional structured value, a stop reason, and an optional safe diagnostic.

### Continuable flow

The manager reserves a child identity, resolves the durable descriptor, creates (or cold-resumes) the child Agent, installs it in an Activation, and submits the prompt. Later messages become FIFO turns through the child's own inbox; an absent Activation cold-resumes from the persisted session. When a resident Activation settles, the manager tells the child's direct parent in the parent's own turn stream.

Start-time features are advertised in `provider.capabilities` because the service must reject an unsupported request before child creation — on the one-shot `start` path and on `startContinuable` alike, both gating the same request option subset:

- `agentOptions` — merge requested child creation options (provider/model/reasoning effort/token limit) over the parent's logged route.
- `outputSchema` — enforce a structured final result (one-shot only; continuable requests carry no schema).
- `depthLimit` — enforce `maxDepth`.
- `toolFilter` — apply the requested child tool restriction.
- `persona` — apply a per-child persona.
- `cwdOverride` — honor a per-request absolute `cwd` overriding the parent's working directory for the child session. Pure session metadata: git worktree isolation or other directory preparation stays with the caller, composing on top of the override.

### Ownership and invariants

- **Publication is the boundary** — before it the provider owns the setup and must roll back on failure; after it the caller owns the run and must dispose it.
- **Registration is effect-scoped** — removing a provider blocks new starts but never revokes accepted runs.
- **Continuation authority is exact identity** — follow-ups require the exact live direct parent; reports require the exact live child.
- **The descriptor is log-only** — a session event absent from model history and retained across compaction; a continuable descriptor records the resolved child provider, model, and reasoning effort explicitly for cold resume.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared seam to the backends, the model-facing tools, and the design decisions.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [Subagent capability seam](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable background subagents](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md) — durable children that accept follow-up turns.
- [In-process spawn backend](../subagent-spawn-in-process/README.md) — the simplest provider to compose.
- [Out-of-process ACP backend](../subagent-acp/README.md) — children with their own runtime over the Agent Client Protocol.
- [Merged subagent control service](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md) — the follow-up, interrupt, and listing surface.

## Delegation depth

The seam owns the depth vocabulary shared by Service Providers and Consumers: the `AgentOptions.subagentDepth` declaration, `assertSubagentMaxDepth`, and `delegationDepthOf(agent)`. The persisted `SessionHeader.delegationDepth` is authoritative and monotone — runtime options may deepen the count but never lower it, so a resumed child cannot be re-counted as top-level.

`inheritsParentContext` is descriptive rather than enforceable. It says only whether the child sees completed parent conversation history (`fork` does; `spawn` and the out-of-process one-shot providers do not), not whether it inherits tools, services, or authority.

## Delegated policy

Both in-process delegation paths fix the child's permission scope at the delegation boundary through the shared child-agent helpers. `captureDelegatedPolicyOverrides(parent)` snapshots the parent session's explicit sandbox override (`sandboxPolicy.overrideOf()`) and pins the child's approval policy to `'never'` whenever the approval capability is composed — regardless of the parent's own policy — so a delegated child acts only within its inherited sandbox scope and every ask (for example a `sandbox_permissions` escalation) is rejected deterministically instead of waiting on a prompt no one is watching (both services are optional `ctx.get` consumers). `appendDelegatedPolicyOverrides()` writes each value onto the child's own log as a `source: 'delegation'` `sandbox/mode` or `approval/policy` event during unpublished setup, after any fork seed — so fresh policy wins stale seed state and the child's effective policy stays reconstructable from its log alone. The sandbox deployment default is never copied: an unswitched parent stamps no `sandbox/mode` and its child follows the deployment default dynamically. A continuable start captures before its first await and seeds only fresh materialization; a cold resume replays the persisted delegation events instead of re-capturing the parent, so a parent switch after creation never retroactively changes a durable child. Every in-process child also receives a scoped runtime-context statement (`subagent:delegation`) telling it the scope is fixed and that a task needing wider access ends with a reported limitation, not retries. See the [one-shot](../../../.agents/notes/implemented/feature/2026-07-25-subagent-policy-inheritance.md) and [continuable](../../../.agents/notes/implemented/feature/2026-08-10-continuable-subagent-policy-inheritance.md) delegation-policy Agent Notes.

## One-shot ownership and lifecycle

`provider.start(request): Promise<SubagentRun>` is the ownership-transfer boundary; the delegation tool also uses it inside its one-shot Task-backed background path. Before fulfillment, the provider owns setup and must cancel, roll back, and quiesce unpublished resources on every failure. After fulfillment, the caller owns the run and must call `dispose()` on every path; remaining prompt and turn work belongs to `SubagentRun.result`.

`SubagentRun.result` resolves to `{ output, structured?, diagnostic?, stopReason }`. Child-level failures resolve with a non-`completed` reason; only an infrastructure fault that the seam cannot represent may reject. A provider may add a safe `diagnostic` to a non-completed result after removing tool inputs, file contents, environment values, credentials, and raw protocol payloads and limiting the complete text to 4096 UTF-8 bytes. The common result type does not define provider categories or lifecycle stages: an out-of-process provider may derive fixed display text from its version-pinned structured product facts and an observed process outcome, while consumers render that text without parsing it. The field is not assistant output: consumers present it separately, and it does not enter `subagent/end.lastAssistantMessage`. `dispose()` is idempotent, cancels remaining work, and waits for both result settlement and child-resource quiescence. A result rejection remains on `result`; `dispose()` rejects only for an independent resource-release failure. `output` and the `subagent/end` event's `lastAssistantMessage` use the exported `AssistantOutputFold`/`finalAssistantOutput` helpers to select the child's last non-empty assistant message, or its accumulated assistant text when no such message exists. `output` is `[]` and the event field is absent when the child produced neither ([`SubagentResult`](../../../docs/subsystems/subagent.md#the-terminal-result-subagentresult) owns the terminal result contract).

A local run publishes an ordinary child agent/session before `start()` fulfills, returns that shared session id as `SubagentRun.id`, exposes the exact child as `SubagentRun.localAgent`, records `request.parent.session.id` in the child's `parentSession` header, and appends the resolved descriptor inside its initial turn. Remote providers instead mint a parent-scoped lifecycle id and return `localAgent: undefined`; without a local child session, their one-shot runs are not part of trace-backed enumeration.

## Continuable children and Activations

A continuable child has one durable Session and at most one process-local **Activation** — one residency epoch for a reconstructed child Agent, not a request, result, cancellation, or Task boundary. The Agent inbox is the only turn queue, so the continuation manager owns residency while the Agent loop owns all turn ordering and execution. No continuable path creates a Task or an intermediate result-bearing wrapper.

The manager derives three internal residency conditions from Agent quiescence and the owned-child set rather than maintaining a second state machine: running (an active admission, open turn, or waking inbox work), waiting (quiescent but still owning at least one undisposed child), and settled (quiescent with every owned child disposed, so the manager disposes the `AgentHandle` and removes the Activation). Every continuation message uses `Agent.followup()` and becomes one FIFO turn with no steering of the current turn. Routing depends only on residency: running enqueues, waiting wakes the same Agent, and an absent Activation cold-resumes a new one.

The manager reserves the child identity, resolves the durable descriptor, calls `ctx.agents.create()` (or `ctx.agents.resume()` for cold resume) through a private activation-owner scope, installs the returned `AgentHandle` in the Activation, establishes any continuable-parent ownership, and then submits the prompt. Cold resume never dispatches through a provider because the persisted Session already holds the initial prefix and the folded descriptor is the whole reconstruction input.

### Settlement delivery

When a resident Activation settles, the manager tells the child's durable direct parent, in the parent's own turn stream, that the child produced everything it is going to. Delivery is unconditional for every child whose id a caller actually received: it does not consider whether the child called `report`, because the endings that most need an account — a token ceiling, a model failure, cancellation, teardown — are exactly the ones where the child never got to choose. A materialization rolled back before its first accepted message stays silent, since that caller was told the child was not established. The message carries the epoch's stop reason, its final assistant content when it produced any, and durable provenance `{ kind: 'subagent-settled', form: 'notice', senderSessionId: <child-id> }` — a different source kind from a child-authored `subagent-report`, so a transcript never credits the child with words the runtime wrote.

Two ordering rules make the delivery reliable rather than lucky, and both are why this belongs to the manager instead of an external `subagent/end` listener. First, the send happens **before** the child's ownership release, while the parent still counts the child and is therefore structurally unable to be judged settled. Second, a parent that is itself a resident Activation receives the message through the same waking-admission accounting as a report, so the window between the synchronous send and the microtask that admits it is not mistaken for quiescence — `Agent.status` folds context maintenance into `idle`, and a waking send behind maintenance only arms a deferred wake. Without either rule the parent can be disposed with the notice still in an inbox that `cancel()` clears, which loses it silently.

An idle parent receives the notice as one ordinary later turn. A busy parent is steered into its nearest step boundary instead, so several children settling together cost one step rather than one turn each; steering rather than injecting also means a driver that retires between the status read and the send still claims the message. A parent whose own lineage is already draining receives the notice by injection, with no wake at all: `Agent.followup()` on a quiescent parent starts a turn and `cancel()` does not arm against a later one, so waking during teardown would spend a model request on an Agent its host is about to dispose — once per tree layer, since each layer's notice then wakes the layer above it. The injected message reaches a parent that is still reading its inbox, and the log records the account either way, but it does not outlive that parent's own disposal: `AgentHandle.dispose()` is a `keepInbox: false` cancel, which durably cancels an unclaimed notice. A resumed parent therefore has no pending notice to read: `list_agents` tells it which children exist and whether each is live or stored, while the outcome itself stays in the child's own Session, which a `send_message` reaches by resuming that child. A parent that has left the registry is not an error: the notice is dropped and the child's own Session remains the durable record. Delivery never blocks or fails teardown — a rejected send is logged, because retaining a child to retry a notice would pin its whole ancestry in `waiting` forever.

A continuation-managed parent Activation records each child Session id in an `ownedChildren` set before the child can run and disposes only after every owned child Activation completes `AgentHandle` disposal (child-first). Teardown propagates Agent cancellation top-down before awaiting slow descendants, while handle release remains child-first. Top-level and other non-continuation Agents have no Activation and stay outside this waiting graph. Final settlement awaits a best-effort `ctx.sessions.flush(child.session)` before handle disposal. A listener rejection is logged without failing the Activation because listener participation does not identify a persistence backend; the persisted state may therefore be missing or stale on resume.

The `SubagentRuntime` plugin config field `settlementNotice` selects who delivers that account. The default `'inbox'` keeps the manager's own delivery described above, and the two ordering rules apply to it. `'external'` suppresses the runtime's delivery entirely: the deployment listens for `subagent/end` and drives the parent's next turn itself — for engines whose parent turns are scheduled by their own event loop, where the runtime's wake would spend a model request the engine never asked for. The child's own Session and the `subagent/end` event remain the complete durable record either way, and ownership release (`waiting` → settled) is unaffected: it never depended on notice delivery.

## Lifecycle events

The service emits a `subagent/start`/`subagent/end` pair for each one-shot run and each resident continuable Activation epoch, so continuable children are observable with the same vocabulary as one-shot runs without exposing whether the manager materialized, woke, or cold-resumed them. For a one-shot start it attaches the result observer before the synchronous `subagent/start`, so even an already-settled child still produces `subagent/start` before `subagent/end`; a continuable epoch that fails before residency emits neither edge. The pair shares a service-minted `runId`; the `local` flag is snapshotted from the provider's exact `localAgent` (always true for a continuable child), so observers never infer run identity or locality from reusable provider/session names. The `provider` field contains the provider name recorded when the child was first created rather than claiming current registration: an accepted one-shot run may settle after provider removal, and a cold-resumed epoch reads the initial provider name from its descriptor without calling or registering that provider.

Run events are scoped to the delegating parent. Every listener is independently contained: a synchronous throw or rejected returned promise is logged without starving peer listeners or changing the run.

Provider additions and removals also emit `subagent/provider-added` and `subagent/provider-removed`. Consumers such as the model-facing tool use those events because Cordis may load sibling plugins concurrently; configuration order does not prove registration order.

Continuable children do not create `SubagentRun` or Jobs. The continuation manager directly owns one process-local Activation and retained `AgentHandle` per resident child Session, uses the Agent inbox as the only FIFO, and cold-resumes from the durable descriptor. Exact live direct-parent identity authorizes parent-to-child delivery. Exact live child identity authorizes reports; the manager derives the recipient from durable `parentSession`, and `MessageSource` records the sender without granting authority. Interrupt authority is deliberately wider than delivery authority: a human presents the durable direct-parent address so a live child stays stoppable while its parent Agent is offline, and any exact live ancestor recorded in the Activation's materialization lineage may stop its descendant, because stopping a turn is idempotent and delivers no content.

When `ctx.sessionProjections` is available, the service registers two projection units. `subagentTiming` resets at each descriptor so a fork seed's ancestor work cannot enter the child's total, then accumulates `turn/start` → `turn/end` active time and retains same-cut `active.since` and `active.through` bounds for an open turn; while that turn remains open, `active.through` follows the latest folded event, giving an inactive consumer a conservative crash bound without mixing in newer session metadata. `subagent` folds the durable identity — mode plus creation label — from `subagent/descriptor` events with the same last-wins reset discipline, so a fork seed's ancestor descriptor stands only until the child's own overrides it; a malformed or unrecognized-version payload folds to the serializable `null` sentinel — indistinguishable from a log with no descriptor, and surviving every JSON push frame so a consumer replaces a stale identity instead of keeping it — and never throws.

`registerContinuableSetup()` lets optional packages add child-scoped capabilities without teaching the continuation manager their names. Contributions install synchronously before Activation publication, roll back with failed setup, and are released with the child scope. New grants wait for the next Activation, while contribution removal revokes every resident installation immediately.

## Collection model

The model-facing tool collects synchronously by default: it awaits the child result and disposes the run before returning. One-shot background delegation registers a plain Task in the tool, whose generic status, collection, and cancellation tools own later interaction, and persists its model-supplied `description` as the optional display label. Continuable background delegation calls `ctx.subagents.startContinuable()` and returns only the durable child id; the child owns its own turns from inbox acceptance, so there is no Task and no result promise — a caller sends later work with the `send_message` follow-up tool, and `interrupt()` stops only the current turn without disposing the child, and the durable child Session remains the source of the child's detailed output. The continuation manager exists only while `ctx.agents` is available, and session persistence is resolved per continuation operation. Independently, `listChildren()` enumerates the live-preferred merge of the live session store and optional session persistence — live-only when persistence is absent, since a cold child cannot be resumed then either — and serves each child's durable mode/label from the registered `subagent` projection unit: the registry's watermark snapshot for a live child; for a cold one, a durable projection-cache row when it serves an own-suffix identity — its `seq` gate proves the value postdates the fork seed, where a child's own descriptor is immutable once appended — else one bounded-concurrency persistence inspection folded through the registry, whose result must still name the enumerated lifecycle (a re-published id degrades to a `corrupt` diagnostic). A throwing cache read renders no verdict — the cache is derived data — and silently falls through to that authoritative re-fold. The projection fold is the single classification authority; listing parses no descriptor itself. A served identity produces a child row; a settled candidate whose fold served no identity is a `corrupt` diagnostic, a failed inspection is a transient `unavailable` retried on the next listing, and a running candidate without an identity yet is omitted (the creation window before its descriptor is appended). It never consults the continuation manager, Agent registrations, Activations, or providers. Each child row derives its read-time `hasChildren` hint from merged headers carrying durable `origin: 'subagent'`; it does not read descendant event logs, and the descriptor-backed child catalog remains authoritative when expanded. Service consumers such as a UI can retain both modes and choose a fallback for an unlabeled one-shot child; the model-facing `list_agents` tool projects only `continuable` entries and refines status through the live Agent registry and maps storage-only to its resumable-not-terminal `ready` (`running`/`idle`/`ready`) and walks `listDescendants()` for its `descendants` scope. The listing forwards the caller's signal to every persistence read, checks cancellation around each of those awaits, and reports every observed abort as `SubagentError` code `CANCELLED`; an unmounted projection registry fails loud with `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`, and a missing session store with `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`. See the [background subagent tasks Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md), the [continuable background subagents Agent Note](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md), the [durable catalog Agent Note](../../../.agents/notes/implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.md), the [merged-service Agent Note](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md), the [capability-seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md), and `src/types.ts` for the complete contracts.

Continuable Activations await a best-effort final session flush without treating listener participation as durability confirmation. One-shot runs retain best-effort session checkpointing, so a completed one-shot child is discoverable after disposal only when its session actually reached persistence; the service does not invent a catalog entry from Task history when that checkpoint is absent.

-----

<a id="model-experience"></a>
## Model Experience

### Settlement notice

#### What the model sees

One user-role parent message opening with the outcome — `Background subagent <child-id> finished and will do no further work unless you send it more.`, or the matching line for a child that was stopped, ran out of room, declined, or failed — followed by `Its closing message:` and the child's final assistant content, or `It left no closing message.` when it produced none. This is the service's only direct parent-side contribution; delegation schemas, parent continuation and discovery, and the child-scoped `report` belong to `dsh-tool-subagent`, `dsh-tool-subagent-control`, and `dsh-tool-subagent-report`.

#### Token effect

One notice per settled Activation in the parent's request, sized by the child's final message. A child that both reports and settles costs the parent both.

#### KV Cache effect

Append-only in the parent: the notice follows its reusable request prefix. Reaching an idle parent starts one independent model request; reaching a busy one does not.

### Child delegation-scope statement

#### What the model sees

Every in-process child's runtime-context snapshot carries the `subagent:delegation` statement below, after the sandbox-policy and approval-policy sentences.

##### The delegation-scope statement

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token effect

One fixed statement in each child's runtime-context snapshot; none in the parent's requests.

#### KV Cache effect

Prefix-stable within a child: the statement never changes during the child's lifetime, so it is written once into the first runtime-context snapshot. Parent-side, no direct invalidation; the named tool consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special operational care. They are current package constraints, not a general delegation comparison or a task backlog.

- **ACP children remain one-shot and are not trace-enumerable** — an ACP run has no local child session in the parent's session corpus, and remote providers need an Activation ownership contract before they can support continuable children.
- **No host-user continuation** — `followup()` requires the exact live direct parent; only `interrupt()` accepts a durable human parent address.
- **Continuation messages never steer** — parent-to-child follow-ups enqueue later turns; they never redirect the child's current turn.
- **Wake gap during cancellation convergence** — a follow-up accepted after an interrupt signal but before the driver becomes idle stays queued until another waking send.
- **Process-local residency** — the Activation inbox and ownership graph do not coordinate two harness processes; concurrent access to one persistence store needs a durable mailbox and cross-process lease protocol.
- **No replay of accepted-but-unlogged messages** — a crash can lose an accepted prompt that never reached the child's session log; the lost message is not replayed automatically.
- **No durable report mailbox** — reports require a live direct parent and provide acceptance identity rather than exactly-once delivery.
- **Lifecycle events are observe-only** — a run-affecting `subagent/end` continuation or decision API waits for a concrete consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Cross-process continuation** — a durable mailbox and lease protocol would let two harness processes share one persistence store.
- **Continuable ACP children** — requires persisting the remote session id and a per-child continuation advertisement.
- **Host-user delivery** — a future host adapter needs a concrete authenticated interaction before the seam gains a user delivery capability.

</details>
