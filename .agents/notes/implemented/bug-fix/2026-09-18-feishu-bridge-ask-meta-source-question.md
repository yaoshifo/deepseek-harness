# Agent Note: The send-time card cache reads the source question, not a card-face reconstruction

Status: implemented

English | [中文](2026-09-18-feishu-bridge-ask-meta-source-question.zh.md)

## Problem

The platform caches a question card's prompt at send time (`cacheAskqMeta`, `src/feishu/platform.ts`) because a submit callback cannot carry the card: a form submit drops `action.value`, and a button click returns only the clicked option. The cache was filled by reconstructing the question off the rendered card model (`askCardMeta`), which can only map what the card face renders — `{label, description}` per checker option.

The [locator loss](../feature/2026-09-17-feishu-bridge-followups-locator-split.md) was the first symptom: a field deliberately kept off the card face never reached the cache, the persisted sidecar, or the dispatched `[后续处理]` message (live: zero `📍` lines across a whole session log). The [details layer](../feature/2026-09-18-feishu-bridge-followups-details-layer.md) fixed that instance by moving the field onto the face, but left the mechanism intact: any future option field the face does not render is dropped the same way, and the reconstruction also loses `recommended` today.

## Decision

The card carries its source question, and the cache prefers it.

- `Card` gains a private `#askQuestion` field with `setAskQuestion()` / `askQuestion()`: never rendered, and unreachable from `JSON.stringify` or a spread, so it cannot leak into a card payload.
- `buildAskQuestionCard` and `buildFollowupsCard` attach the question they render (`src/engine/ask.ts`).
- `cacheAskqMeta` overwrites the reconstruction with `card.askQuestion()` when present; `askCardMeta` stays as the classifier (is this a question prompt, and at which ask position) and as the fallback for cards built without a source question.
- Because the data rides the card, both send egresses — `sendCard` and the threaded-reply `replyCard` path — cache the source question without threading an extra argument through each method, and every future egress inherits the guarantee.

## Alternatives considered

- **Pass the question as an extra `sendCard` argument.** Rejected: `sendCard` hands a threaded reply to `replyCard`, which records the cache a second time, so the argument would have to thread through `CardSender.sendCard` and `CardSender.replyCard` both — and through every future egress. A card-carried field makes the guarantee structural instead.
- **Drop the card-face reconstruction entirely.** Rejected: the reconstruction doubles as the classifier (is this a question card? which ask position?) and still serves question cards built outside the engine's builders.

## Consequences

- The cached question is the object the card was built from — `recommended` and any future option field survive regardless of what the face renders.
- `Card.askQuestion()` is process-local state: a card that crosses a process or serialization boundary loses it and degrades to the reconstruction, i.e. exactly the previous behavior.
- Testing: `tests/feishu/card-action.spec.ts` pins deep equality of the cached question for a followups card and an ask card through `sendCard`, and for the threaded-reply egress.
