# Agent Note: Plain-language output mandate joins the agent-conventions section

Status: implemented

English | [中文](2026-09-09-feishu-bridge-plain-language-conventions.zh.md)

## Problem

The user's plain-language reply convention (「白话直讲」: expand jargon into plain words, back statements with facts and numbers) lived in the machine-local global instruction file (`~/.claude/CLAUDE.md`). A 16-plan-session audit (2026-09-07..09-09) found the rule injected into every plan-writing session while plan output stayed implementation-dense: 8–66 code identifiers per plan, no plan carried a plain-language section, and every plan entered code detail or unexpanded jargon within three lines. The failure is a prompt-tier inequality, not delivery: workspace instructions ride a user-role system-reminder whose preamble states they do not override system/developer instructions, they precede ~17k characters of repository conventions, and plan shape is dictated by the system-level `plan:policy` section (decision-complete; "another engineer can implement it without making design decisions"). The same audit showed why the fix must not delete detail: the plan is the approver's primary reading surface and the durable carrier of design decisions — exploration residue is pruned over turns, subtask children receive only parent-written briefs, and no execution-time design re-derivation exists.

## Decision

A 「白话直讲」 block ships inside `agentConventionsPrompt()` (`engine/agent-conventions.ts`), extending the [agent-conventions prompt section](2026-08-24-feishu-bridge-agent-conventions-prompt.md) (order 10; plain sessions only — subtask children and chatroom personas stay excluded). The mandate covers all user-visible output (replies, plans, reports) and pins a two-layer plan structure: a plain-language layer first — problem, approach, expected outcome, verification, explicit out-of-scope — with decisions pinned (scope, numbers, acceptance criteria; vague verbs like 「适当优化」 banned) and no implementation identifiers (file paths, function names, event names; module names at most); then an implementation-details layer at full engineering density. Layering, never deletion: the plain layer serves approval, the details layer serves execution. A self-check closes the block: extract the plain layer and read it alone; rewrite it if a non-codereader cannot follow it.

The machine-local global-instruction entry retires once this section is confirmed delivered (the global file hot-reloads; the system section needs build + manual /reload — deleting before the reload opens a window with no rule at all). The bridge deployment is the rule's only audience, per the user's scoping decision: Claude Code, dsh CLI/web, and subtask children run without it.

## Alternatives considered

**Amend the `plan:policy` section (`feishu-bridge/cordis.patch.yml`).** Lost as the first move: it adds a fifth transformation to an upstream-lockstep-managed text (`bundle-patch.spec.ts` pins the delta set) and leaves non-plan replies untouched. Kept as escalation tier two if new-session compliance misses target; the anchor sentence and insert text are prepared.

**Rewrite the global-instruction entry.** Lost: it is the tier that failed — a user-level reminder explicitly cannot override the system-level plan guidance — and the file reaches scopes the user scoped out of this decision.

**Amend the exit_plan_mode tool description.** Lost: the most proximate lever sits in upstream shared plugin code; the divergence exceeds the bridge-local scope. Escalation tier three.

**Promote the plain-language plan-render overview to the primary approval surface.** Lost: the render fork is asynchronous (approval would wait on rendering), render failure needs a fallback path, the full-plan card still floods the chat, and replies stay jargon-heavy.

## Consequences

Cost: every plain session's fixed system-prompt prefix grows by ~450 CJK characters (to ~1550); plans grow a plain-language layer; GLM-5.3's compliance with the two-layer structure is unknown until measured — the acceptance gate samples new sessions only (≥5 plans across groups; plain-layer presence target ≥60%; implementation-layer identifier density not below the 8–66 baseline), per the TDD-mandate retest precedent. Scopes outside the bridge run without any plain-language rule once the global entry retires — accepted by the user's scoping decision. Bought: the mandate sits at the same prompt tier as the plan guidance it counters, ships with git pull + build on every bridge machine, and the two-layer rule preserves the executor's technical detail while giving the approver a readable layer.

## Testing

`tests/agent-dsh/adapter-persona.spec.ts` pins the conventions section verbatim, new block included; `tests/engine/followups.spec.ts` keeps pinning the followups contract against `agentConventionsPrompt()`.
