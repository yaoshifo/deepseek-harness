# Agent Note: feishu-bridge 流式终态缺口——surface 换新、发送失败、纯文本 finish、结构化卡 finalize

Status: implemented

[English](2026-08-31-feishu-bridge-stream-terminal-state-gaps.md) | 中文

## Problem

bridge 的契约是「每次 turn 退出都渲染终态卡」。有五条路径违反了它，第六个破坏了保护预览卡不被瞬态 PATCH 失败降级的分类器。(1) 排队消息接管换新了预览卡但只写 `state.preview` 不写 `state.progressWriter`——事件循环每次 select 边界从 state 重读两者，下一个事件经旧 writer PATCH 到上一轮已终态的卡（compact/card 进度样式；默认 legacy 样式掩盖了它）。(2) prompt 发送失败只发错误文本、不失败卡片，占位卡冻结在「执行中」且停止按钮还活着。(3) 纯文本 `finish()` 在最终文本与上次流式 PATCH 字节相同时跳过终态 PATCH——但流式 PATCH 不带 status，卡片停在黄色——且终态 PATCH 内联绕过 async sender，仍在队列的 coalescable running PATCH 可在其后落地，把已完成卡打回 running。(4) `CompactProgressWriter.finalize` 生产调用为零（result 路径 `void cp`）：card 样式下结构化进度卡的 state 永远停在 `running`。(5) `error` 事件路径失败 `sp` 但从不 finalize `cp`——与 (4) 同类。(6) `withTransientRetry` 把耗尽错误包装成 `new Error(String(lastErr))`，剥掉 AxiosError 形状，`feishuBusinessCode` 再也看不到 230020 限流码，预览卡恰好在分类器（45156fbdb8）专门赦免的瞬态 PATCH 错误上降级。

## Decision

surface 换新点永远同时写 `state.preview` 与 `state.progressWriter`——四处写点现已一致。prompt-send 失败分支与 `error` 事件路径遵循同一形状，镜像 Go `EventError` 顺序（engine_events.go:5068）：`await barrier()` → `if (!sp.inProgressMode()) await cp.finalize('failed')` → `await sp.markFailed()` → `state.eventsNeedResync = true`。`finish()` 删掉字节相同跳过——终态 PATCH 永远携带 completed status——并在内联终态 PATCH 前 `await this.async.barrier()`，与 `markStoppedSync` 同序。`cp.finalize` 按 Go engine_events.go:4481（`if !sp.inProgressMode() { cp.Finalize(...) }`）接回：`sp`（文本预览）与 `cp`（结构化进度）是两张独立的卡，守卫把终态路由到实际在展示的那个 surface。errored result 或 error 事件传 `'failed'`，而 Go 的 `EventResult` 无条件传 `Completed`——TS 事件循环有独立的 errored 终态分支，`failed` 让 `cp` 与 `sp` 一致（有记录的偏离）。`withTransientRetry` 耗尽时 rethrow 原始错误；重试上下文已在每次尝试的 warn 日志里。这些修复共享的顺序规则现已统一：任何内联终态 PATCH 必须先排空 async sender 队列（`barrier()`）——`cp.finalize` 是内联 PATCH 而 `sp.markFailed` 走 enqueueTerminal，不先 barrier 的话排队中的 running PATCH 可能落在终态之后。

## Alternatives considered

**删除 `CompactProgressWriter.finalize` 而非接回。** 否决：Go 对齐与 card 样式契约都需要它，两张卡是独立 surface——缺的只是 writer 的终态，不是整套机制。

**保留字节相同跳过以省 API 调用。** 否决：流式 PATCH 不带 status，省下的一次调用换来的是一张永远 running 的卡。

## Consequences

每条 turn 退出路径——result、errored result、error 事件、prompt-send 失败，以及本就正确的 idle/stop/硬上限路径——现在在两张卡上都渲染终态。`!sp.inProgressMode()` 守卫意味着 `toolProgress: true` 部署（占位卡占屏）在这些路径上有意不 finalize `cp`，与 Go 门控一致。retry 的 rethrow 改变了耗尽错误的消息形状；断言旧包装消息的那个测试已改为断言保留下来的业务码。

## Testing

`tests/engine/engine-queued-takeover.spec.ts`：card 样式接管后 PATCH 新卡而非上一张终态卡。`tests/engine/engine-send-failure-card.spec.ts`：发送失败占位卡转失败；事件流过后结构化卡转失败。`tests/engine/engine-card-progress-finalize.spec.ts`：result 路径的 completed 与 failed finalize；error 事件使结构化卡转失败。`tests/streaming.spec.ts`：字节相同 finish 仍交付 completed status；终态之后没有 running PATCH 落地。`tests/feishu/transient-retry.spec.ts`：耗尽 rethrow 原始错误形状，业务码存活供 `isTransientPatchError` 使用。
