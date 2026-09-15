# Agent Note: Sequence the reply render after the terminal card PATCH

Status: implemented

[English](2026-09-15-feishu-bridge-reply-render-terminal-race.md) | 中文

## 问题

回合收尾的投机回复渲染（#48）在回合终态卡片 PATCH 落地之前就 fork。渲染的状态 PATCH（首笔「渲染中」、30 秒 ticker、终态状态）从 `lastProgressCard` 重建卡片——即上一次已落地 `updateMessage` 的缓存。fork 时刻这份缓存仍持有终态前的流式状态（通常是「思考中」）：`patchReplyRenderStatus` 直接走 `updateRenderStatus`，而终态走 async-sender 的终端队列；两条通路只共享按消息的 `patchRateWait` 令牌桶，没有 FIFO。一旦首笔「渲染中」PATCH 排在终态之后落地，已结算的卡就会被旧运行态重刷——绿 → 思考中（紫色头 + 转圈 GIF）→「已发送」落地后再变绿——摆动持续最长一个渲染周期。

事故（2026-09-15，群 oc_1b7e133f4cdbca98229805023b9afe16）：群里最后一张进度卡在用户客户端上显示「思考中」，而回复图片（一条独立消息）渲染正常。服务端卡片其实已是终态——标题「执行完成 · 08:30:45 · 36」带「已发送 11s」状态行，08:30 后再无变动——摆动窗口早已过去；客户端冻结在了思考态渲染上，最可能的诱因正是该竞态造成的模板/图标快速翻转。错误回合同样存在此形状（对着红色 `markFailed` 终态）。

## 决策

`handleResultEvent` 的 export block 仍在原位计算一切——export key 提取、丢弃判定（读取分支前的 `sp` 状态）、显示文本、`exportContent` 缓存——但不再 fork；改为把调用捕获进 `startReplyRender` 闭包。fork 在终态卡 barrier（`await barrier()`）之后立即启动：barrier 排空终态 PATCH 所在的共享 async sender，因此首笔「渲染中」状态 PATCH 读到的缓存已持有终态卡。渲染 fork 的墙上时钟起点后移一个终态 PATCH 时长——非降级路径亚秒级；降级回合不携带 export key（丢弃判定会清空）。

## 已考虑的替代方案

- **修 `updateRenderStatus`，在取得限流槽之后重读缓存。** 不充分：令牌桶不是临界区，读取仍可能先于终态的缓存写入、而 PATCH 落在其后。
- **让渲染状态 PATCH 走 async sender，与终端 FIFO。** 能修整类问题，但要重铺 PATCH 管线（drain 语义、合并），对本次授权的修复而言不成比例。
- **fork 早点启动，传入「终态已落地」promise。** 保住了 LLM fork 的早启动，但为亚秒级收益跨 engine/plan-render 接缝加管线；挪调用点只需一行。

## 后果

- 卡片头状态单向推进——思考中 → 执行中 → 终态 → 渲染状态行；绿/红终态不再会被终态前的重建临时覆盖。完成与失败两种终态都覆盖。
- 渲染 fork 晚一个终态 PATCH 启动，图片投递同步后移亚秒级。完成分支在 barrier 之前抛异常的回合现在会完全跳过投机渲染（原先在分支之前已启动）——对 best-effort 渲染可接受，导出按钮的缓存内容不受影响。
- 残余（同类、未修）：pre-ask 渲染路径（`captureReplyForExport` → `renderAndDeliverReply`）在卡片停靠期间运行，其 30 秒状态 ticker 可能先于停靠 ask 的 settle PATCH 读缓存、后于其落地——亚秒级窗口，会把已结算的停靠卡重刷为等待态。关闭它需要按消息的 PATCH 串行化（FIFO），不是挪调用点。
- 测试：`tests/engine/engine-reply-render-order.spec.ts` 驱动真实事件循环，断言首笔渲染状态 PATCH 记录在完成（与失败）终态 PATCH 之后。修复前代码把它记录在最后一笔思考 PATCH 与终态之间——实测 RED，挪动后 GREEN。回归：plan-render-fork、plan-render-image、engine-m3-plan、followups、engine-events（246 用例）与全仓 typecheck 保持绿。
