# Agent Note: feishu-bridge 闲置收割器默认以两小时阈值开启

Status: implemented

[English](2026-08-20-feishu-bridge-idle-reaper-default.md) | 中文

## Problem

Go 后端的 `interactive_idle_timeout_mins` 默认关闭：其 workspace pool 会在 15 分钟后回收闲置 worker 作为兜底，交互层收割器只是一个更长的第二档杠杆。TS 迁移未移植 pool 这一层——会话是进程内对象——但配置字段按原样移植成了 opt-in（`interactiveIdleTimeoutMins` 缺省 → 收割器禁用）。于是省略该字段的部署会让交互态无限累积；单会话的内存代价从 Go 的进程级降到 MB 级，但被遗忘的会话永远不会消失，而且因为状态从未被回收，下一条消息也无从重放。

## Decision

`interactiveIdleTimeoutMins` 在 schema 层携带 `.default(120)`（`packages/acp/feishu-bridge/src/index.ts`，`Config` schema 的 projects 行）。Cordis loader 在加载与重载时都经 `resolveConfig` → `~standard.validate` 解析配置，因此所有经 profile 启动的部署无需配置即以 2 小时阈值获得收割器；显式 `0` 仍然关闭（schemastery 只对缺失 key 应用默认值，且 `Schema.natural()` 接受 0）。引擎接线的 `!== undefined` 守卫保持不变：绕过 schema 的手工构造 config（单元测试）仍把缺省读作禁用。阈值刻意放宽——2 小时收走 overnight 或周末被遗忘的会话，但不碰午休或任务中途的长思考停顿。

## Alternatives considered

**保持 Go 保形：默认关闭。** 否决：Go 默认关闭是因为 workspace pool 提供 15 分钟兜底，而该层未迁移。只移植字段的默认值而不移植其兜底机制，等于继承了默认值赖以成立的约束却丢掉了使它成立的机制。

**对齐 Go pool 的 15 分钟默认。** 否决：pool 回收的是 worker，可按需透明重启；这里回收会关闭交互会话，下一条消息要为首条回复支付日志重放延迟。15 分钟会为进程完全 spare 得起的内存向正常工作节奏（会议、代码评审）收税。

**wiring 级默认（装配路径里的 `project.interactiveIdleTimeoutMins ?? 120`）。** 否决：仓库要求默认值是显式 resolve 步骤，不得是藏进接线的 `??`；schema 默认值搭乘 loader 既有的解析，那正是这个步骤。它也让校验前的输入形态保持诚实——`ProjectConfig` 字段维持可选，因为可选正是原始 profile 可能呈现的样子。

## Consequences

省略该字段的部署现在会在闲置 2 小时后收割交互会话：agent 被关闭，下一条消息通过重放会话日志恢复，首条回复变慢——这正是有意的内存换延迟。现网 profile 显式配置了 `interactiveIdleTimeoutMins: 30`，不受影响。默认值只作用于 loader 路径：手工构造 config（单测装配）仍把缺省视为禁用，装配测试就地注释了这条分歧。收割器仍然不会关闭正在干活或等待审批的会话，也不清理 `/spawn` 的 worktree——那仍是 `/done` 的另一半。

## Testing

`tests/plugin-entry.spec.ts` 通过 `~standard.validate` 校验导出的 `Config` schema：缺省 → 120、显式 30 → 30、显式 0 → 0。`tests/assembly-config.spec.ts` 用注释区分后钉住手工构造路径（缺省 → 禁用）。引擎收割行为（干活中跳过、等审批跳过）由既有 engine specs 覆盖。
