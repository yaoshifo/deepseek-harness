# Agent Note: 普通工具的拒绝理由经 steer 送达拒绝现场

Status: implemented

[English](2026-08-21-feishu-bridge-deny-reason-steer.md) | 中文

## Problem

权限卡拒绝路径构建了原生格式的拒绝消息——`buildDenyMessage(note)`，即 Claude Code tool_result 措辞加用户理由——并作为 `PermissionResult.message` 下发，但普通工具的下游没有任何东西能把它送达模型：Go `dshSession.RespondPermission` 的非 question 分支只发 `{outcome: "rejected"}`，TS approval answerer 只返回 `decision.outcome`，dsh core 把该 outcome 变成固定文案 `Error: the user rejected tool "X"`。`ApprovalOutcome` seam 是纯字符串联合，没有 message 通道——用户填写的拒绝理由只到原地换卡，模型永远看不到。已核实为 Go parity 行为而非移植缺口——Go 原版同样丢弃。

## Decision

engine 的 `handlePendingPermission` deny 分支在 note 非空、pending 工具不是 `ExitPlanMode`、且 agent session 存在时，把原始 note 逐字 steer：`state.agentSession.steer(note)`——与[计划批准补充](2026-08-21-feishu-bridge-plan-approve-supplement.zh.md)和 [/ps](2026-08-21-feishu-bridge-ps-steer.zh.md) 同一通道。模型在同一轮内看到拒绝错误与用户理由。包装后的 `buildDenyMessage` 仍照旧经 `PermissionResult.message` 下发，供 plan-review 路径消费（keep-planning 反馈）——因此需要 `ExitPlanMode` 守卫，避免理由被送达两次。

## Alternatives considered

**扩展 `ApprovalOutcome` 为携带 reason 的结构。** 否决：为一个桥端 UX 做跨包契约改动（user-approval、plan-mode 消费方、apiproxy schema、Web UI、cc-connect-bridge）；桥端 steer 零契约扰动即闭环。

**在 adapter 的 approval answerer（丢弃发生处）steer。** 否决：answerer 只收得到包装后的 message——原生前导加理由——而原始 note 只存在于 engine，且 engine 已持有 `state.agentSession`。

**steer 包装后的消息而非原始 note。** 否决：dsh core 已在 tool_result 里声明了拒绝；用户消息里重复原生前导是噪音。拒绝错误旁边的裸 note 读起来就是用户在说明接下来该怎么做。

## Consequences

普通工具的拒绝理由在飞书卡片流程内于当前轮对模型可见；包装后的原生拒绝文案在该路径上仍是死重（为 Go parity 与 plan-review 消费方保留）。若模型在拒绝后立刻收尾 turn，steer 由下一轮领取而不是丢失——与批准补充相同的边缘。

## Testing

`tests/engine/engine-m3-permission.spec.ts`（"deny reason steer"）：Bash 带理由拒绝仍发包装 deny message 且逐字 steer 该理由；ExitPlanMode 带理由拒绝不 steer（custom 反馈已送达）；裸拒绝不 steer。`RecordingAgentSession` 在 `tests/stubs/engine-stubs.ts` 增加 `steerCalls` 记录。
