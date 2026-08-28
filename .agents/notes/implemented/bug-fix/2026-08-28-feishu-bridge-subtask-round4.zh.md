# Agent Note: feishu-bridge 第四轮子任务修复——屏障死亡销账、原生递归、epoch 重臂

Status: implemented

[English](2026-08-28-feishu-bridge-subtask-round4.md) | 中文

## Problem

2026-08-28 对 feishu_bridge_subtask 替换原生 subagent 工具的第四轮审查（三个并行只读调研子任务 + 一个实机复现子任务）坐实了四个引擎缺陷与两个组合层缺口：

1. 被中断的子任务饿死已武装的 gather 屏障：`interruptNativeChild` 把记录翻成 reported，却从不从 `pendingSubtaskGather.expected` 移除该子任务，`settleNativeChild` 的 reported 守卫又跳过了 `subagent/end` 结算——后台面板的「全部停止」按钮与 `/done` 排空因此让阻塞中的 gather（[同步投递契约](../feature/2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.zh.md)）把父 turn 一直挂到 20 分钟超时，把主动停掉的子任务点名成「超时未回报」，而面板显示全部完成。原生 `interrupt_agent` 工具反而结算正确——它不碰引擎记录；不对称性出在桥自己的 interrupt 面。
2. 原生子任务派发自己的子任务必然失败：父锚点 `liveNativeSessionID` 只查 engine 聊天会话，子任务人设明文宣传的递归派发因此抛 "no live agent session"——而且 `getOrCreateActive` 在抛错前就已按 native id 铸造并持久化了幻影 bridge 会话（实机复现：一次失败的递归 spawn 把子任务 id 留在了 `sessions.json` 的 `activeSession` 与 `userSessions` 两张表里）。B4 note（[原生无人值守子任务](../feature/2026-08-24-feishu-bridge-native-unattended-subtasks.zh.md)）的「Native grandchildren work」声明从未成立。
3. 经 runtime 自己的 send_message 工具投递的追问，回答落进虚空：引擎只在自己的 send 路径上重臂结算兜底，追问 epoch 的 `subagent/end` 撞上 already-reported 守卫，答案被丢弃。
4. group 路径 spawn 失败泄漏预留的 worktree，且共享谓词 `worktreeMergedLossless` 把零提交的全新 worktree 判成「不无损」——连 native 路径自己的防泄漏清理也从未真正删掉过一个。

组合层缺口：仓库 bundle patch 从未禁用通用 `subagent`/`subagent_fork` 工具（runtime 归 `dsh-base` 所有，见[重复挂载 postmortem](2026-08-24-feishu-bridge-subagent-mount-duplicate-provider.zh.md)）（禁用只存在于 live 部署 profile），repo 组合因此暴露它们且结算通道引擎无法闭合——不在 `native_children`、report 工具已禁、`settlementNotice: external`：结果静默丢失。`subtask.timeoutSec` 则是 M4 移植以来的死旋钮（config 字段 → setter → engine 字段，全仓无读者）。

## Decision

- **屏障死亡销账：** `accountBarrierDeath` 把 aborted 结算文案累计进父会话已武装的屏障——期望集清空时解析阻塞 waiter——由 `interruptNativeChild` 与 `drainNativeDescendants` 两处调用。无屏障时什么都不投递，`/done` 清场保持静默。
- **原生递归：** native 调用方以自身 session id 作为派发锚点（adapter 的 `ctx.agents.get` 查不到时 fail loud），不铸造 engine 会话，并经新增的可选 `ContinuableDelegator.childCwd` 探针解析其 dir='' 子任务的继承基目录，worktree auto 模式据此比较真实仓库根。孙任务记录经 `parent_key` 链接、经 `reportChildToNativeParent` 结算。
- **epoch 重臂：** 结算监听器同时监听 `subagent/start` 并重臂名下子任务——无论追问经哪条通道投递，每个启动的 epoch 都结算自己的收尾输出。桥自己的 send 重臂在那里成为 no-op，且挪到投递落地之后才执行，失败的 send 不再搁浅无人结算的幽灵记录。
- **单入口回填：** bundle patch 以单入口理由禁用 `tool-subagent`/`tool-subagent-fork`；control 工具保持挂载（send_message 经重臂后已安全）。
- **worktree：** `worktreeMergedLossless` 把「无超出基线的提交」判为无损（未提交改动的守卫仍然保留树），group 路径两处失败点（fork 源不可达、spawnGroup 出错）都回收预留的 worktree。
- **死旋钮：** `subtask.timeoutSec` 直接删除——pre-release 不留兼容垫片；子任务 idle 仍由 `eventIdleTimeout` 治理。
- **模型可见契约：** 工具描述改为陈述代码的实际行为——跨目录 fork 可用、send 只对原生子任务排队（有人值守群子任务忙碌时拒绝）、「assistant」字面量仅 send 支持（interrupt 只接受 native 子任务 id；chatroom 助手是群路径）。

## Alternatives considered

- **让被中断子任务走完整结算路径（卡片 + 唤醒）。** 否决：Stop-all 一次会发 N 张 aborted 卡与 N 次唤醒；真正需要销账的只有已武装的屏障。
- **在桥组合里 deny send_message** 而非 start 重臂。否决：control 工具服务 runtime 级的 agent 面；重臂一次性恢复所有投递通道的语义。
- **在引擎里强制 fork 的跨目录禁止。** 否决：该能力可用（fork provider 带 `cwdOverride`），自带 skill 也已把跨目录 fork 写成可用，描述才是异类。
- **把 subtask.timeoutSec 接成 per-child 硬超时。** 否决：没有现有消费者；该旋钮在 TS 里从未生效，删除符合 pre-release 无垫片立场。

## Consequences

- 原生递归派发可用至深度上限；深度由 runtime 强制，桥侧不设计数器。
- `/done` 对真正脏的 worktree 语义不变；全新 worktree 现在被自动移除——README 的「未提交改动与未合并提交始终保留 worktree」本来就意味着这一点（全新 worktree 两者皆无）。
- 两个极窄投递竞态已闭合（后续提交）：在途的 native 父报告持有投递标记，`settleNativeChild` 与重复的 `reportNativeChild` 调用都尊重它（epoch 恰落在报告 await 窗口内结束时不再向 native 收件箱双投递）；`reconstructReplyCtx` 拒绝时一次性 reported 标志回滚——native 与群路径一致——后续 settle 或重启恢复仍可投递，报告不再永久丢失。
- live 部署 profile 仍带着自己的 tool-subagent 禁用行（现与 bundle patch 冗余）与过时的 silent-loss 注释；下次 reload 时应一并删除。

## Testing

`tests/engine/engine-subtask.spec.ts`（屏障死亡销账 ×4、native 调用方 spawn ×3、失败 send 重臂、group worktree 回收）、`tests/engine/done-worktree-merged.spec.ts`（全新 worktree 无损谓词）、`tests/engine/subtask-panel.spec.ts`（贴卡防重入）、`tests/tools/subtask-tool.spec.ts`（契约措辞钉）、`tests/engine/native-subtask-assembly.spec.ts`（REAL 组合，未改动仍绿）。feishu-bridge + chatroom 包套件 2546 通过；快照套件的 3 个失败在干净基线上同样失败（沙箱环境，已基线对照验证）。
