# Agent Note: feishu-bridge HMR 重载后的 WS 僵尸连接静默丢消息

Status: implemented

[English](2026-08-21-feishu-bridge-ws-zombie-on-hmr.md) | 中文

## Problem

生产事故 2026-08-21 22:22（Dev 服务器，spawn 群 oc_124f）：一次 Cordis HMR 配置重载（新增 7 个 project）几分钟后，用户经 `/spawn` 新建子群并发出 "hi"——就绪卡已到，但这条消息无声消失：无表情回应、无进度卡、无日志、无报错。重载之前创建并使用过的另一个 spawn 群则端到端正常。

根因：`FeishuPlatform.stop()` 是刻意的 no-op（「teardown 靠进程退出」）。Cordis HMR 配置重载会 dispose 插件并重建全部 engine；`ctx.effect` 的释放链跑 `engine.stop()` → `p.stop()`，但什么都没关。旧 platform 的 `WSClient` 保持连接，重载后该飞书 app 便持有**两条**活跃长连接（旧僵尸 + 新）。飞书把 app 的事件派发给它的并发连接之一，于是约一半事件落在僵尸 platform 上——其 handler 指向已 dispose 的 engine。「/spawn」恰好落在新 platform（成功建群）；随后的 "hi" 落在僵尸上。僵尸的内存 `SpawnedChatStore` 没有这个新群（注册只写进新实例的内存，共享的磁盘文件不会被重读），`isSpawned` 判 false，群消息 @-闸门把无 @ 的消息静默丢弃。证据：8 个 app 共 9 条 TCP 连接（多出的一条正是重载前唯一在线 app 的僵尸）、日志零输出、会话注册表未被触碰。

任何部署（Dev 服务器与本机开发虾 daemon）上每次 HMR profile 热改都会产生一个这样的僵尸；消息丢失概率随进程启动以来的配置重载次数累积。此前未定位的真机悬案（如 spawn 就绪卡从未出现）很可能同源。

## Decision

`stop()` 现在关闭 WS 传输：`defaultWsStart`（`packages/acp/feishu-bridge/src/feishu/platform.ts`）保留 `WSClient` 引用并 resolve 出一个包装 `close({ force: true })` 的关闭句柄；`wsStart` seam 类型放宽为 `Promise<void | WsClose>`，17 个什么都不返回的测试桩无需改动。`FeishuPlatform.start()` 存下句柄；`stop()` 幂等地消费它（未 start 过的实例、无传输的桩保持 no-op）。用 force-terminate 是有意的：dispose 不应等待优雅的 WS 关闭握手。

## Alternatives considered

**dispose 时只清 `handler` 不关 socket。** 连接仍占用该 app 的飞书连接配额并继续收到事件然后无处可去——派发分裂依旧存在，只是换了失败形态。

**配置重载时复用 platform。** 不成比例：插件的按-project 装配本就有意重建 engine，dispose 链已经在跑；关掉自己拥有的传输是这条链缺失的另一半。

## Consequences

HMR 配置重载恢复安全：被 dispose 的 platform 关闭连接、替代者连接，每个 app 恰好持有一条活跃 WS 连接。`wsStart` seam 顺带可用于在测试中断言 teardown。注意修复只覆盖插件自己的 WS client；SDK client 内部的重连循环在别处不可观测。

## Testing

`tests/feishu/platform.spec.ts` → "FeishuPlatform WS teardown"：stop() 恰好调用一次 wsStart 返回的关闭句柄（重复 stop 为 no-op）；stop() 容忍无句柄的 wsStart；start() 之前的 stop() 为 no-op。先红（close 从未被调）后绿。包内 2045 测试全绿、oxlint/tsc 干净。真机验证：重启 daemon 清掉僵尸（事发群重发的 "hi" 得到回复）；修复上线后一次 HMR touch 应保持连接数不变。
