# Agent Note: 评审后集中修复桥的交付、渲染与会话路径

Status: implemented

[English](2026-09-14-feishu-bridge-review-fixes.md) | 中文

（英文版为权威记录，本文件为其中文对照。）

## Problem

同日对 2026-09-14 各审计修复批次的事后评审在四个面上发现九处缺陷：

- 答案交付警告在 `await barrier()` 之前读取 `sp.answerDelivery`，而流式卡终局 PATCH（及其 fallback 分类）只在 barrier 内执行——该批次瞄准的最坏情形（终局 PATCH 失败且 fallback 补发也失败）仍以纯成功收官，无警告、无存档。
- 被强杀回合的部分交付写入的 `state.answerDelivery` 无消费者（kill 路径在警告块之前清理并返回），且其纯文本补发缺 turn-end 的 `inProgressMode` 守卫，把失败卡仍实时承载的段落重发一遍。
- gather 汇总在 report 去重检查之前收录每个 child 的报告全文，先直发过同文的 gathered child 仍被读两遍。
- SIGTERM（`/reload` 的重启路径）完全绕过去抖的 session-store 保存（信号死亡不触发 `beforeExit`），去抖窗口内的变更丢失。
- 启动后的 reload 收尾在 `await captureBuildInfo()` 之后访问 `ctx.tools`，HMR 已销毁的 fiber 使该访问变成七个 unhandled rejection，判整套 vitest 失败。
- 初始 'rendering' PATCH 是 fire-and-forget、不在 `progressInflight` 内，晚落地的初始 PATCH 可把已定格卡片的状态行翻回渲染中。
- deliver 阶段 abort 且 PNG 渲染同时失败时，渲染 settle 成 `failed` 而非 `cancelled`——用户自己的取消读作渲染失败。
- `classifyDeliveryFailure` 把任何 HTTP 状态——含 502/503/504——判为 `'failed'`，其措辞诱导重发，而网关 5xx 并不证明服务端跳过了该 create。
- 五个交互卡片发送路径不带意图 uuid 且保留 deadline 重试，投递后超时可双发带可点按钮的卡片。

## Decision

**警告移到 barrier 之后。** sp→state 的答案交付同步与警告/存档决策在 `await barrier()` 之后、✅ 收官卡之前执行。无卡平台（其 `deliverAnswerText` 同步写状态）行为不变。回归测试给终局 PATCH 加真实宏任务延迟——微任务时序会空洞通过。

**kill 路径同款结算。** kill 路径在交付部分答案前记录 `lastBaseResponse`，交付失败经与 turn end 相同的警告+存档块结算；分段补发尊重 `inProgressMode`：仍实时承载流式段落的卡片不再以纯文本重发该段。

**gather 去重。** 报告与其先前 `send_message` 直发正文逐字相同的 gathered child，在汇总中按共享的一行状态收录（卡片仍带全文），措辞与单报路径一致。

**SIGTERM flush。** `hookSigtermFlush()` 是引用计数、幂等的 disposer，Engine 构造时注册、`stop()` 时注销。listener 同步 flush 挂起的保存后 re-raise `SIGTERM`（`process.kill(process.pid, 'SIGTERM')`）——once-listener 已移除，进程死于与 flush 前完全相同的信号，绝不把信号死亡伪装成干净退出。守护进程的长连接撑着事件循环，不 re-raise 进程会在自己的终止信号下存活。

**reload 收尾 fail-soft。** 启动后回调整体包裹：中途死掉的 fiber 记日志并放弃结算（替换 fiber 会重跑；marker TTL 约束重试），而非从已销毁上下文复活 `ctx.tools`。

**初始 PATCH 入排空队列。** 初始 'rendering' PATCH 的 promise 加入 `progressInflight`，`drainProgress` 四条出口全覆盖，晚到的初始 PATCH 不可能落在终态之后。

**abort 记 cancelled。** 两处 deliver 阶段 catch 按 `parentCtl.signal.aborted ? 'cancelled' : 'failed'` 分类；abort 后仍送达成功的保持 `delivered`。

**5xx 归 unknown。** `status >= 500` 判 `'unknown'`；只有 500 以下的状态码或飞书业务码才证明拒绝（`'failed'`）。

**卡片幂等。** 每个卡片发送路径（reply card、send card、send card with handle、send preview）为每次发送意图铸一个 uuid——在该路径内部的 create/reply 回退间共享——并传 `retryOnDeadline: false`，与文本面的 u6 契约对齐。

## Consequences

答案无法证明落地的回合在所有路径——含卡片终局失败、kill 路径部分失败——都会警告并保存可恢复副本，而不再只有同步文本路径。被强杀的回合不再重发失败卡仍承载的段落。gather 汇总不再重复 child 已直发过的正文。`/reload` 重启最多丢上次同步保存之后的写入，而非整个去抖窗口。`pnpm run test` 恢复绿（unhandled rejection 消失）。abort 下卡片状态一致定格。网关 5xx 不再诱导可能造成重复答案的重发，交互卡片不会因 deadline 重试双发。

## Alternatives considered

reload 收尾曾考虑在 `captureBuildInfo()` await 前捕获 `ctx.tools`：该引用销毁后仍可用，会让死 fiber 的继续体从已停 platform 抢发通知、抢先消费完成 marker，故弃。SIGTERM flush 后用 `process.exit(0)` 会把信号死亡伪装成干净退出、改变 launchd/systemd 观测语义，re-raise 保持修前死亡语义。5xx 维持 `'failed'` 被否：只有 500 以下状态码或飞书业务码才证明服务端拒绝了该 create。超出 uuid 契约的服务端卡片幂等不在本次范围——客户端 uuid 加免 deadline 重试已把双发窗口压到一次尝试。
