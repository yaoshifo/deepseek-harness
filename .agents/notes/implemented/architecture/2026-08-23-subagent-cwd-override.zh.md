# Agent Note: 子代理 cwd 覆盖是纯会话元数据，不是 git 编排

Status: implemented

[English](2026-08-23-subagent-cwd-override.md) | 中文

## Problem

feishu-bridge 的子任务编排支持跨目录派发（`--dir`）与 git worktree 隔离（`--worktree`），但完全靠自建机制：子会话经 `ctx.agents.create` 携 `meta.cwd` 创建，`engine/worktree.ts` 独占分支/worktree 创建、脏检查与回收。原生 subagent seam 没有任何表达工作目录的字段——`SubagentStartRequest` 不携带目录信息，tool-subagent 的措辞甚至承诺「delegation 不能重定向到其他目录」。任何需要按目录派发的消费方都得重建私有通路，而规划的桥侧无人值守子任务迁往原生 seam（去包袱批次 B4）也没有可迁移的原生原语。

设计问题是：原生 seam 是否应该连同 worktree 概念一起长出目录字段——毕竟桥的 `--worktree` 语义（隔离、keep/remove 生命周期）才是可见特性。

## Decision

原生 seam 只增加一个 start 期选项：`SubagentStartRequest.cwd`——可选绝对路径，覆盖父会话工作目录写入子会话 header。它由新增的 `SubagentCapabilities.cwdOverride` 旗标门控，在 `SubagentRuntime.start` 与 `startContinuable` 中于派发或身份预留之前校验（必须绝对路径），由 in-process driver 的 `childSessionMeta` 落实；所有进程外 backend 经 `NO_START_CAPABILITIES` 显式拒绝。continuable 路径的同一套闸门随 seam 补齐桥侧前置时加入（见 [continuable bridge seam note](../feature/2026-08-24-subagent-continuable-bridge-seam.zh.md)）。`tool-subagent` 以配置门控（`allowCwdOverride`，默认 false）把它暴露为模型可见的 `cwd` 参数——工作区隔离保持默认姿态，禁用实例上强行传参会被执行期拒绝（与 `run_in_background` 同款执行期执法）。

git worktree 编排刻意不进原生包：路径布局（`.claude/worktrees`）、分支命名、脏检查、keep/remove 生命周期都是部署约定。调用方在覆盖之上组合——先建 worktree，再把其路径作为 `cwd` 传入。桥保留 `engine/worktree.ts`，待其无人值守子任务迁往原生 start seam（批次 B4）时消费该覆盖。

## Alternatives considered

- **原生的 `worktree: 'auto' | 'on' | 'off'` 请求字段**，由 provider 负责创建与回收。否决：这会把能力包耦合到一种其他部署并不共享的 git 约定（布局、分支命名、保留 UX），而桥的 keep/remove 卡片本来就需要调用方掌控生命周期。cwd 覆盖表达的是可组合的那一半；git 留给调用方。
- **完全不加原生字段**——像今天一样全部桥内私有。否决：跨目录委派是通用能力（任何持有已备好目录的消费方都适用），且 B4 迁往 `startContinuable`/`start` 需要原生的子会话落位方式。
- **自由形态的相对路径**，按父 cwd 解析。否决：静默解析在信任边界上是路径穿越的隐患；一条绝对路径规则 fail loud，且子会话 header 不含歧义。

## Consequences

- in-process spawn/fork 子会话把覆盖写进持久化 header（`cwd`），resume 与列表都看到真实工作目录；进程外 backend（ACP、claude-code、codex、dsh-sdk）在任何子任务启动前 fail loud。
- 桥从批次 B4 起才消费该覆盖；此前其 `--dir`/`--worktree` 通路不变，两套系统无兼容垫片地共存（pre-release 姿态）。
- 模型可见面：`tool-subagent` 的 `cwd` 参数只在部署显式开启时出现，默认委派契约不变。
