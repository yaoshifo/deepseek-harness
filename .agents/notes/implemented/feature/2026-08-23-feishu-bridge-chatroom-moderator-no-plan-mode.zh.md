# Agent Note: 聊天室主持人永不进入 plan 模式

Status: implemented

[English](2026-08-23-feishu-bridge-chatroom-moderator-no-plan-mode.md) | 中文

## Problem

`/chatroom` 流程反复向群里发 ExitPlanMode 审批卡。成因两层。其一，主持人（hub 会话，`CC_CHATROOM_MODERATOR=1`）是唯一不被 `sessionBypassesPermissions` 升级的聊天室人设，其生效模式走 `modeOverride || defaultMode`——而生产 profile 每个项目都配 `agent.mode: plan`，每次 `startSession`（含 agent 回收后的 resume）都把 plan 模式重新武装。其二，主持人 priming 里的「## plan mode」段指示模型先调 ExitPlanMode 带一行计划再驱动——但 bare persona 以 `complete: true` 整体替换系统提示，`plan:policy` 段不可见，模型无法自证「若你处于 plan mode」这一条件，倾向于照做 → 每次开圆桌一张 plan 审批卡。角色/直聊/研究助手早已走 bypass、从不进 plan；挑角色/选题阶段因 engine 在 `chatroomPickActive` 窗口内自动批准 ExitPlanMode，从不曾出卡。

## Decision

adapter 会话启动的 mode 应用处：会话 env 带 `CC_CHATROOM_MODERATOR` 时，任何来源（项目默认或一次性 override）解析出的 `plan` 一律降级为 `default`。env 旗标贯穿主持人整个生命周期，因此每次 startSession——含回收后的 resume——都重新应用降级；`endChatroom` 清旗标后 hub 回到项目默认。工具审批不受影响（那半边保持 Go effectiveMode 对齐）。主持人 priming 的 plan 舞步段删除；直聊 wake 的死 plan 提示删除（直聊会话恒为 bypass，永不处于 plan 模式）。两个 pick 唤醒（`beginChatroomPick`、`beginChatroomTopicPick`）带一次性 `modeOverride: 'default'`，pick 回合同样跳过 plan 舞步；hub 带活跃 agent 进程时 override 不生效，engine 的 pick 自动批准仍是兜底。

## Alternatives considered

**只删 priming 文案，保留模式。** 否决：plan 状态保持武装、并在每次回收重启时从项目默认重新拉起；`exit_plan_mode` 仍在工具目录里，计划文件 / planRender 路径仍可能被一次误触的 exit 调用牵动。状态是根，文案只是扳机。

**把主持人也升为 bypass。** 否决：那会改到 plan 模式之外的工具审批语义；主持人有人盯着，其工具审批仍有意义（见 [effectiveMode bypass](../bug-fix/2026-08-20-feishu-bridge-effective-mode-bypass.zh.md)）。

**在 pick 开始时就置 moderator 旗标，替代一次性 override。** 否决：提前置标会把 pick 阶段的 persona 换成 bare 主持人提示，并给 cancel/超时路径新增旗标清理负担，而行为上无收益——pick 阶段从不曾出卡。

## Consequences

聊天室流程不再发 plan 审批卡：主持人直接驱动 gather/ask/note。继承了 plan 的主持人会话日志在首次 session start 时多一条 `plan/mode {active:false}` 提交。`/chatroom end` 之后 hub 回到项目 plan 默认，编码会话保持 plan-first 行为。聊天室期间在 hub 显式 `/mode plan` 会在下一次 session start 被降级——规则刻意绝对。这是对 Go effectiveMode 的刻意偏离，仅限 plan 模式。

## Testing

`tests/agent-dsh/adapter.spec.ts`：主持人会话把继承的 plan 默认与显式 plan override 都降级（两种来源都 `planMode.set(false)`）。`tests/engine/engine-chatroom-gather.spec.ts`：主持人 priming 不含 plan 舞步文案。`tests/engine/engine-chatroom.spec.ts`：直聊 wake 只带裸 topic；两个 pick 唤醒带 `modeOverride: 'default'`。真机：每条 `/chatroom` 进入路径（选题、挑角色、显式多角色、1:1 直聊）全程无 plan 卡；`/chatroom end` 后 hub 仍按项目 plan 默认运行。
