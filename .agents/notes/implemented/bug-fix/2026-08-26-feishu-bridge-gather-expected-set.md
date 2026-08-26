# Agent Note: feishu-bridge subtask gather expected-set membership

Status: implemented

English | [中文](2026-08-26-feishu-bridge-gather-expected-set.zh.md)

## Problem

The 2026-08-26 evening run of chatroom hub oc_b46da516 (bot 教学驴) hung for 17 minutes inside `feishu_bridge_subtask {"action":"gather"}`: the journal armed `gather armed on parent (expected=5 timeoutS=1200)` although the live work was two chatroom roles (hamming, polya) whose replies had already relayed to the hub. The expected set was `gatherSubtasks`' first loop — every session with `parentSessionKey` = the hub and `subtaskReported` false — which counted five chatroom role groups: three ended 场次 remnants (popper, marks, lakatos; chatroom teardown strips the role fields, the record keeps only parent = hub) plus the two live roles. Chatroom role groups never carry subtask depth (the chatroom spawn path does not go through the depth-assigning group spawn), and every subtask report path requires depth > 0, so no role reply can ever bank into the barrier — its only settlement is `deliverParentReply → SubtaskGather.accumulate`. The gather therefore waited for five structurally unreportable sessions up to the 20-minute timeout, holding the parent turn's lock; the user stopped it at minute 17. The restart earlier that evening was not a factor: the pollution source (role sessions hanging off the hub) exists in normal operation, and popper's session predates the restart.

The agent-side trigger was the moderator calling the wrong gather for role replies (the chatroom tool's own ask/gather is that seam); the engine's failure was turning a wrong-but-plausible call into a 20-minute hang instead of an immediate error.

## Decision

- `gatherSubtasks`' first loop now requires `subtaskDepth > 0` alongside parent and unreported: the expected set may only hold sessions that can settle the barrier, because every report path (auto-report, explicit report, rearm, timeout settlement) gates on the same depth. Chatroom role groups — live or ended — never join; native children keep joining through the second loop unchanged.
- A parent with no gatherable child now fails fast with the existing `SubtaskGatherNoPending` error, so a miscast gather returns as a tool error the agent can self-correct from (use the chatroom gather for roles).

## Alternatives considered

- **Bank chatroom role replies into the subtask gather barrier.** Rejected: roles are long-lived personas that answer many asks per discussion, so "reported" has no meaning for them, and bridging two fan-in barriers doubles the wake paths for one message.
- **Exclude role groups by `chatroomHubKey`/`chatroomRoleName` markers.** Rejected: chatroom teardown strips those fields from ended role sessions, leaving the remnants indistinguishable from any other parented session — the depth criterion covers live and ended roles with one durable field every report path already checks.
- **Filter by session liveness.** Rejected: an ended role's session object stays alive in the registry (it is history, not a corpse), so liveness does not separate roles from children.

## Consequences

- Group-path subtask children (`/spawn`, attended `feishu_bridge_subtask` groups) are unaffected: the group spawn path assigns depth = parent + 1 at creation, so they still join the barrier.
- The moderator-side prompt/skill guidance is unchanged; the fast error is the correction path (observed moderators re-dispatch to the right tool on tool errors).
- Covered by `tests/engine/engine-subtask.spec.ts`: membership (role groups live and ended excluded, depth child kept, reported child excluded) and the role-only fail-fast; the pre-existing native-children gather specs are unchanged and green.
