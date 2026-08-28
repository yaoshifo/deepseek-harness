# Agent Note: feishu-bridge 预览卡位移自愈 —— 活动账本取代周期尾部探针

Status: implemented

[English](2026-08-28-feishu-bridge-preview-displacement-ledger.md) | 中文

## Problem

周期尾部守卫（[2026-08-26 note](2026-08-26-feishu-bridge-preview-tail-guard.zh.md)）带着两笔生产成本。其一，每次治愈都是撤回+重发，而飞书撤回（`DELETE /im/v1/messages/:message_id`）是平台唯一的重排原语，每次撤回必留一条「已撤回」墓碑——按周期重发让墓碑数正比于被压次数，即使卡片并没有新状态可展示；2026-08-28 一次 plan 模式 turn 留下了 19 条精确 3.0s 间隔的墓碑（根因未定案；周期重发机制正是其载体）。其二，每个活跃卡每周期一次 `im.message.list` 探针，且按固定节拍治愈，侧栏摘要错位最长一个周期。产品需求没有变，也排除了只在完成时检查的方案：turn 进行中工具过程卡必须占住会话最新消息位——飞书侧边栏摘要只跟踪最新消息，且只有原地 PATCH 能持续刷新它。

## Decision

平台维护按会话记的活动账本——`Map<chatID, lastActivityMs>`，进程内存、易失：重启即清零，而重启后下一张预览卡必然落在会话尾部，空账本恰是重启后的正确状态。被记录的活动：每一条 `im.message.receive_v1` 投递（在路由丢弃判定之前记录，因为被 bot 忽略的消息同样物理地压住了卡片、占着摘要位）与每一次非预览出站发送——`sendNewMessageToChat`、`replyMessage`、`replyCard`、`sendCard`、`sendCardWithHandle` 发送成功后记账；文件与图片投递都汇入这几个方法。刻意不记：`im.message.recalled_v1`（重发自己的删旧会触发该事件，记账等于永久自位移）；卡片自身发送——`sendPreviewStart` 不经过这些路由方法，首发与重发天然豁免，并发预览卡因此不会互相触发 bump 循环，后发者占住尾部、先发者原地继续 PATCH。

异步的 `PreviewTailProber.previewIsLatest`（每周期一次 `message.list`）替换为同步的 `PreviewDisplacementProber.previewDisplaced(handle, sinceMs)`。`StreamPreview` 在首发与每次重发成功时记录 `placedAtMs`；每次节流内容刷新时，账本判定被压住的卡改走 `reissueLocked(content)` 携带本次刷新内容在尾部重发，而非原地 PATCH——每条墓碑从此都同时送达新状态，流式期间的治愈从一个探针周期缩短为一个刷新间隔（约 800ms）。重发发送失败则降级为原地 PATCH，下次刷新重试。改名/头像系统消息保留 chat-changed 推送 bump 即时治愈：卡片头部 PATCH 与该系统消息存在竞速，等下个内容节拍可能让整个静默工具执行期内侧栏都停在系统消息上。turn 结束的基线头像重绘只在完成处理器的终态卡渲染之后执行：其系统消息落在一张永不重发的卡上，高频重绘因此不再产生墓碑。`streamPreview.tailCheckMs` 与守卫的定时器机制整体移除。诊断日志行 `feishu: preview card sent/deleted` 由 `console.debug` 升为 `console.info`，作为卡片生命周期常开的运维可见面——未来任何 churn 上报都靠它观察。（此前一度怀疑 daemon 运行时吞掉 `console.debug`，该怀疑是错的：造成「零命中」的其实是部署滞后——运行中的 daemon 进程 2026-08-27 21:15 启动，比埋点提交早了十二小时，从未加载过那些行。用完整 profile + 采样探针启动验证过，daemon 语境下 `console.debug` 正常输出。）

## Alternatives considered

**只在完成时检查一次。** 被产品所有者否决：侧栏要在 turn 进行中反映实时 tool-process header，而非仅在完成时。

**保留周期探针，加防抖或位移源分类。** 否决：无新内容的重发墓碑与 churn 病理只会变稀有、不会结构性消失，每周期的 `message.list` 轮询也仍在。

**把自己 turn 中途的消息延迟到回合结束再发。** 否决：交付物与子任务报告会迟到，ask 卡根本无法延迟；发送路径排队是比账本更大的改动。

**账本 + 任何位移源都立即 bump。** 对用户消息否决：紧跟用户刚发的消息 bump，重送的是旧状态、还会在一秒内把用户的消息顶上去；下个内容节拍再治愈，让位移者——它本身就是最新信息——先占住摘要位，直到卡片带着新状态再夺回尾部。

## Consequences

侧栏摘要流式期间一个刷新间隔内治愈、静默工具期在下个工具事件治愈；`im.message.list` 轮询消失；每条重发墓碑都携带新状态；周期性重发的 churn 病理类——19 条墓碑事故的载体——被结构性消除，但该事故根因仍不归因。合法墓碑数仍等于被压次数。三个活跃群的实测数据显示占主导的位移源曾是 bridge 自己的头像阶段重绘：样本中每条墓碑都紧跟「开发虾 更新了群头像」系统消息（侧栏会显示这类系统消息，因此必须夺回尾部）。其中高频的 turn 结束基线重绘原本先于终态卡渲染执行，现已挪到渲染之后、不再产生墓碑；余下的绘画位移只剩罕见的 attention 重绘（stall 超时、子任务子会话死亡），它们发生时卡片仍在运行态。账本看不到的位移类别（改名/头像之外的系统消息）在下一次被记活动前保持未治愈。重启行为构造上安全：治愈状态全部易失，新卡必然落在尾部。

## Testing

`tests/feishu/preview-tail.spec.ts`：入站消息（含被路由丢弃的群消息）与出站文本/卡片发送记账；`sendPreviewStart` 豁免；recall 事件永不记账；thread 卡永不判定位移；非 handle 参数抛错。`tests/streaming.spec.ts`「displacement heal」：被压住的刷新携带本次内容重发、未被压住的原地 PATCH、重发失败降级原地 PATCH、discard 与 markRecalled 停用自愈、无探针能力的平台永不重发。包测试套件通过（2340 项），仓库 typecheck 通过。
