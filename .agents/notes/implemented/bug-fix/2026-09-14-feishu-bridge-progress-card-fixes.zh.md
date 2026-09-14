# Agent Note: 退役不可达的结构化进度卡，修掉流式卡片的重复 PATCH

Status: implemented

[English](2026-09-14-feishu-bridge-progress-card-fixes.md) | 中文

## Problem

2026-09-12 的[进度卡审计](../../../../packages/acp/feishu-bridge/docs/PROGRESS-CARD-AUDIT.md)在 bridge 的卡片链路里查出七个问题，其中两个是结构性的：

- 结构化进度卡链路（`CompactProgressWriter` 加飞书 payload 渲染器，跨三文件 766 行）不可达：移植把 Go 的 `ProgressStyle()` 方法变成了 `FeishuPlatform` 上的字符串字段，而消费端仍按函数探测，于是 writer 构造器在置 `enabled` 之前就返回，`progress_style` 成了「配了却无效」的旋钮。
- 流式预览在思考阶段反复 PATCH 逐字节相同的卡片：去重守卫只覆盖无状态的纯文本，而标题带墙上时钟时间戳，于是不携带任何新信息的 flush 仍会整卡上传。

其余五项：异常逃出回合循环时，它驱动的卡片冻在「执行中」且停止按钮仍可点；`streamPreview` 的两个节流旋钮在用户真正盯着的这条路径上无效；位移重发没有节流；PATCH 限流的注释写「每条消息」而实现是机器人级；以及四个导出没有生产调用者。

## Decision

**重复 PATCH。** `StreamPreview.flushLocked` 把带状态的内容按整卡渲染结果做键——正文、标题状态、时钟、工具调用计数、待报子任务、后台提示——当该键与平台最后接受的那次相同时直接返回，除非位移探测报告卡片已被顶下去。纯文本守卫不变。`lastSentKey` 只在内容真正到达平台时写入、PATCH 失败时回滚；而那些只清 `lastSentText` 的重置点（showPlaceholder 与 updateProgress）不动这个键——在那里清掉会让去重彻底失效。

**冻卡。** 回合循环的三处兜底 catch 通过 `StreamPreview.markFailedIfUnsettled()` 收尾它们留下的卡片；该方法对已完成、已失败、已截断或已渲染停止态的卡片不做事。因此 drain 阶段的失败不会再重渲一张回合已经绿色收尾的卡。主处理器按槽位键查状态：它失败的 `try` 块里那个 `state` 绑定只在该块内可见。

**结构化链路（用户裁定：删除）。** `src/progress-compact.ts`、`src/feishu/progress.ts` 的 payload 渲染器、`src/progress.ts` 的 payload 类型与 style 解析器、`spinnerKeyForItems`、平台的 `progressStyle` 字段与 `supportsProgressCardPayload()`、`progressStyle` 配置键，以及只服务于 payload 的测试全部删除；预览内容类型收敛为 `ProgressContent`。配置里仍带 `feishu.progressStyle` 的项目在加载时失败：schemastery 会保留未知键，只靠校验会让这个已删除的旋钮以静默无效的形式存活。

**刷新间隔（用户裁定：做成可配置）。** `streamPreview.progressFlushIntervalMs` 管辖进度路径——缺省 300，即卡片在它还是模块常量时使用的值；`0` 表示每次变化都 PATCH。三个更早的 `streamPreview` 旋钮改为如实描述它们真正调的东西：出现第一个思考或工具事件之前的纯文本窗口。

**位移重发。** `previewReissueCooldownMs`（2000，对齐引擎的聊天变更 bump 去抖窗）限制每张卡的重发频率，使「改名 + 换头像」两条通知并成一次尾部搬移。被抑制的重发仍会原地 PATCH 其内容：推迟的只是尾部位置。已结算的卡片从不重发，因此该窗口不需要终态例外。

**PATCH 节奏。** `patchRateWait(cardKey)` 等待它即将 PATCH 的那条消息自己的桶；桶按需创建、随卡片删除释放。机器人级共享桶已移除——正是它让注释所称的「每条消息 5 QPS」不成立，并把每张卡摊薄成 5/并发卡数 次 PATCH 每秒。

**死残留。** `resetProgressEntries`、`truncateToMaxLines`、`isThinking` 渲染分支与 `progressNoOutputText` 都没有生产调用者；`CompactProgressWriter.append` 随链路一起离开。

## Alternatives considered

**修好结构化链路而不是删除。** 这条链路要的不止是类型修复：流式预览与 compact writer 都会建卡，所以移植还得决定谁拥有一个回合的卡片、把 writer 从未收到的 `tool_use` 事件喂进去、并在回合结束时收尾它的卡——而且没有任何部署配置过这个样式。删除移走三个文件 48% 的内容与一个不可能生效的配置键；真要做结构化卡，可以从 Go 源码重新移植。

**在按消息分桶之下保留机器人级总量帽。** 共享帽能把守护进程的总 PATCH 速率恒定限制在 5 QPS，与有多少张卡在跑无关。它落选是因为它正是审计指出的摊薄本身，而且它让按消息那一层不可观测：有共享帽时，一张卡的突发会吃掉另一张卡需要的令牌，于是单卡上限既无法兑现也无法测试。实际暴露面有限——单卡的 flush 节奏把它压在约 3.3 次 PATCH 每秒，重复 flush 现在会被跳过，且线上日志没有限流报错。

**只改文档（F4）。** 写明三个旋钮够不到用户盯着的那张卡是零风险的，但它让卡片真正的节奏——长任务里唯一暴露给用户的那个——不可配置，而 schema 又承诺可以调。

**保持位移重发不受节流。** 重发路径当初故意不节流，是为了让改名或换头像通知不能吃掉最后一次尾部搬移。冷却窗的范围保住了这个理由：搬移仍会发生，只是每个窗口一次，期间内容照旧原地 PATCH。

## Consequences

思考阶段不再上传那些唯一变化是时钟的卡片：1.2 秒的思考流 PATCH 两次而不是五次，同时标题时钟仍逐秒推进。实时播报的 PATCH 在缺省间隔下不变，配置后降到每秒一次。

删除链路付出的代价是无法就地重访结构化卡；生成物（`docs/config-catalog*.md`、`packages/extensions/tool-cordis/src/api-catalog.ts`）在被重新生成之前仍列着已删除的键与类。

PATCH 总吞吐不再有机器人级上限：它随并发活跃卡片数增长，每张卡各自受 5 QPS 约束。日志里出现限流报错即是加一层 bot 级帽（压在按消息桶之上）的信号。

在冷却窗内被顶下去的卡片会保持原位，直到下一次内容变化或回合结束；而在被顶下去的状态下结算的卡片会留在原处——已结算的卡片从不重发。该窗口把这个既有缺口从「一个 flush 间隔」扩大到「最多两秒」。

## Testing

`tests/streaming.spec.ts` 覆盖去重键（同一秒内的重复只 PATCH 一次、下一秒的时间戳仍上传、PATCH 失败回滚键、被顶下位移的卡片从不去重）与冷却窗（窗内、过窗、终态不重发）。`tests/engine/engine-turn-catch-card.spec.ts` 覆盖三处 catch 处理器，含「已结算的卡片保持不动」。`tests/assembly-config.spec.ts` 覆盖已删键的加载失败与新刷新间隔旋钮的 schema 与装配。`tests/feishu/patch-ratelimit.spec.ts` 覆盖按消息限速：一张卡烧完自己的突发不会推迟另一张卡的等待。
