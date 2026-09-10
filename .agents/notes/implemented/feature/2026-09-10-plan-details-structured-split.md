# Agent Note: Structured plan layering — the details argument and the collapsed-by-default Feishu card

Status: implemented

English | [中文](2026-09-10-plan-details-structured-split.zh.md)

## Problem

The [plain-language conventions](2026-09-09-feishu-bridge-plain-language-conventions.md) pin plans to two layers (plain / implementation detail), but the structure lived only in prompts: `exit_plan_mode` takes a single `plan` string, both layers riding one markdown blob. The Feishu plan content card (`engine/plan-render.ts` `sendPlanCard`) stuffs that whole blob into one markdown element — a long plan scrolls the plain layer off the screen before the approver reaches the decisions. Rendering "plain layer expanded, details collapsed" requires the renderer to obtain the layer boundary **without parsing**; any heading-text/prefix/regex split treats a heading string as a contract and breaks the moment the language or the model's phrasing changes.

## Decision

Layering moved from prompt convention to tool-argument structure; presenters read fields, nothing is parsed:

- **Upstream shared packages (additive fork-local, to be proposed upstream once stable)**: `exit_plan_mode` gains an optional `details: string` parameter (description stays policy-free — the mechanism is "implementation-detail annex; capable UIs present it collapsed by default", the layering policy remains deployment-owned prompting). The plan-review intent of `dsh-user-questions` gains optional `layers?: { plain, details }`, matching the type's existing presentation-only semantics. execute normalizes a blank `details` to not-submitted; the review question's `detail` carries both layers concatenated (`plan + '\n\n' + details`, so generic consumers such as web/CLI see the complete plan unchanged), and the intent carries `layers` only when `details` was submitted.
- **Feishu bridge rendering**: the adapter's `answerPlanReview` passes `layers` from the intent through; the engine threads `layers` down to `sendPlanCard` **unless the agent-written plan file override applies**, building the card as `[markdown(plain), collapsiblePanel(implementation details, expanded:false, markdown(details)), actions(export)]` — `collapsible_panel` is an off-the-shelf schema 2.0 component (in production as the "▸ 详细信息" footer on every completion card). Without `layers` the card stays a single markdown block (old path and old sessions unchanged). The export button, the PNG render, the persisted plan file, and the permission card keep consuming the concatenated text.
- **Boundary rule**: when the agent wrote a plan file this round and the fresher-file override applies, the card shows that file as one block — that path has no layer structure and is not force-split.
- **Prompting**: the agent-conventions "plain-language" plan paragraph now maps the layers onto the two arguments (plain layer into `plan`, implementation layer into `details`); the layers' substance and the self-check sentence are unchanged.

## Alternatives considered

**Splitting on a `## 实施细节` heading via markdown AST in the bridge.** Rejected: a heading string is not a contract (language, phrasing, model drift all break it) and every renderer would re-implement the split — the user explicitly rejected prefix/regex-class approaches.

**Re-registering or wrapping the exit_plan_mode tool in the bridge.** Rejected: registration conflicts with plan-mode, HMR-fragile, a dirty way to alter upstream behavior.

**A `collapsed` content marker in the generic card presentation model (dsh-tools presentCall).** Deferred: it would let web and other surfaces share the collapse semantics, but this change targets only the Feishu plan card; the structure makes it easy to add later.

**Making `details` required.** Deferred: required would mechanically guarantee layering, but this shared upstream tool serves every deployment; land it optional with prompt guidance first, and escalate to required if the sampling retest shows poor fill-rate (the README records the escalation path).

## Consequences

- Robustness layers: structure = contract (tool schema), semantics = guidance (prompting), failure mode = graceful degradation (no `details` → the card falls back to the single block, zero content loss).
- Per-request token cost: the tool stays in the request catalog (entering or leaving plan mode swaps only the prompt section), description plus parameter text adding a few dozen tokens per request.
- Session-log compatibility: `tool/call`'s `arguments` is the raw JSON string, so the new field is purely additive — the event schema is unchanged, `SESSION_FORMAT_VERSION` is not bumped, and old recorded replays are unaffected. Post-approval execution is unaffected (the model reads its own tool call from the conversation history; both arguments are fully visible).
- Known behavior: the render-status PATCH after the PNG render (`cloneCardWithStatusNote`) preserves the panel's content, but the client may reset a user-expanded panel back to collapsed — minor UX, accepted after the smoke check.
- When layers land swapped (detail written into `plan`), the collapsed panel holds the wrong content but no data is lost; this joins the existing sampling retest (details fill-rate plus plain-layer presence).

## Testing

`packages/plan/plan-mode/tests/plan-mode.spec.ts`: detail concatenation and intent shape across the with/without/blank `details` paths (the exact assertion at :1069 stays green) plus the two-part presentCall. `packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts`: `intent.layers` pass-through and unchanged absence. `tests/engine/engine-m3-plan.spec.ts`: layered card structure (`expanded:false`, panel title, export button), no-`layers` regression guard, per-layer truncation. `tests/agent-dsh/adapter-persona.spec.ts`: verbatim pin of the two-argument wording.
