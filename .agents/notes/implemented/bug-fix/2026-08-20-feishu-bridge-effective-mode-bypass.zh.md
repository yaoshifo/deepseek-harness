# Agent Note: 无人值守 feishu-bridge 会话的 effectiveMode 免审批

Status: implemented

[English](2026-08-20-feishu-bridge-effective-mode-bypass.md) | 中文

## Problem

Go 的 dsh 后端按会话计算 effective mode（`agent/dsh/dsh.go` effectiveMode）：群内没有人类的 agent 派发子任务（`CC_SUBTASK=1` 且无 `CC_SUBTASK_ATTENDED`）与 chatroom 角色/直聊人设会话以 `bypassPermissions` 运行——这些会话里的审批提示没人能回答，第一次工具调用就会永久挂起。TS adapter 只移植了 mode 处理的 plan 半边：所有会话（包括派发子会话）继承 project 配置的模式。在 `agent.mode: plan` 的 profile 下，真机冒烟显示子任务子会话整轮停在 ExitPlanMode 审批卡上，只有盯着子群的人能清掉——Go 从未有过的行为。

## Decision

`sessionBypassesPermissions(env)`（`src/agent-dsh/adapter.ts` 导出的纯函数）保形移植 Go 的 effectiveMode 谓词：无人值守 subtask、chatroom role、direct-role 旗标 → bypass；attended subtask 与 moderator 保持正常审批。`startSession` 把它快照进 `DshAgentSession`（`bypassPermissions`，对应 Go `permMode`/`autoApprove`），并以 `bypassPermissions` 覆盖任何配置模式或一次性 override——这同时强制关闭 plan 模式：派发子会话不得停在 ExitPlanMode 卡上。adapter 的 `approval/request` answerer 对 bypass 会话在向 engine 发出任何权限请求之前短路返回 `allowed-once`，对应 Go 的 autoApprove 分支。AskUserQuestion 与 plan-review 走独立的 userQuestions 通道，bypass 会话里问题卡与 plan 卡照常出现（Go #15 语义：bypass 自动批准的是工具，绝不是问题）。

## Alternatives considered

**经 dsh 的 approval 服务 `setPolicy` 设每会话权限策略。** 否决：adapter 已拥有所有工具 ask 汇入的单一 `approval/request` answerer，而 bypass 是 engine 会话 env 的属性、不是进程级策略的属性；为在既有咽喉点一个旗标就能表达的事引入第二套路由不值。

**在 engine 侧、权限事件发出前 bypass。** 否决：engine 的权限路径是平台无关的、由其他 agent 后端共享；Go 把这个决策放在 env 旗标所在的 dsh 会话里，adapter 就是它的 TS 对应物。

**把 moderator 也纳入 bypass。** 否决：Go 排除了它——moderator 是人类主动驱动的那个 chatroom 会话，它的 plan 审批有意义。

## Consequences

派发子任务现在一路直通工具调用、无审批卡，对齐 Go：subtask 冒烟 spawn → 干活 → report 全程无人工介入（此前 plan 默认 profile 下每个子会话都停在 ExitPlanMode 卡）。chatroom 角色也失去审批卡——带 Bash 的角色此前至少能被人类拒绝危险工具挡一下；这道防线现在完全依赖 chatroom 安全底线 prompt 与沙箱。attended subtask 在人类消息标记 `CC_SUBTASK_ATTENDED` 的那一刻翻回正常审批，进入子群即恢复防线。

## Testing

`tests/agent-dsh/adapter.spec.ts` 钉住谓词表（Go session_test.go 四例 + moderator 与空 env）、无人值守 subtask 与 chatroom-role 会话的 answerer 短路（无 `respondPermission` 即 settle `allowed-once`）、attended-subtask 路径仍等待 engine 决策、bypass 覆盖 plan 默认（`planMode.set(false)`）。真机冒烟：子任务子会话全程无审批卡直跑到 report。
