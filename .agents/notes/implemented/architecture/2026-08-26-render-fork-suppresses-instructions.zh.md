# Agent Note: feishu-bridge 渲染 fork 屏蔽 workspace 指令注入

Status: implemented

[English](2026-08-26-render-fork-suppresses-instructions.md) | 中文

## Problem

plan/reply 渲染 fork（`renderQuery` → `oneShotQuery`）通过 `complete: true` setup hook 整体替换 system prompt，但指令通道没有被屏蔽：全新的渲染会话仍会收到 workspace 指令 baseline（用户级 `~/.dsh/AGENTS.md` 加从 adapter cwd 发现的项目 CLAUDE.md），以 `<system-reminder>Instructions from: …</system-reminder>` 用户消息注入——live profile 上每次渲染约 49 KB。chatroom bare persona 出于同样的隔离理由已经调用 `agentInstructions.suppress()`（Go `--bare` parity）；渲染 fork 是另一个整体替换 prompt 的会话，却没有屏蔽——这是不对称，不是有意选择。

被注入的文件是静态的工作区规则（编码约定、git 规范、沟通风格），不含任何任务事实：渲染 fork 是无父会话历史的全新会话，内容事实只经 prompt 传递（html_path 加 plan-markdown / plan-rendered-html 块）。因此这些 token 换不来准确性——是每次 plan 渲染和投机 reply 渲染上的纯输入开销。

## Decision

`buildCompletePromptSetup`（所有 `complete: true` 注册共享的 setup hook）在注册 section 之外调用 `agentInstructions.suppress()`，与同文件中 chatroom bare persona 的做法对齐。渲染会话保留其工作工具——它需要 `write` 写 body 片段；唯一的工具限制是 deny 全局 `skill` 工具、随之去掉 `<available_skills>` 清单（渲染 skill 正文已烤进 system prompt；见 [oneshot bare 旁路查询](2026-08-26-oneshot-origin-bare-side-queries.zh.md)）。suppression 在渲染 agent 自己的 scope 上注册 effect，随会话 dispose 自动撤销；baseline 注入与 fs 触摸驱动的动态更新都保持静默。

## Alternatives considered

- **保留注入，当作廉价上下文。** 否决：被注入的规则不含任务事实，且是 coding agent 指令（提交纪律、回复深度三选一），对渲染 skill 的 300 字预算和「图只表达关系」规则只有噪声。
- **在 `renderQuery` 调用点而非 `buildCompletePromptSetup` 内部屏蔽。** 暂不：该 hook 只有一个调用方，「整体替换 prompt ⟺ 指令通道静默」是值得一次说清的不变量。若未来有需要指令的 complete-prompt 调用方，把 suppression 上移到渲染专属路径——hook 的 JSDoc 写明了这个天花板。
- **改喂渲染 fork 更丰富的父会话上下文。** 否决：准确性来自 plan-markdown / plan-rendered-html 块，渲染 skill 的设计就是对聊天里已交付内容做概览式提炼；全上下文 fork 会随会话长度线性增加输入成本，收益甚微。

## Consequences

- 渲染请求缩小 workspace 指令 baseline（live profile 上约 49 KB / 1.2 万 token：8 KB 全局 AGENTS.md + 41 KB 项目 CLAUDE.md），零内容损失——渲染输出是渲染 system prompt 与任务 prompt 的纯函数。
- 渲染会话完全看不到项目编码约定；若未来渲染 skill 需要项目领域知识，必须在 prompt 里显式传入，而不是从 cwd 发现。
- 渲染 fork 的 cwd 仍默认 adapter 配置的项目 workdir（`oneShotQuery` 用 `cfg.cwd`），现在只影响工具执行与临时路径布局，不再影响指令或记忆发现（`origin: 'oneshot'` 同样挡掉了记忆索引）。
