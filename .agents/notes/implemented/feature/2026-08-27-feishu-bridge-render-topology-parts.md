# Agent Note: Topology-routing CSS parts for plan/reply render diagrams

Status: implemented

English | [中文](2026-08-27-feishu-bridge-render-topology-parts.zh.md)

## Problem

The plan/reply HTML render cards had collapsed into visually flat diagrams: after the 2026-07-16 reliability convergence (CC-connect era), the render skill steered every common topology to exactly three CSS parts — `.flow`/`.layers`/`.diff`, each a row of text chips with CSS arrows — and discouraged hand-drawn SVG elsewhere. Of 270 August 2026 renders preserved under `~/.claude/plans/`, 206 were these three-part strips and 50 had no diagram at all; the user judged the illustrations "too simple". The middle tier of complexity (branching flows, hub-and-spoke, stage progression) had no reachable path: CSS parts were too simple, hand-drawn SVG was discouraged, and the skill's "complex diagrams call the draw skill" pointer was dead — the render fork denies the `skill` tool (0 of 464 historical renders used kroki/mermaid).

## Decision

Expand the deterministic part vocabulary from 3 to 13 topologies, in `diagramCSS` (`packages/acp/feishu-bridge/src/engine/plan-render-templates.ts`) plus a topology routing table in `skills/feishu-bridge-render/SKILL.md` that maps each topology to one part with a node-count cap: `.flow` (+ `data-if` conditional labels), `.flow-v` (vertical trunk + fan-out branches), `.hub` (center + satellites), `.stages`, `.stages-v`, `.timeline`, `.lanes`, `.tree`, `.cycle`, `.kanban`, plus the legacy `.layers`/`.diff`. The model still fills semantic text only; CSS does layout and draws connectors. Hand-drawn SVG remains a narrow gate for true graphs (meshes, multi-actor sequences, ER), and the dead draw-skill references are deleted from the skill.

**Part-design red line:** connectors must be structural elements — explicit `<b></b>` arrow elements in `.flow-v`, a real `<i class="stem">` plus the satellite container's `border-top` bus in `.hub`, pairwise circle-to-circle segments in `.stages` — never negative-margin absolute pseudo-element line assembly whose coordinates are guessed. Assembly is verified by browser geometry assertions (Playwright `getBoundingClientRect`: stem ends flush with bus and center, bus spans every tick, arrows centered and adjacent to both nodes, per-level tree indent exact to the pixel, no horizontal overflow), not by vision models — a vision-model self-check falsely approved broken connectors that the user immediately saw.

## Alternatives considered

- **Relax the skill toward hand-drawn SVG.** Rejected: it re-runs the July cycle (expressiveness → overflow/overlap → crackdown). The Go-era auto font-shrink post-processing was never ported to the TS engine — only `ensureSVGViewBox`/`sanitizeSVGVars` survived — and the 2026-07-16 convergence was decided the same day that fallback landed, so the fallback's presence did not save hand-drawing even when it existed. A low-effort render model following a prompt-side font-size formula is exactly the original failure mode.
- **Route complex topologies through diagram-render (kroki.io/mermaid.ink).** Rejected: it puts a network dependency on the render path that already had a kroki-overload incident, and the render session cannot splice rendered SVG into its fragment without new machinery. The render pipeline stays network-free by design.
- **Raise the render session's reasoning effort.** Rejected by the user: effort `low` is a deliberate speed tradeoff.

## Consequences

Diagram expressiveness now comes from part vocabulary, not from relaxing coordinate math, so reliability and expressiveness stop being a trade-off. The markup contract grew structural elements (`<b></b>` between `.flow-v` content elements, the three-segment `.hub` structure); the SKILL.md examples pin them, and omitting one degrades gracefully (nodes render, connectors disappear) rather than corrupting the layout. The expressiveness ceiling stays below real SVG for genuinely graph-like topologies — an intentional cut; a local layout engine would be a separate proposal. Node-count caps are per part and enforced by the routing table prose; exceeding them routes to the neighboring form or the hand-drawn gate.

## Testing

`tests/engine/plan-render.spec.ts` asserts the eleven new part selectors and their tokens reach both templates through the shared `{{DIAGRAM_CSS}}` slot (89 tests green). A one-off Playwright geometry script (45 checks) validated the shipped `diagramCSS` string on an all-parts page assembled with the real plan template and Lucide sprite; demo PNGs went to the user for visual sign-off. The same page doubles as the reference for future part additions: any new connector must pass geometry assertions before landing.
