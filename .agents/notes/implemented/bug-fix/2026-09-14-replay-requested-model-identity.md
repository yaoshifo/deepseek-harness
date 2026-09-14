# Agent Note: Replay gateway history under the requested model identity

Status: implemented

English | [中文](2026-09-14-replay-requested-model-identity.zh.md)

## Problem

Long multi-step sessions on gateway routes (`anthropic-messages` behind mify: request id `zhipuai/glm-5.3`, reported model `glm-5.3`) progressively moved the model's working deliberation out of the thinking channel into ordinary text blocks, which the Feishu progress card's live narration area then displayed as if they were user-facing prose (oc_084673f seq 333, a 667-rune geometry-deliberation block, quoted verbatim by the user). The mechanism, verified end to end on 2026-09-14:

1. `replayedAssistant` (7bab91d247, merged into dev 2026-09-08) stamps the provider-reported model on replayed `anthropic-messages` assistant history, so pi-ai's cross-model signature rules apply to Anthropic alias/fallback history.
2. A gateway whose route id must carry a vendor prefix while its reported name does not therefore mismatches on **every** message: `transformMessages` sees `model: 'glm-5.3'` history against a `zhipuai/glm-5.3` request and judges the history cross-model.
3. Cross-model replay converts every thinking block to plain text — signature present or not (`allowEmptySignature` only governs the separate missing-signature path, which never triggered here: signatures were recorded in the replay state all along).
4. The model reads its own prior reasoning as text turn after turn, imitates the pattern, and migrates deliberation into the text channel. The loop needs accumulated turns to take hold, which is why short sessions looked clean and long ones leaked — matching the 2026-09-10 intra-session gradient observation.

Evidence: source-level reproduction with the leaking session's own replay state (thinking block → text on the wire under the default stamp, preserved under the fix); dev-server control group (same code, same pi-ai, direct zhipu route whose bare ids match — 148 sessions over five days with near-zero migration vs 356 migration blocks across 480 mify sessions, 87×); gateway probes (mify accepts signed and empty-signature thinking replay, rejects bare unprefixed model ids, so the route id cannot be renamed instead).

The 2026-09-10 investigation of the same symptom concluded "mify returns unsigned thinking" and parked `allowEmptySignature` as the stopgap. That diagnosis checked the content block for a `signature` field, but dsh stores signatures in `source.replayState.blocks[].thinkingSignature` — they were present the whole time. The recorded root cause and the stopgap are both inoperative against the actual mechanism.

## Decision

A route-level profile field `replayModelIdentity: 'requested' | 'resolved'` (default `'resolved'`) selects which model identity replayed assistant messages carry. `'requested'` stamps the requested id of the time, making a differently-spelled same-model gateway replay as same-model: pi-ai keeps its thinking blocks with their signatures and the feedback loop closes. Only the `anthropic-messages` branch reads the switch; Completions replay always used the requested id. The mify-dsh live route sets `'requested'`.

The default stays `'resolved'` because upstream's stamp exists for real Anthropic alias and fallback history, where pi-ai's cross-model conversion is protective: a fallback model's thinking signature is not valid for the primary model, and converting to text is the safe replay. A gateway name mismatch is a deployment fact only the route owner can state, which is why this is configuration rather than a behavior change for everyone.

## Alternatives considered

- **Replay the requested id unconditionally (revert the 7bab91d247 stamp).** Rejected: it regresses the genuine fallback case the stamp protects and diverges from upstream behavior for every deployment, for a problem only differently-named gateway routes have.
- **Rename the route's model ids to the gateway's reported names.** Impossible: mify rejects unprefixed model ids on requests (probed: 401 "该模型未指定供应商"), and the route id is the wire `params.model`.
- **Fix pi-ai's `transformMessages` to treat name-similar models as same-model.** Not actionable from this repository: pi-ai is an npm dependency, and no naming heuristic can distinguish an alias of the same model from a fallback to a different one. The opt-in switch states the fact only the deployment knows; proposing a fail-loud signature-preserving replay to pi-ai upstream remains open.
- **Filter deliberation-looking text blocks in the Feishu card display.** Rejected 2026-09-10 by the product owner (display layer stays as designed) and it would not fix the underlying channel migration, which also degrades reply quality and inflates replayed context.

## Consequences

- The mify-dsh route's history replays as same-model with signatures; its models' thinking stays in the thinking channel instead of migrating to text. Existing sessions need no migration: the replay state has always recorded the requested id.
- Anthropic alias/fallback behavior is unchanged (default `'resolved'`); the switch is inert on Completions routes.
- A gateway that later starts rejecting signed thinking replay fails loud with a provider 400; rolling back is deleting one profile line.
- Tests: `convert.spec.ts` locks the three behaviors — `'requested'` preserves thinking through `transformMessages` (the fix), the default stamps the reported model (upstream behavior), and Completions replay ignores the switch.
- Upstreaming: the alias-vs-gateway distinction is a pi-ai-level blind spot worth proposing upstream once the fork's opt-in has production miles on it.
