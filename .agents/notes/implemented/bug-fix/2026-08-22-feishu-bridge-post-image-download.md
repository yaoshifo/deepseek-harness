# Agent Note: post-embedded images never downloaded on the feishu event path

Status: implemented

English | [中文](2026-08-22-feishu-bridge-post-image-download.zh.md)

## Problem

A user sends image+text as one Feishu message — delivered as a rich-text `post` whose `img` elements carry an `image_key`. On the WS event path the post branch of `onMessage` extracted text only: `extractPostPlainText` replaces every `img` element with the literal `[image]` placeholder and the message was dispatched with `images: []`. The agent received `"[image]\n看下这个图"` with no file path and could not find the picture (verified in live session `cc-20260822-135313`, workspace `/Users/hm/workspace/chat`: the `.feishu-bridge` staging directory never existed). The asymmetry: pure `image` messages download via `dispatchImageMessage`, monitor-path card images download via `downloadCardImages`, and the poll path even picks up post image keys incidentally (the `extractCardImageKeys` regex runs over any content JSON) — only the event-path post branch dropped them.

## Decision

The post branch downloads its embedded images and attaches them like a pure image message. `extractPostImageKeys` (src/feishu/extract.ts) walks the parsed post body and returns deduped `image_key` values in document order — structural traversal, unlike `extractCardImageKeys`' regex, because the post payload is already parsed there. `dispatchPostMessage` (src/feishu/platform.ts) extracts the text (keeping the `[image]` placeholders so image position survives), downloads each key through the existing `downloadImage` (message-resource API), and dispatches via `dispatchWithQuote`, which gained an optional `images` parameter. Downloads are capped at 9 and a failed download is logged and skipped — the text still flows through — mirroring `downloadCardImages`. The model-visible surface is unchanged: the adapter saves the bytes under `.feishu-bridge/attachments` and appends `(Images saved locally, please read them: <paths>)`, exactly like pure image messages.

## Alternatives considered

**Keep the `[image]` placeholder and make the agent fetch the image via the lark tool.** Rejected: the agent would need the `image_key`, which the placeholder does not carry, and the bytes are already reachable through the message-resource API the platform owns — pushing that onto the agent duplicates platform plumbing per turn.

**Reuse `extractCardImageKeys`' regex over the raw post JSON.** Rejected: the post content is already JSON-parsed by `parsePostBody`; a regex over the serialized form works (the poll path proves it) but is needlessly indirect and locale-wrapper-sensitive when a structural walk is one loop away.

**Dispatch post text immediately and stage images separately.** Rejected: the staging channel (pending directory spliced into the next text message) exists for pure-attachment messages that carry no text; a post carries its own text, so its images belong in the same turn — the same dispatch, the same `(Images saved locally, ...)` note.

## Consequences

Image+text posts reach the agent as text plus locally saved image paths; a download failure degrades to text-only instead of dropping the message. The poll path needed no change — `downloadCardImages` already matches post image keys with its regex; a regression test now pins that incidental coverage. `[image]` placeholders remain in the extracted text, so multi-image posts still show where each image sat relative to the text. Sticker-only and other msg types are unaffected.

## Testing

`tests/feishu/platform.spec.ts`: `extractPostImageKeys` unit cases (order, locale wrapper, dedup, none, empty key, invalid JSON) plus dispatch cases — post with an embedded image dispatches text plus downloaded bytes, a failed download skips that image but still dispatches, and an image-only post dispatches as an attachment message. `tests/feishu/monitor-poll.spec.ts`: the poll path attaches embedded post images (passes against the pre-existing regex behavior, kept as a guard). Package suite 2060 green, oxlint/typecheck 0.
