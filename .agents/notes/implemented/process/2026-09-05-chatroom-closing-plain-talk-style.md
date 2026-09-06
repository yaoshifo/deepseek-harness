# Agent Note: Chatroom closing artifacts switched from Feynman analogy to plain talk

Status: implemented

English | [中文](2026-09-05-chatroom-closing-plain-talk-style.zh.md)

## Problem

Both moderator primings (plain and research) asked the closing HTML brief and the closing text summary to lead with a life analogy ("这件事就像……") — the Feynman framing. Reader feedback showed the analogy adds a mapping burden instead of removing one: the reader must first understand the analogy scene, then map its parts back to the actual discussion, before any of it lands. The closing artifacts exist to hand the user a complete picture quickly; the analogy layer spent the first screen on a detour.

## Decision

The closing HTML briefs and text summaries in `chatroom-priming.ts` now prescribe plain talk: state the thing itself (what problem the discussion solved, the main judgment, where sides lean, where honest disagreement remains), expand jargon into plain wording in place, and support points with concrete facts and numbers from the discussion itself. Layer 2's "minimal example (daily scene)" became "minimal instance grounded in the discussion's own facts, numbers, or scenes", so instances can only grow out of the material. Prompting is purely positive — no "don't use analogies" negation — because the positive instance-source rule leaves an analogy nowhere to take root. The analogy-adjacent structure is kept: expand/collapse layering, 2-3 threshold points, ⚠ counter-intuitive flags, the disagreement list, and the fidelity floor of folded raw detail. The academic-version briefs are untouched.

Why the style definition is inlined rather than referencing the user-global `~/.dsh/AGENTS.md` reply preference: the moderator and role sessions are bare-persona sessions whose setup replaces the whole system prompt and calls `agentInstructions.suppress()` (Go `--bare` parity; see [session-start-options](2026-08-24-feishu-bridge-session-start-options.md) and [render-fork-suppresses-instructions](2026-08-26-render-fork-suppresses-instructions.md)), so the global rule never reaches the moderator. The brief also remains the HTML-rendering subtask's task statement; inlining keeps the style authoritative on the path that matters.

## Alternatives considered

**Reuse the user-global plain-talk rule by reference.** Rejected: bare-persona suppression means the moderator never sees it (verified against the adapter suppression path during planning).

**Keep the analogy as an optional opener and add "don't over-do it".** Rejected: negation-style prompting steers attention back to the banned concept and the analogy still costs the first screen when used.

## Consequences

Closing summaries and summary.html lead with the judgment itself; readers no longer translate through an analogy layer. The plain/research primings and the gather spec now assert `白话直讲版` / `直接讲事情本身` / `最小实例` and ban `费曼` / `生活类比`. cc-connect (the Go origin of these texts) is unmaintained and was left alone, so the two trees have diverged on this decision by design.
