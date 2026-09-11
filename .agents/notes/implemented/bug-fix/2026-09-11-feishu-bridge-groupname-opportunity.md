# Agent Note: The spawned-group rename owns the name until a message names the group

Status: implemented

English | [中文](2026-09-11-feishu-bridge-groupname-opportunity.zh.md)

## Problem

2026-09-11, the group `oc_823de9…` was created by an idle `/spawn` (no task argument) under the placeholder 「运维虾 副本」. The user's first message was 「hi」, which the ambiguous-seed guard rejects (2 runes < `minGroupNameSeedRunes` 4), so the automatic rename skipped it — correct on its own: the seed carries no task. But the trigger only ran for a chat whose session window held no turns yet (`recentTurnsOf(…, 1).length > 0` returned early), so every later message — including the 429 investigation that followed — never reached the naming path. The group kept the placeholder permanently. The same shape had already hit `oc_a08f239d…` hours earlier, its first message also 「hi」.

The 2026-09-03 ambiguous-seed guard ([one-shot forks](2026-09-03-feishu-bridge-oneshot-fork-workdir.md)) is right to skip a bare 「继续」: naming from it invents a topic from ambient context. The defect was that skipping also consumed the only naming opportunity.

## Decision

- The rename opportunity is bound to the label, not to "the first message". `handleSpawnedGroupFirstMessage` renames while the chat's session label is still the spawn placeholder — `<bot> 副本` for /spawn and subtask groups, `<bot> 分支` for /fork. An ambiguous seed skips only itself; the next informative message still names the group, and a chat whose label already carries a name (automatic or manual) never re-enters the path. The guard itself is unchanged.
- One definition of the placeholder: `spawnPlaceholderName` / `isSpawnPlaceholderName` in `groupname.ts`, shared by the three creation sites (/spawn, /fork, subtask spawn) and the check, so the generated label and the recognized label cannot drift apart.
- Card replies are excluded from seeding: permission verdicts, ask-question answers, and followup selections carry button labels, not task text, and the wider trigger would otherwise name a group from them.
- One naming query per chat at a time (`groupNamingInFlight`): consecutive informative messages inside the 30s query window must not start concurrent renames that flip the name twice.
- After a landed rename the engine syncs the session label itself (`handleChatRenamed`) instead of waiting for the platform's rename event, so the placeholder check cannot fire a second rename in the lag window.

## Alternatives considered

- **Keep the skip terminal and only make it visible (a log line, or a notice in the chat).** Visibility does not give the group a name; the user still has to `/rename` by hand, and the placeholder stays the default outcome for idle spawns.
- **Let an ambiguous seed reach the LLM.** That is what the 2026-09-03 incident fixed: with no task in the seed the model invents one from ambient context, which is worse than no name.
- **Track "already named" as new persisted state (a spawn-store flag or a session field).** Old chats carry no flag, so their "unnamed" semantics must be backfilled — and the only faithful backfill is the label itself. The label is the authority; a flag would be a second copy that can drift.
- **Read the chat name from the platform instead of the session label.** A platform read needs a new public method and the rename path would still need the label sync to be race-free. The session label is already persisted, already updated by rename events, and already the value the spawn path writes.

## Consequences

- Tests: `engine-groupname.spec.ts` pins the new opportunity (placeholder label with a non-empty session window renames on an informative message), the already-named regression, the card-reply filter, the in-flight guard, the label sync, and the exact-match placeholder predicate. The chatroom spawn-flow control now sets its label to the placeholder, matching what the spawn path produces.
- Deployment: host build plus a manual `/reload`; the live signal is `/spawn` without a task → 「hi」 → an informative message, after which `chat renamed` appears in the daemon log. The chat that reported the defect (`oc_823de9…`) self-heals on its next informative message.
- Known limits: the check keys on the session label, so `/new` in a placeholder-named chat (the label resets to empty) stops auto-naming until a rename lands; a bot rename orphans older placeholders and the check then conservatively declines; a message that is informative but not a task can seed the name once — still better than a permanent placeholder.
- The non-LLM naming path (`groupNameEnabled` off) shares the same trigger: naming off, it renames straight from the current message until one lands. Both live deployments run naming on; the disabled path is covered by the chatroom suite's case.
