# Agent Note: feishu-bridge multi-project userQuestions provider collision

Status: implemented

English | [中文](2026-08-22-feishu-bridge-multi-project-user-questions.zh.md)

## Problem

Production incident 2026-08-22 09:13 (dev server, first multi-project deployment): the first message to the second-and-later projects failed with 「❌ 错误: 启动 Agent 会话失败」; the daemon log showed `failed to start interactive session (...): UserQuestionError: a user-questions provider is already registered`.

`UserQuestionService` (`packages/interaction/user-questions/src/index.ts`) is a process-global singleton accepting exactly one UI provider. The feishu-bridge plugin builds one `DshAgentAdapter` per project, and each adapter lazily registers its own provider on its first session creation (`ensureUserQuestionsProvider`, called after `agents.create` in `startSession`). Single-project deployments (M1 记账驴, the local 开发虾) never register twice, so the collision was invisible until the 8-project cutover: the first project to start a session takes the provider slot, and every other project's first session throws `DUPLICATE_PROVIDER`. No operational workaround exists — a daemon restart only re-randomizes which project wins.

A second latent defect sits in the same code: the provider's ask handler routed by the registering adapter's own `liveSessions` map, so even without the collision, questions from other projects' sessions would silently resolve to `{ answers: [] }`. The registration and routing were both single-project designs; the D4 process-wide caller-routing pattern (already used for the subtask/cron/relay/chatroom/send tool families in `src/index.ts`) was never applied to questions.

## Decision

Cross-adapter routing with a once-per-application registration. A new `QuestionRouting` object (`{ adapters, registered }`) is created in the plugin's `apply()` and passed through `buildProjectAssembly` into every adapter's config; each adapter pushes itself in its constructor. The ask body moved to a public `DshAgentAdapter.handleUserQuestion(request)` returning `undefined` when no live session of this adapter matches; the one registered provider iterates `routing.adapters` and takes the first defined result, falling back to `{ answers: [] }`. Adapters without `questionRouting` (single-adapter deployments, existing tests) keep the previous self-registration behavior verbatim. The unregister disposer stays on the registering adapter's disposers, so a Cordis HMR reload of the plugin disposes the provider and the rebuilt adapters re-register lazily.

## Alternatives considered

**Raising the singleton limit in `UserQuestionService`.** The one-provider-per-context contract is the service's public shape (`registerProvider` JSDoc); relaxing it for one consumer changes a cross-package seam and still leaves the routing question unanswered.

**Registering the provider in `apply()` directly.** The registration is deliberately lazy because the user-questions service may not be composed at adapter construction time; keeping the lazy first-session trigger preserves that contract.

## Consequences

Multi-project daemons work: every project's sessions can start, and AskUserQuestion / ExitPlanMode cards route to the engine session that owns the ask regardless of which project created it first. Single-project behavior is byte-identical (fallback path). The provider slot is now taken once per plugin application, which also makes HMR reloads re-register cleanly.

## Testing

`tests/agent-dsh/adapter.spec.ts` → "two adapters sharing question routing register one provider and route asks across adapters": a singleton-enforcing fake service, two adapters sharing one routing — the second adapter's first session must not throw (red before the fix: `DUPLICATE_PROVIDER`), and a plan-review ask for the second adapter's session routes to its target. `tests/assembly-config.spec.ts` → "buildProjectAssembly forwards one shared routing object to every adapter". Package suite 2047 green; oxlint/tsc clean. Real-device verification: messages to multiple bots (previously failing 择时驴/教学驴) plus a question card in a non-first project.
