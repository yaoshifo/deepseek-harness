# Agent Note: feishu-bridge 挂起追问的自然时间豁免硬回合上限；挂起卡片显示「等待中」

Status: implemented

[English](2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.md) | 中文

## Problem

2026-08-28，oc_9d385 派生群（推送项目分支）：turn 1 于 21:15 启动，跑了 184 次工具调用，23:04:14 调用 `ask_user_question`（「后续处理」追问卡）后挂起。挂起期间 idle 定时器被有意解除——用户决策不算 stall——turn 就这样静默挂了一夜。07:15:55 用户输入 "push"；引擎正确地将其路由为追问的 custom 答案（tool/result `{"answers":[{"id":"followup-remaining","selected":[],"custom":"push"}]}`），agent 恢复执行——一秒后，只在事件到达时评估的 hard-cap 检查测得 `now - turnStart`（约 10 小时）> `softCap × 3`（`absoluteTurnTimeoutSecs: 3600` 下为 3 小时），强制销毁 turn。用户的回答被它自己唤醒的检查销毁，重置通知还要求重发，用户不得不重走一轮完整 plan 审批。结构性缺陷：挂起的 ask 唯一等得到的事件就是用户的回答，所以任何开放超过上限的追问，其回答必然被吞。

同一事故暴露的第二个缺陷：追问挂起时的 `completeAndDetach` 在权限卡落地之前就渲染绿色「执行完成」卡——群里「执行完成 · 07:38:57 · 2」正下方就是它在等的 ‼️ 权限请求卡——挂在用户身上的 turn 看起来已经完成，实际什么都没发生。

## Decision

- **上限时钟：** 记账挂起追问的自然时间（`InteractiveState` 上的 `capParkStart`/`capPausedMs`，在每个 `pendingAsk` 清除点由 `resumeCapPark` 入账），判定改为 `now - turnStart - capPausedMs - capParkedNow > hardCapMs`，已入账与在途的挂起时间均豁免。用户决策不是上限要杀的失控活动——把 idle 解除的同一原则延伸到到达时检查。扩展了 [watchdog per-turn 重置笔记](2026-08-21-feishu-bridge-watchdog-per-turn-reset.zh.md) 拥有的每回合时钟语义。
- **等待卡：** 追问挂起时的 detach 渲染新的蓝色 `waiting` 终态（「等待中」）而非绿色「执行完成」——挂起前的段落已投递，turn 本身仍在等。turn 结束与思考边界的分段切分仍用「执行完成」。
- **强杀清理对齐：** force cleanup 杀 turn 前先把运行中的卡渲染为失败（`markFailed`，已终态的卡自然 no-op——与 stall 路径对齐），重置通知改为说明 turn 已终止、上下文已保留、挂起的追问/审批卡已失效。与 [agent 异常退出失败卡笔记](2026-08-22-feishu-bridge-abnormal-exit-fails-preview-card.zh.md) 同族。

## Alternatives considered

- **追问结算时重置 `turnStart`。** 否决：work→ask→answer 循环每次都继承全新预算，不断提问的 turn 永远撞不到上限；记账挂起时间改为约束总活跃泵送时长。
- **用墙钟定时器评估上限，让击杀在越限时刻发生。** 否决：那会主动击杀挂起的追问——销毁待答问题——正是本修复针对的失败类别；到达时评估加豁免把击杀保留给真正活跃的 turn。
- **强杀时把孤儿追问卡 PATCH 成禁用终态。** 缓议：`sendPermissionPrompt`/`sendAskQuestionsCard` 返回 void，句柄管线（sendCardWithHandle + 卡片 JSON 缓存 + 禁用按钮重建）是独立改动；豁免之后带挂起追问的击杀需要活跃时间自身越限，且通知已点名失效。

## Consequences

- 开放超过上限的追问——含隔夜——可正常作答；回答会被送达并处理。
- turn 现在可以通过反复追问跨越无界自然时间（每次挂起都豁免）；活跃泵送时长仍有界，trickle-forever 保护完好。
- 挂起卡显示「等待中 · <末次工具时间> · <计数>」，直到 ask 结算；[挂起卡结算笔记](2026-08-28-feishu-bridge-parked-card-settles-with-ask-outcome.zh.md)随后把头部 PATCH 为结果状态（已批准/已拒绝/已回答/已取消）。权限后重启仍开新运行卡，见 [post-permission 卡重启笔记](2026-08-20-feishu-bridge-post-permission-card-restart.zh.md)（其卡前 finalize 现在落蓝色而非绿色）。
- 诊断日志（预览卡发送/删除、尾部守护 bump）已落地，用于追查 2026-08-28 的另一异常：一次 plan 模式 turn 内 19 条精确 3.0 秒间隔的撤回墓碑（07:37:59–07:38:53），并行群与前夜 2 小时 turn 均未复现——机制未定案。

## Testing

`tests/engine/engine-events.spec.ts` "parked-ask wall time is exempt: answering past the hard cap keeps the turn alive"（本地回退减法项验证过旧检查下变红）；`tests/engine/engine-ask.spec.ts` 挂起记账（park 起点置位、settle 入账）；`tests/streaming.spec.ts` `completeAndDetach(park)` 渲染 waiting 状态；`tests/feishu/card.spec.ts` 等待头渲染蓝色「等待中 · ts · n」。
