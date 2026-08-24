# Agent Note: feishu-bridge 去包袱批次 8 —— 预览内容以结构化对象跨越 Platform 接缝

Status: implemented

[English](2026-08-24-feishu-bridge-preview-content-objects.md) | 中文

## Problem

进度预览管线即使全程都是进程内函数调用，仍背着两个 Go 时代的文本协议；真正的 wire 只有飞书 PATCH HTTP 请求，载荷是渲染后的卡 JSON：

- `__cc_connect_progress_card_v1__:` JSON-in-string：`CompactProgressWriter` 把 `ProgressCardPayload` 序列化成带前缀的字符串，经 `sendPreviewStart`/`updateMessage`（`content: string`）送出，`FeishuPlatform` 再解析回来渲染。
- `__cc_state__:`/`__cc_ts__:`/`__cc_tc__:` 头部行：`StreamPreview` 在每份进度展示文本前拼三行伪头部，飞书渲染端再剥掉还原出（state、ts、工具计数）。

cc Event 中间模型还有与文本编码无关的有损点：adapter 完全丢掉原生 `tool/result.meta` 展示载荷，并把 `assistant/message` 的逐请求 usage 折进回合累加器，引擎只能看到回合总和。

## Decision

预览内容以结构化判别联合跨越 Platform 接口；卡状态随展示文本旁路传递，不再内嵌。

- **`ProgressContent`**（`core/types.ts`）成为 `MessageUpdater.updateMessage` 与 `PreviewStarter.sendPreviewStart` 的参数类型：`{kind:'card', payload: ProgressCardPayload}` 或 `{kind:'text', text, status?}`，成员均为命名接口（`TextPreviewContent`、`CardPreviewContent`）。`CompactProgressWriter` 直接构造并传递 payload 对象（去重比较按构造器固定键序序列化的 JSON 签名）；`FeishuPlatform` 的 card 分支直接经 `buildProgressCardJSONFromPayload` 渲染，不再经历编码/解码往返。
- **`ProgressStatus`**（`{state: running|completed|failed|thinking, ts, toolCallSeq}`）取代头部行。`StreamPreview.progressStatusLocked()` 按原来选头部行的同一组条件计算它；每次进度 flush 发送 `progressContentLocked(display)`，终态路径（`finish`、`completeAndDetach` 的文本分支）发送显式 completed 状态并带 `toolCallSeq: 0`。带状态的 flush 恒 PATCH——空文本体也照样渲染 思考中/执行中 头部，且进度 flush 自带 300 ms 节流——纯文本 flush 保持旧的「未变化/为空则跳过」规则。`buildPreviewCardJSON(text, spin, status?)` 接收状态，`progressTitleAndColor` 映射出与从前完全相同的标题、颜色与 spinner 图标。
- **实施中核实的结论**：渲染出的卡 JSON 从不内嵌序列化 payload（`buildPreviewCardJSON` 用解析后的对象重建），也没有任何代码把从飞书读回的卡文本写进 `lastProgressCard`，因此前缀 codec 从来不是飞书 wire 格式。`__cc_connect_progress_card_v1__:` codec 据此收缩为 Platform 接缝处的文本路径解码器并保留（`parseProgressCardPayload` 与前缀常量）；其 V1 legacy 构造器（`buildProgressCardPayload` 的 entries 形态）与 `extractProgressTimestamp` 作为死码删除，`buildProgressCardPayloadV2` 改为返回对象的 `buildProgressCardPayload`。`extractProgressState` 同步删除——已核实 progress_style=legacy 并不产生头部行（头部行只存在于 StreamPreview→FeishuPlatform 通路），删除后无生产者。
- **Event 模型有损字段补全**（adapter `projectSessionEvent`）：`tool/result.meta` 投影为 `Event.toolResultMeta`；`assistant/message` 的逐请求 usage 挂在投影事件上（text 事件，或无文本消息的 thinking 事件，取 `inputTokens`/`totalInputTokens`/`outputTokens`），回合总和仍随 result 事件。step 边界（原生事件的 `turn`/`step`）本批不投影：当前没有消费方，加了就是死表面——待出现逐 step 消费方（如卡上逐 step 计时）时再补。
- **与逐字节一致的偏离，全部位于生产不可达路径**：(1) 无 `PreviewStarter` 的 payload 风格 writer 现在发送 markdown 回退文本而非裸前缀串（Feishu 恒实现 starter）；(2) `bumpToEndLocked` 的 `display === ''` 回退到 `lastSentText` 原是死码（旧 display 恒带头部行）并已移除——空文本体照样以 running 状态卡片 bump，视觉相同；(3) 文本体与上次逐字节相同的 status flush 现在会被去重，而旧的恒变 `__cc_ts__` 头部强制冗余 PATCH——视觉无差。

## Alternatives considered

- **在 Platform 接缝保留字符串 codec。** 否决：该接缝是有类型的同进程接口（「类型化同进程边界信任 TypeScript」）；必须存活的序列化只有真正上 wire 的那份，而 PATCH 请求上的卡 JSON 才是 wire 格式。前缀 codec 只作为宽容的文本路径解码器存留，不再承担传输。
- **用新的头部常量承载状态。** 否决：用一个文本协议替换另一个文本协议，解析/剥离耦合原样保留，还失去状态枚举的穷尽检查。
- **把 `status?` 放到两个联合成员上。** 否决：card 分支的生命周期状态本就在 payload 内；共享可选字段会引入无意义组合，逼每个消费方重新收窄。
- **现在就投影 step 边界。** 否决：没有消费方；Event 模型字段将只有 adapter 写、无人读，不满足「当前所有者」要求。以本 note 记录重访条件代替。

## Consequences

- 卡片视觉、按钮注入、re-attach（`lastProgressCard` + `renderStoppedCard`/`updateRenderStatus`）与 legacy markdown 回退均不变；由改写后的 `streaming.spec`（70 例）、`progress-compact.spec`、`engine-events`/`engine-stall-retry` 套件（对录得的平台调用做结构化状态断言）、`cardcache` re-attach 用例、`spinner` 图标用例、`card.spec` 的「标题来自状态」用例，以及新增的 usage/meta 透传 `adapter-projection` 用例锚定。旧的头部行与前缀串断言改写为对象/状态断言，而非重新序列化回旧格式。
- 进度卡视觉真机对比（JSON 断言 + 截图）与其余去包袱批次一样，留给用户执行。
- 未来任何 Platform 实现现在收到的都是 `ProgressContent`，必须按 `kind` 分支；测试 stub 共用 `tests/stubs/preview-content.ts`（`previewText`、`statusOf`），让只检查文本体的断言保持文本形态。
- 从事件中提取逐请求 usage（例如实时 token 表）从此无需改动 adapter；在消费方落地之前，这些字段只用于固化投影契约。
