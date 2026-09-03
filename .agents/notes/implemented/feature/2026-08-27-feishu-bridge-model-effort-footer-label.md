# Agent Note: Feishu bridge status-footer model·effort label

Status: implemented

English | [中文](2026-08-27-feishu-bridge-model-effort-footer-label.zh.md)

## Problem

The completion notification card's 🤖 line showed only the model name and the permission-mode label, so two sessions of the same bot running different reasoning levels rendered identically; the card gave readers no way to see which effort the active route declares. The feishu-bridge config could not express the deployment's real level either: `agent.reasoningEffort` rejected `'max'`, while the shipped glm gateways run thinking levels low/high/max (their catalog has no medium mapping).

## Decision

Both footer builders render the 🤖 line through one shared `formatModelLine`: `🤖 <model>·<effort>[ · <mode>]`. The effort joins tightly onto the model — matching the pinned product example `zhipuai/glm-5.3-flash·max` — and the pre-existing spaced mode segment is appended unchanged after it. The effort text comes from the dsh adapter's existing `getReasoningEffort()` probe, i.e. the active provider route's configured value (Go GetReasoningEffort parity). Agents without that capability, or with an empty configured effort, render byte-for-byte as before.

The display source is the route configuration, deliberately not the llm runtime's effective default: the route row is where an operator declares what their agents run at, the same explicit surface `getModel()` reads, so the label needs no new core-service dependency in the bridge. `agent.reasoningEffort` is a **project-level** setting injected onto **every** route at assembly — a runtime `/provider` switch only pins the chat's route override without rebuilding routes (see [per-chat provider routes](2026-09-03-feishu-bridge-per-chat-provider-routes.md)), so the injection must cover all routes for both the label and the explicit agent-creation effort to survive a switch. Keeping them truthful requires maintaining one consistency rule by hand: `agent.reasoningEffort` must equal the pi-ai provider-level `reasoning:` default for the same gateway (both are `max` in the shipped profile).

Config: the `agent.reasoningEffort` union now lists `'off' | 'low' | 'medium' | 'high' | 'max'` — it gains `'max'`, which no glm gateway accepted before, and drops `'minimal'`, a level no adapter has ever advertised; anything else still fails loud at load.

## Alternatives considered

**Probe the effective effort from the llm runtime (per-model `defaultEffort`).** Rejected: the bridge consumes only structural `ctx.agents`/`ctx.on` slices today; reading model catalogs adds a service dependency plus async resolution and caching inside the footer path, and desynchronization from the provider default would become invisible instead of loud. It also bypasses the operator-declared surface the reply footer already mirrors.

**Restyle the whole line to spaced separators (` · max`).** Rejected: the request pinned the tight form `glm-5.3-flash·max` literally, and re-spacing the mode segment would churn card output beyond the asked change.

**Ship nothing when the route omits the effort and rely on the gateway default alone.** That empty-effort behavior ships, but only as the fallback — routing the feature through provider defaults exclusively would have left it unobservable in the deployment that requested it, since those profiles carry no route-level effort yet.

## Consequences

Every card sharing the status footer (completion notification, /new, spawn notifications) identifies the declared effort next to the model. Bots whose routes declare no effort are visually unchanged, which is correct for gateways without thinking control. Package vitest specs pin the three render branches — tight effort, empty-effort regression, mode ordering — and the effort-bearing collapsible panel title. The vocabulary of allowed levels stays owned by the llm adapters per [adapter-owned reasoning effort capabilities](../../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md); this decision only selects what the bridge displays.
