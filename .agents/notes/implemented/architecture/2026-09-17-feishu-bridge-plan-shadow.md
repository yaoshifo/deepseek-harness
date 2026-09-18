# Agent Note: the plan-card shadow review group

Status: implemented

English | [中文](2026-09-17-feishu-bridge-plan-shadow.zh.md)

## Problem

A plan card parks its turn until the user answers, and the parked window is the cheapest moment to ask for a second opinion: a note on the card already rides the verdict into `exit_plan_mode`'s rejection path, so a user who pushes once more ("还有没有更好的、更鲁棒的、更优雅的方案？") may collect a better plan. Doing that by hand spends the plan they had — the same conversation re-plans and its card is gone — and the push itself is a manual step nobody repeats reliably.

Automating it needs a second conversation seeded from the same transcript, which the bridge could already build (`/fk`), plus two things it did not own:

- The plan-card emission had no post-park hook. `feishuBridge/ask-parked` fires only for question asks; the plan path ends at `deliverCards` with nothing an owner could listen to.
- Two such conversations had no way to settle each other. Whichever plan the user approves must void the other, and nothing linked the pair.

## Decision

`engine/plan-shadow.ts` owns the feature; `Engine.askUser`'s plan-review branch is its only entry points.

**Launch.** Right after the plan card lands and the ask parks — after the `deliverCards` race, before the decision race — `launchPlanShadow` runs fire-and-forget, so group creation never sits between the parked card and the user's approval window. The shadow is a `/fk`-shaped child: `spawnGroupCommon` with `forkSentinelID = __fork__<nativeID>`, `modeArg: 'plan'`, and the review prompt as the injected first message. The child is a fresh group on the origin chat's working directory, provider route, and membership; no worktree, because a plan-mode session does not touch the tree.

**Guards** (all in `canLaunch`, all silent skips): the per-project switch, a plan with text, a group-capable platform, a forkable native session id (started, neither `__fork__` nor `__forkat__`), a spawn user that is neither empty nor the cron synthetic sender — the shadow group's only member is that user, so a group invited around `cron` would be one nobody can open, let alone approve — not itself a shadow, and not one that already launched. "One shadow per conversation" rides `Session.featureState.planShadow`: the origin records `shadowSessionKey`, the shadow records `shadowOf`. The section is codec-less on purpose — it persists in the sessions snapshot but no codec carries it across a conversation reset, so `/new` legitimately re-arms the review.

**Naming and notice.** The group is named `<origin chat name> · 推敲`, truncated through `truncateGroupName`. The chat's name is its session label unless that is still the generic `defaultSessionName` placeholder, else the name recorded from the chat's messages; a chat with neither takes the `/fork` placeholder, which the existing first-message rename replaces. That is deliberately not `sessionDisplayName`, whose remaining fallbacks (the placeholder, then the raw session key) name the `/list` and `/status` rows — neither belongs in a chat-list entry this feature creates — and deliberately not an unconditional placeholder either, whose rename would be seeded by the review prompt. `SpawnCommonOpts.parentNotice` carries the explanation line onto the origin chat's existing jump card; the notice rides both send paths (card-handle and the `sendAsCardWithButtons` fallback), because applying it to one and not the other silently drops it on platforms without card handles. The shadow chat itself receives no notice message: the name suffix and that jump card are what identify the group to whoever opens it. `/spawn` and `/fork` pass no notice and keep their button-only card.

**Settlement, both directions.** Each call self-guards, and a session is never both a shadow and a shadow owner:

- Approving the origin plan calls `abortPlanShadow`: `markSpawnedChatDone` → `setChatPhase('done')` → `stopInteractiveSession` → the void notice in the shadow chat. The terminal state is committed before the stop, mirroring `/done`'s order, so late repaints observe the done mark.
- Approving the shadow's plan calls `invalidateOriginPlan`, which stops the origin's parked turn rather than cancelling the ask alone: a cancelled `exit_plan_mode` lets the origin agent plan again and park a competing card. The origin chat gets a notice with a jump button to the shadow.

`spawnGroupCommon` returns the synthetic child message (the caller needs the child's session key to link the pair) and accepts the optional parent notice. Every failure path is unchanged and still reports itself in the origin chat, so the shadow path adds no second failure notice.

**Configuration.** `projects[].planShadow.enabled` (default true) and `planShadow.prompt` (default: the wording `plan-shadow.ts` ships, pinned word for word by a test). The prompt is the deployment knob the user asked for: changing what the shadow is asked does not need a rebuild.

## Alternatives considered

- **Auto-submitting the review text as plan feedback in the SAME session.** The cheapest option and closest to what the user does by hand, but it spends the origin card: the whole point is that the original plan stays approvable while the review runs.
- **One shadow per plan card.** Rejected by the user: Feishu cannot delete chats, so every extra card would add a permanent group. The first card of a conversation is also where a second opinion has the most room to change the outcome.
- **Reusing one shadow group across a conversation's later cards.** Avoids group accumulation, but either the group must be re-armed mid-flight or its history mixes reviews of different plans; the "first card only" rule buys the same bound with no re-arming state.
- **Naming the group after `sessionDisplayName`'s fallbacks.** Cheapest, but on a chat that never recorded a name it puts the generic `default` label or the raw session key in the chat list — visible only in the live data (754 of 817 live sessions carry a real name; the rest do not), which is why the case is pinned by a test rather than left to the happy path.
- **Forcing a plan card even when the review finds no improvement.** The user ruled that the agent decides: a forced "improvement" invites make-work. The shadow answers in text when it has nothing better.
- **Extending `feishuBridge/ask-parked` to plan-review rather than calling the module directly.** That event's existing consumer arms a research-hub ask timeout; a new dispatcher would silently extend that policy to plan asks. A direct call from the ask's own branch, the shape `plan-render` already uses, changes only the plan path.
- **Keying the shadow's identity in the spawned-chat registry (`SpawnedChatMeta`).** The guard that stops recursion reads the asking session's own record, and the engine would have to reach into the platform's store to see it; `Session.featureState` is the session-scoped home, and it is the bag built for exactly this.
- **Deleting or closing the voided shadow group.** No Feishu API can dissolve a chat: dimming plus a notice is the whole available lifecycle.

## Consequences

- **Cost.** Every conversation's first plan card buys one more group, one full transcript fork, and one plan-mode turn — plus a Feishu group the user did not ask for, which the origin chat's jump card explains.
- **Groups accumulate.** A voided shadow stays in the chat list, dimmed. "First card per conversation" bounds it, `/new` resets the counter, and a user who wants none sets `planShadow.enabled: false`.
- **Race.** If the origin plan is approved while the shadow group is still being created, the abort runs against a group that now exists: it is dimmed and voided, but it is there. Accepted rather than serialized — blocking the approval window on group creation would be worse.
- **Unattended plans never spawn one.** The cron synthetic sender is refused; other machine-woken turns keep a real user's chat, and an approver exists there.
- **Verification.** `packages/acp/feishu-bridge/tests/engine/engine-plan-shadow.spec.ts` drives `Engine.askUser` against a stub spawner: one fork sentinel and plan mode on the child, the group name, the origin chat's notice, and the shadow chat's silence (the launch posts no plain-text message into it), the one-per-conversation rule, the shadow-recursion and cron guards, the switch, both settlement directions (including the teardown order and the frozen origin card), and the review prompt word for word. `tests/assembly-config.spec.ts` pins the config forwarding and its defaults. A mutation check (removing the settlement wiring) turns exactly the two settlement cases red.
- **Deployment.** Bridge rebuild + `/reload`; the feature is on by default, so no config change is required to adopt it.
