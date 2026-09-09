# Agent Note: 截断回合的终态卡片标明「输出截断」，不再冒称完成

Status: implemented

[English](2026-09-09-feishu-bridge-max-tokens-card.md) | 中文

## 问题

被输出 token 上限截断的回合，其进度卡以绿色 `执行完成 · <ts> · <n>` 头部结算，与真正完成的回合无法区分（2026-09-09 oc_9eed：agent 在绕行渲染失败时思考被拦腰截断——用户看到「完成」却既没有图也没有收尾文字）。丢失从投影层就开始：adapter 的 `turn/end` 处理只把 `error` 类 reason 映射到 bridge 的 `result` 事件（`errorText`）；其余非完成 reason kind 全部丢弃，引擎侧结算随之塌缩为 `errored ? failed : completed`。子任务结算路径早已有非完成 stop-reason 词汇表（`settlementDeliveryText` 的 `SubtaskSettlementMaxTokens` 前缀）；主聊天卡片路径一个都没有。

## 决策

把终态 stop-reason kind 传递过投影层，并新增一个「点名截断」的终态卡片状态：

- `result` 事件新增可选 `stopReason`（即 `turn/end` 的 reason kind，仅对非 `completed` 非 `error` 回合携带——error 回合已有 `errorText`）。
- 卡片状态词汇表新增 `truncated`：橙色头部、标题 `输出截断` / `Truncated`，两个卡片面（结构化 payload 卡经 `progressStateMeta`、预览文本卡经 `progressTitleAndColor`）都渲染。它是终态：停止按钮与运行 spinner 按绿色/红色同类处理，在途子任务标题后缀同样适用。
- 引擎在全部三个终态渲染处把 `max-tokens` 回合路由到 `truncated`：compact writer 的 `finalize`、流预览的 `markTruncated`（新增；`markCompleted` 重构为共享的加锁内核）、以及 `finish(text, truncated)`。

范围：只有 `max-tokens` 改变渲染结局。`refusal` 与 `aborted` 维持现结算（用户停止经自有路径渲染停止卡）；放宽它们的卡片语义是另一个独立决策。

## Alternatives considered

- **像子任务结算那样给回复文本加前缀：** 否决——进度卡才是扫一眼即得的终态信号；不点开回复的用户根本看不到文本前缀。
- **max-tokens 复用 `failed` 红色：** 否决——回合没有失败，截断前的成果还在。红色会诱发重试/恐慌，而诚实的状态是「被截断，让它继续即可」。

## 后果

- `truncated` 加入 `ProgressStatus['state']` 与 `ProgressCardState`；包外若有对 state 字符串做 switch 的卡片渲染方，会见到一个新的终态值（停止按钮与 spinner 白名单本就把未知的非运行模板按终态缺省处理）。
- ✅ 完成通知带同样的区分：`sendTurnCompletionCard` 接收回合的 stop reason，max-tokens 回合给紫色卡标题加 `turn_truncated` 前缀（⚠️ Truncated / ⚠️ 输出截断）——截断回合的完成推送不再读作普通完成。传给纯文本 fallback 的 `turn_completed` 标题从不渲染（Go parity 死参数）；该参数、词条与两处调用的实参已随后删除，卡标题是唯一可见面。
- 覆盖：adapter 投影（max-tokens 携带、completed 省略）、引擎 finalize（truncated 且非 completed）、预览 `markTruncated`、双语文案标题/颜色、停止按钮与 spinner 隐藏、完成卡标题前缀（及无 stop reason 时的干净缺失）。
