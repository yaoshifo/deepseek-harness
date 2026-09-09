# Agent Note: Upload deadlines sized by payload, not the small-request timeout

Status: implemented

English | [中文](2026-09-09-feishu-upload-deadline-sizing.zh.md)

## Problem

Delivering MB-size attachments through `feishu_bridge_send` failed nine-for-nine in production (three PDFs, 4.9–10.7 MB, every attempt dying with `context deadline exceeded` after ~125 s), while small requests on the same link succeeded in milliseconds. The cause stacks two facts. First, the host's uplink to the Feishu CDN swings between 2.6 KB/s and 384 KB/s across minutes (measured; TLS/RTT to `open.feishu.cn` stays at tens of ms, DNS is clean, and Cloudflare gets a stable 237 KB/s — the degradation is path-specific, not host-wide), so an MB body needs minutes inside a slow window. Second, uploads shared the 30 s per-attempt deadline `retryTiming.requestTimeout` — a faithful port of Go's `feishuRequestTimeout`, sized for card PATCHes and replies — and the deadline race abandons the HTTP call without cancelling it (the node-sdk `IRequestOptions` carries no `signal`), so each retry stacked another concurrent upload onto the same starving pipe.

## Decision

`withTransientRetry` takes an optional `attemptTimeoutMs` that overrides the global per-attempt deadline for that call alone, and the platform sizes it for uploads: `min(max(requestTimeout, ceil(size / uploadMinBytesPerSec) · 1s), uploadMaxDeadlineMs)`, with both knobs top-level plugin config (`uploadMinBytesPerSec` default 16384 — the measured slow-window floor; `uploadMaxDeadlineMs` default 900000). File size is a known fact; the pacing floor is the only assumption, so it stays a deployment-tunable rather than code. At the defaults a 4.9 MB body gets a 5.1-minute attempt and a 10.7 MB body 11.2 minutes, well inside the 2-hour turn cap, while a few-hundred-KB image keeps the 30 s deadline.

## Alternatives considered

- **Raising the global `requestTimeout`:** rejected — it slows fail-fast for every small request and still cannot fit a 10.7 MB body on a truly slow window without becoming unbounded.
- **Bypassing the node-sdk with a hand-rolled multipart fetch to gain `AbortSignal` cancellation:** rejected for now — it imports an entire upload implementation to buy cancellation; deadline sizing already lets slow-window uploads finish. Recorded as the upgrade path if stale-upload overlap ever proves costly.
- **Fixing the link (bandwidth upgrade, CDN pinning):** out of code's reach — deployment-side; the tunables absorb what the link delivers.

## Consequences

- Two behavior tests pin the seam: a per-call `attemptTimeoutMs` outlives the global deadline without mutating it, and `sendFile` derives its deadline from payload size (the red run reproduced the production `upload file` triple-timeout fingerprint verbatim).
- `uploadImage` shares the same sizing (`uploadAttemptTimeoutMs`), so card-embedded images get identical treatment.
- The stale-upload overlap remains: a timed-out attempt's HTTP call keeps running in the background until it settles on its own. With sized deadlines an attempt that times out is genuinely starved, so retries are rarer; the ceiling bounds total exposure.
