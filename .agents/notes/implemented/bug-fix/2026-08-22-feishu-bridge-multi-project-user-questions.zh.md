# Agent Note: feishu-bridge 多 project 下 userQuestions provider 单例冲突

Status: implemented

[English](2026-08-22-feishu-bridge-multi-project-user-questions.md) | 中文

## Problem

生产事故 2026-08-22 09:13（Dev 服务器，首个多 project 部署）：第二个及之后的 project 的首条消息报「❌ 错误: 启动 Agent 会话失败」；daemon 日志为 `failed to start interactive session (...): UserQuestionError: a user-questions provider is already registered`。

`UserQuestionService`（`packages/interaction/user-questions/src/index.ts`）是进程级单例，只接受一个 UI provider。feishu-bridge 插件每个 project 建一个 `DshAgentAdapter`，各自在**自己首个会话**创建时懒注册 provider（`ensureUserQuestionsProvider`，在 `startSession` 的 `agents.create` 之后调用）。单 project 部署（M1 记账驴、本机开发虾）从不会注册两次，冲突在 8-project 切流前不可见：首个建会话的 project 占住 provider 槽位，其余所有 project 的首个会话抛 `DUPLICATE_PROVIDER`。无运维绕过手段——重启 daemon 只会重新随机决定谁赢。

同一处还藏着第二个潜在缺陷：provider 的 ask 处理按注册 adapter 自己的 `liveSessions` 表路由，即使不冲突，其它 project 会话的提问也会静默返回 `{ answers: [] }`。注册与路由都是单 project 设计；D4 的进程级 caller 路由模式（`src/index.ts` 里 subtask/cron/relay/chatroom/send 工具族已用）从未应用到 questions 上。

## Decision

跨 adapter 路由 + 每应用一次注册。插件 `apply()` 创建新的 `QuestionRouting` 对象（`{ adapters, registered }`），经 `buildProjectAssembly` 传入每个 adapter 的 config；每个 adapter 在构造器把自己 push 进去。ask 主体移到公开的 `DshAgentAdapter.handleUserQuestion(request)`——本 adapter 无匹配活会话时返回 `undefined`；唯一注册的 provider 遍历 `routing.adapters` 取第一个非 undefined 结果，全 miss 回 `{ answers: [] }`。不带 `questionRouting` 的 adapter（单 project 部署、既有测试）保持原自注册行为不变。注销 disposer 仍挂在注册 adapter 的 disposers 上，Cordis HMR 重载插件时 provider 被反注册、重建的 adapter 懒注册。

## Alternatives considered

**放宽 `UserQuestionService` 的单例限制。** 每 context 一个 provider 是服务的公开契约（`registerProvider` JSDoc）；为一个消费方放宽要改跨包 seam，且路由问题依旧没有答案。

**直接在 `apply()` 注册 provider。** 注册刻意保持懒——构造时 user-questions 服务可能尚未组装；维持首会话触发保留该契约。

## Consequences

多 project daemon 可用：所有 project 的会话都能启动，AskUserQuestion / ExitPlanMode 卡片路由到发起提问的 engine 会话，无论它属于哪个 project。单 project 行为逐字节不变（回退路径）。provider 槽位现在每个插件应用只占一次，HMR 重载也能干净地重新注册。

## Testing

`tests/agent-dsh/adapter.spec.ts` → "two adapters sharing question routing register one provider and route asks across adapters"：单例语义的 fake 服务 + 共享一个 routing 的两个 adapter——第二个 adapter 的首会话不得抛错（修复前红：`DUPLICATE_PROVIDER`），且第二个 adapter 会话的 plan-review 提问路由到它自己的 target。`tests/assembly-config.spec.ts` → "buildProjectAssembly forwards one shared routing object to every adapter"。包内 2047 测试全绿；oxlint/tsc 干净。真机验证：多个 bot 收发消息（此前失败的择时驴/教学驴）+ 非首个 project 会话里的问题卡。
