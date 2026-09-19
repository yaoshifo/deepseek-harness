# Agent Note：飞书群新增 `/plan`——运行中切换计划模式

Status: implemented

[English](2026-09-20-feishu-bridge-plan-command.md) | 中文

## 问题

本部署里每个会话都以计划模式开局（项目配置 `agent.mode = plan`），却没有任何办法把会话**切回**计划模式。斜杠命令的分发归桥自己的命令表，而这个装配从未挂载 `dsh-commands`，所以 dsh 原生的 `/plan` 命令在飞书里不可达：发出去的 `/plan` 只会作为普通文本到达模型，日志里的计划状态一动不动（该事实 2026-08-28 首次确认，本次改动前又按当前代码复核了一遍）。其余通路都答不对题：`/spawn --plan` 把计划模式钉在**新**子群上，cron 任务可以带 `mode=plan`，项目默认值只在全新会话启动时生效。

Go 的 `/mode` 也不是缺的那一半。那条命令在 2026-08-21 被裁定不迁移（见 `docs/OPERATIONS.md`），而且它的语义是一次性覆盖：只武装**下一次**会话启动，因此一个已批准计划的既有会话无法在不重启会话的前提下重新出计划。

## 决定

桥新增 `/plan`，经 `Engine.registerCommand` 挂到会话（session）帮助分组。

**三种形态。** `/plan` 进入计划模式；`/plan off` 退出；`/plan <任务>` 先进入计划模式，随后剥掉命令行、作为一条普通消息继续走自己的投递路径（忙时进队列、空闲时起一轮），此时只有「延后生效」或「不可用」才回一条提示，正常切换保持静默。

**活会话经新能力切换。** `AgentSession` 新增可选能力 `PlanModeSwitcher`（`setPlanMode(active)` 与结构探测 `asPlanModeSwitcher`），由 `DshAgentSession` 实现为对 `ctx.planMode.set(handle.agent, active)` 的转发。状态归控制器所有，选择会在下一个被接受的回合内 pre-step 生效，回合之间则立即落盘。原生 `set()` 在「请求的状态恰好等于已排队的选择」时报 `noop`，所以该能力会再读一次 `planMode.get(agent).pending`，把这种情况报成 `queued`——否则在切换已排队时重复发 `/plan` 会被回话成「已经在计划模式里」。

**冷会话武装消息本身，绝不碰 adapter 全局。** 没有活会话时，`/plan <任务>` 设置 `msg.modeOverride = 'plan'`，由 `processInteractiveMessageWith` → `getOrCreateInteractiveStateWith` 在这条消息启动会话时消费。adapter 的 `setSessionMode` 有意不碰：它是进程级、一次性的，会被下一个启动会话的群吃掉。冷会话上裸发 `/plan` 只提示用户先起一个会话。

## 考虑过的替代方案

- **挂载 `dsh-commands`、把原生命令面整体暴露出来**（`/plan`、`/compact`、`/goal` 等）。用户在设计访谈中否掉了：为了一个需求引入大得多的命令面，还要逐条处理渲染与权限问题。
- **活会话复用 `setSessionMode`。** 否掉：会话活着时引擎会忽略模式覆盖（只记一条警告），切换会静默不发生。
- **让 `/plan` 改每群的默认模式。** 否掉：那只在重启后生效，答不了「给正在进行的会话重新出计划」。
- **`/plan <任务>` 用 steer 把文本塞进运行中的回合**（`/ps` 的形态）。否掉：新任务该走队列路径，塞进进行中的回合只会给模型一个做到一半的上下文。

## 后果

- `/plan` 不再是给 agent 的普通文本。以前会以字面量 `/plan` 到达模型的消息，现在被命令消费——这是有意的，也是命令名与原生同名所致。
- 计划模式仍是提示词级引导而非硬门（2026-08-28 的裁定不变）：命令切换的是那份引导所读的状态，工具权限一律不动。
- 桥的状态行不渲染计划状态，所以切换是否落地，即时只有执行回话能确认。
- 挂起的计划审批卡仍然拥有它的审批：`/plan off` 只移动状态，卡片照旧可点。
- 裸 `/plan`、`/plan off` 随消息带的文件会被丢弃（纯图片消息本来就不进命令分发）；本次明确不处理。
- 测试钉住命令（`tests/engine/plan-commands.spec.ts`：分发、前缀 `pl`、各结果文案、任务穿透、冷会话带任务与否、卸载），能力对假控制器（`tests/agent-dsh/adapter.spec.ts`，含 `noop`→`queued` 一例）与真控制器分别覆盖（`tests/agent-dsh/adapter-seams.spec.ts`：活会话切换会写入 `plan/mode` 事件），外加装配面（`tests/command-registration-effects.spec.ts`）。
