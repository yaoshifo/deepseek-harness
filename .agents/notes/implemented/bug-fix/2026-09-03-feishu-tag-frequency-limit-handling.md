# Agent Note: Tag discover pacing and verify-unknown semantics

Status: implemented

English | [中文](2026-09-03-feishu-tag-frequency-limit-handling.zh.md)

## Problem

The 2026-09-02 oc_e51a chatroom spawn exposed a three-layer tag failure. (1) `discoverTagFromSpawnedChats` scanned every spawned chat (~185 and growing) with back-to-back `im/v2 biz_entity_tag_relation` reads; the app tripped the method's rate limit (HTTP 400, code 99991400 "request trigger frequency limit") and every subsequent read failed — 1388 consecutive rejections in one evening, a pattern present since the 2026-08-20 migration whenever a cache-miss tag triggered a scan. (2) The bind-verify readback shares the drained quota: `chatHasTagID`/`chatHasActiveTag` returned false on query failure, so binds that HAD landed (the bind_version timestamps prove it) read as "did not take effect", evicting good cached ids and blacklisting them — the eviction cascade then forced fresh discovers that deepened the rate hole. (3) `im/v2 tag.create` on a duplicate name returns 402 without `create_tag_fail_reason.duplicate_id` (verified against the live tenant), so create can never resolve an existing name — resolution depends entirely on the discover scan and the sibling cache files.

## Decision

- The discover scan paces through a shared token bucket (`tagScanTiming`: 400ms interval, burst 2; injectable as `scanLimiter` for tests) and aborts at the first 99991400 rejection: pressing on drains the app's rate budget further while every subsequent read fails anyway. The next spawn rediscovers.
- Verification is tri-state: `chatHasTagID`/`chatHasActiveTag` return true (readback carries the id), false (readback succeeded and excludes it — the dead-id case the verify exists for), or undefined (query failed — verification unknown). Unknown keeps the bound id without eviction or blacklisting; only a clean false evicts. `listActiveSpawnedChats` maps unknown to not-active, as before.
- `feishuFrequencyLimitCode` joins `feishuPatchRateLimitCode` in retry.ts as an exported business-code constant; it is deliberately NOT added to `isTransientError` — the scan must abort while one-shot verbs keep their current fail-fast behavior.

## Alternatives considered

- **Retry the frequency-limited chat with backoff instead of aborting.** The pacing gate prevents self-inflicted trips, so hitting the limit means the app-level budget is exhausted elsewhere; a short backoff does not refill a per-minute window and the loop is best-effort.
- **Treat 99991400 as a global transient error in `isTransientError`.** One-shot verbs retrying is fine, but the scan would retry through hundreds of rejections; the two call sites need opposite policies.
- **Share tag ids with the dev server's caches.** Out of scope: the machines keep separate cache dirs; tenant tag names are unique across the tenant's apps, so cross-app 402 duplicates are the norm and the same-machine sibling-cache fallback stays the only sharing mechanism.

## Consequences

- Tests pin: the discover scan paces one limiter wait per read and resolves on the carrying chat; the first frequency-limited read aborts before later chats; a failed verify readback keeps the bound id without eviction (the oc_e51a eviction cascade as the regression); the existing evict-on-clean-false tests are unchanged.
- Remediation of the oc_e51a run: the steward and marks-assistant chats (the two whose resolution failed outright) were re-bound to the research tag and verified by readback; the other five chatroom chats were already tagged despite the logged failures.
- Deployment: bridge package rebuild + `/reload` on both machines. Re-check on the next multi-group spawn: no "discover tag query failed" bursts; at most one "frequency limit; stopping" line per scan.
