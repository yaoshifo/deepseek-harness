# Agent Note: feishu-bridge plan-approval permission preset switch

Status: implemented

[English](2026-09-02-feishu-bridge-plan-approval-permission-preset.md) | 中文

## Problem

plan 模式的 bridge 会话（live profile 的 `agent.mode: plan` 默认，`/spawn` 群与主群 alike 继承）在用户批准 ExitPlanMode 卡之后，仍以组合的沙箱与审批默认值运行：写工作区外文件照样被拒、经 sandbox-permissions 升级重试、再等一张审批卡。用户刚给出的批准授权的是计划的执行，但没有任何机制把这份授权传导进会话的权限旋钮——plan 状态与权限状态刻意独立（[plan-mode 模块契约](../../../../../packages/plan/plan-mode/src/index.ts)：sandbox mode 与 approval policy 永不读写 plan 状态）。

## Decision

dsh adapter 里批准 plan review 时，若项目配置了 `agent.planApprovalPreset`（`packages/acp/feishu-bridge/src/index.ts` → `DshAdapterConfig.planApprovalPreset`），即切换会话权限预设：`answerPlanReview` 的 allow 分支调用 `DshAgentSession.applyPermissionPreset`，后者委托给已组合的 `permissionPresets.set(session, name)`——该服务现成的公开写路径，切换落为持久的 `permission/preset` + `sandbox/mode` + `approval/policy` 三事件、在会话下一个受限调用生效、经回放在 resume/重启后还原、并经 delegation 边界继承给派生子会话。字段引用预设名而非旋钮组合：「全权限」的含义归部署的预设表所有（默认表的 `danger-full-access` = 全文件访问 + 审批 `never`），想要全文件同时保留 hook 审批的部署可自定义预设后引用其名。缺省或 `''`（默认）保持批准流程权限中立。

旋钮语义骑在原生服务上：`danger-full-access` 下 fs/bash 围栏不再拒绝，升级询问根本不会发生，模型从每请求的 runtime-context 快照（「Current DSH file policy / Approval prompts are disabled」两句）获知新状态，bridge 侧不做任何提示词改动。

降级方向安全且有声，绝不破坏批准流：`permissionPresets` 服务缺失或预设名不在表内时 `console.error` 记日志、权限保持不变（已给出的批准照常完成）。OPERATIONS.md 的 `agent.mode` 行此前断言「含审批 preset」——2026-08-21 填表时未核实；真实映射即本独立字段，该行已更正。

## Alternatives considered

**批准时翻 adapter 的 `bypassPermissions` 标志。** 该标志把 `approval/request` 自动答成 `allowed-once`，但沙箱仍会先拒第一次工作区外写入（模型要吃 denial、带 `sandbox_permissions` 重试、再被自动放行），runtime context 仍宣称 `workspace-write`，内存标志重启即失，每次自动放行还各写一对审计事件。每一项都更差；否决。

**核心侧的 plan-mode→权限联动。** plan-mode 的模块契约明确声明不感知权限；把预设切换接进 `exit_plan_mode` 的批准解析会一次改变所有消费方（web、CLI），并耦合两个刻意独立的系统。想要这个联动的是 bridge 这个消费方，就由 bridge 持有；核心侧否决。

**经新增 `permission-presets` 公共方法并把包 link: 进 profile。** live profile 的 `dsh-permission-presets` 走 pnpm store 解析（非 `link:`），改它需要编辑 profile 依赖清单并 install；而现有公开 `set(session, name)` 已写全所有旋钮。保持只改 bridge；唯一代价是活体策略切换通知（`approval.setPolicy` 注入的用户消息），runtime-context 快照已覆盖其作用。

## Consequences

批准卡成为唯一授权时刻：之后计划的执行以所指预设的权限运行、不再出现审批卡（批准后派生的 subagent 经 delegation 边界继承升格后的旋钮）。`/new` 重新武装默认预设与 plan 模式——每个会话「先审后全权」，且已升格的会话没有会话内降级命令（逃生门是 `/new`）。默认 `danger-full-access` 预设的 `never` 审批侧会确定性拒绝残留的 hook/工具策略 `ask`——当前部署没有这种来源；需要这类询问的部署必须引用自定义的 `{danger-full-access, ask}` 预设。`tests/agent-dsh/adapter.spec.ts` 钉住 allow/deny/未配置/服务缺失/切换抛错的矩阵，`tests/assembly-config.spec.ts` 钉住配置接线。

## Testing

`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts`（plan-approval permission preset describe：allow-once 与 allow-always 切换、deny 与未配置与空值不动、服务缺失与切换抛错安全降级并记日志）；`packages/acp/feishu-bridge/tests/assembly-config.spec.ts` 把 `agent.planApprovalPreset` 接到 adapter。尚无 keyless recorded-session 快照——待有录制 key 后补。
