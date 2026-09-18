# Agent Note: 发卡缓存记录源问题，而不是从卡面反推

Status: implemented

[English](2026-09-18-feishu-bridge-ask-meta-source-question.md) | 中文

## Problem

平台在发卡时缓存问题卡的题面（`cacheAskqMeta`，`src/feishu/platform.ts`），因为提交回调带不动卡片：form submit 会丢掉 `action.value`，按钮点击只回传被点的那个选项。这份缓存此前靠**从渲染后的卡模型反推**填充（`askCardMeta`）——而反推只能映射卡面渲染出来的东西：每个 checker 选项的 `{label, description}`。

[定位丢失](../feature/2026-09-17-feishu-bridge-followups-locator-split.zh.md)是第一个症状：一个被刻意排除在卡面之外的字段从未进入缓存、持久化 sidecar，也没进派发的 `[后续处理]` 消息（现场：整份会话日志 `📍` 命中 0 次）。[细节层](../feature/2026-09-18-feishu-bridge-followups-details-layer.zh.md)把那个实例修好了（把字段挪上卡面），但机制原样留着：以后任何不上卡面的选项字段都会以同样方式被丢，且反推今天就已经在丢 `recommended`。

## Decision

卡携带它的源问题，缓存优先采用它。

- `Card` 新增私有字段 `#askQuestion` 与 `setAskQuestion()` / `askQuestion()`：永不渲染，`JSON.stringify` 与展开（spread）都取不到它，因此不会泄进卡片载荷。
- `buildAskQuestionCard` 与 `buildFollowupsCard` 挂上它们所渲染的那个问题（`src/engine/ask.ts`）。
- `cacheAskqMeta` 在 `card.askQuestion()` 存在时用它覆盖反推结果；`askCardMeta` 保留为分类器（这张卡是不是问题卡、在第几题）以及无源问题的兜底路径。
- 数据随卡走，两条发送出口——`sendCard` 与线程回复的 `replyCard` 路径——无需各自多传参数就能记录源问题，今后新增出口自动继承这个保证。

## Alternatives considered

- **给 `sendCard` 额外加一个题目参数。** 否决：`sendCard` 会把线程回复交给 `replyCard`，后者会**第二次**记录缓存，参数必须同时穿过 `CardSender.sendCard` 与 `CardSender.replyCard`——以及今后每一条新出口。由卡携带数据让保证变成结构性的。
- **彻底删掉卡面反推。** 否决：反推同时充当分类器（这是不是问题卡、在第几题），并且仍在服务引擎构造器之外构建的问题卡。

## Consequences

- 缓存里的问题就是构建该卡时用的那个对象——`recommended` 与今后任何选项字段无论卡面是否渲染都能存活。
- `Card.askQuestion()` 是进程内状态：跨进程或跨序列化边界的卡会丢失它并退化为反推，即此前的行为。
- 测试：`tests/feishu/card-action.spec.ts` 钉住 followups 卡与 ask 卡经 `sendCard` 缓存问题的深相等，以及线程回复出口的同一断言。
