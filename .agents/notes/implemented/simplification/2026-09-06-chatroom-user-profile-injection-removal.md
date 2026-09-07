# Agent Note: chatroom userProfile injection config surface removed

Status: implemented

English | [中文](2026-09-06-chatroom-user-profile-injection-removal.zh.md)

## Problem

The chatroom `userProfile` config key (a Go `user_profile` migration leftover) injected a user-background file unconditionally into every chatroom persona (roles, moderator, direct-role) and fail-loud validated its readability at `/chatroom` startup and the tool's `start` action. The mechanism had already been deliberately retired: the chatroom predecessor repo (yaoshifo/chatroom) switched 「inject at startup」 to 「the moderator confirms via a card, then Reads the vault's user-profile.md on demand」 back at 36beb5f, with the decision rule carried by the books moderator contract (books/chatroom/CLAUDE.md, 「用户背景」 section). The production profile never configured the key, but the config surface alone was a drift source — the day someone configures it, the two mechanisms fight: the system prompt already carries the full text while the moderator still asks the user 「load it?」 per the contract.

## Decision

Remove the whole surface: the `Config.userProfile` interface field and schema key, the `userProfileCfg` field with its apply branch, and the `userProfile()` reader; the persona assembly's `loadUserProfile` and the 「## 用户背景（服务对象）」 injection section with its `userProfilePath` parameter; the two policy call sites' arguments; the `/chatroom` and tool-`start` `chatroomUserProfileError` startup gates; three i18n entries (en/zh/enum); the matching README (both languages) and SKILL.md wording. SKILL.md also aligned the stale tool names `AskUserQuestion` / `MultiSelect` / `(Recommended)` with the engine's real names `ask_user_question` / `multi_select` / `recommended: true` (completing the dsh half of the same-family fix landed books-side on 2026-09-06).

## Alternatives considered

**Adding a guard note to the books moderator contract.** Rejected: a note cannot defend against the config surface itself — the misconfiguration entry stays; making the key not exist beats writing 「do not configure」.

**Keeping the key as forward compatibility for a future consumer.** Rejected: same argument as the context_window chain removal (2026-09-03) — a dead config surface nobody has configured since the migration only invites ops copying.

## Consequences

Production has no such key, so runtime behavior is unchanged; 「load the user background on demand」 becomes the single mechanism, its one source of truth the books moderator contract (the engine no longer has a parallel injection path). A leftover `userProfile:` line in an existing config is silently stripped by the Schema as an unknown key (lazily harmless; the production profile is verified free of it). The only path for user background to enter a discussion converges to: moderator's confirmation card → user approves → `Read` the vault file → excerpt into the ledger synthesis.

## Testing

Absence verified by grep: `userProfile` / `user-profile` / `AskUserQuestion` / `MultiSelect` leave zero residue across the package's src/tests/README/skills (the `vault/.claude/user-profile.md` path kept in SKILL.md is the on-demand Read target file, not a config reference). Dead-behavior tests died with the behavior (persona inject/skip, config ~ expansion, tool start fail-loud, engine startup gate); the policy's persona-assembly test was rewritten to assert the base section exists. Focused 196 tests green (persona/config/policy/tool 60 + engine/gather 136); repo-wide typecheck passed.
