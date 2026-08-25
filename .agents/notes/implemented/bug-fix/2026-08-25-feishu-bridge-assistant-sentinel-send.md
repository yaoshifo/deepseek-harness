# Agent Note: research roles address their assistant by the "assistant" sentinel, not a transcribed key

Status: implemented

English | [中文](2026-08-25-feishu-bridge-assistant-sentinel-send.zh.md)

## Problem

Incident 2026-08-25 (chat oc_ac5db, chatroom `人生重大决策的防错机制`): the marks role could not use its pre-provisioned research-assistant group while the other four roles in the same chatroom could. Session-log forensics: the system prompt carried the assistant's full session key correctly, but the model transcribed it into the `feishu_bridge_subtask` send arguments with five characters dropped (its own thinking trail shows two bad transcriptions before committing to one). Two engine-side defects turned that single transcription slip into a confusing failure:

- `sendToSubtask` validated the child through `getOrCreateActive` — a CREATING lookup. The mistyped key missed, minted a phantom parentless session (registry s228, created 6 ms after the failed call), and the phantom's empty parent link then misreported as「目标群不是当前会话派发的子任务」— an error that sent both the user and the investigation down the wrong path, plus a permanent registry-pollution entry.
- The research moderator priming still told roles to use `$CC_RESEARCH_ASSISTANT_CHILD` — a Go-era env injection that does not exist in the dsh backend. The model, unable to find the "injected env var", reconstructed the key from conversational memory — exactly where transcription corrupts it.

## Decision

- **Sentinel addressing.** `sendToSubtask` resolves `child: "assistant"` server-side to the caller session's `researchAssistantKey`; the research-role contract and the moderator priming now instruct the sentinel instead of inlining a 40+ char hex key. A model never transcribes the key, so it cannot corrupt it. The persona's inline-key injection chain (`researchAssistantChild` through `ChatroomOptions` → adapter → persona build) is deleted as dead code; the session-registry `researchAssistantKey` remains the resolution source.
- **Non-creating child lookup.** The group-path validation uses `findActive`; an unknown child key fails loudly with「no subtask session <key> — the key may be mistyped; copy it verbatim, or use "assistant"」instead of minting a phantom session and misreporting ownership.
- **Stale wording removed.** The `$CC_RESEARCH_ASSISTANT_CHILD` mention is gone from the priming; a spawn-fallback answer still receives a real key in the tool result and copies it verbatim for later follow-ups.

## Alternatives considered

**Key-format validation (regex on feishu key shape).** Rejected: a well-formed but wrong key still fails ownership, and the sentinel removes the failure class entirely rather than detecting it.

**Keeping the inline key and adding a "copy carefully" instruction.** Rejected: instructions do not fix transcription; the other four roles transcribed correctly by luck, not discipline.

## Consequences

A mistyped child key now produces one clear error and zero side effects. Research roles need no key at all for the pre-provisioned assistant. The spawned-fallback path (research assistant provisioning failed → the role spawns its own) keeps verbatim-key semantics. Deployment cleanup (one-time, manual): delete the phantom registry session s228 and its bogus `feishu:oc_a39d75653b9c335f4c4cad3f47a` activeSession entry from the 开发虾 project's sessions.json — note the 5-character difference from the real key.

## Testing

`engine-subtask.spec.ts`: unknown-key send rejects with the mistyped-key error and mints no session (count assertion); the sentinel resolves `researchAssistantKey` and delivers; an unprovisioned caller is told to spawn first. `chatroom-persona.spec.ts` pins `child: "assistant"` in the research contract. `engine-chatroom-gather.spec.ts` pins the sentinel wording and the absence of the env-var mention. Full engine + adapter + assembly suites (1480 tests) and repo typecheck pass.
