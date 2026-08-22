# Agent Note: feishu-bridge 监控群的 `/learn` 引用在 thread 隔离下被跳过

Status: implemented

[English](2026-08-22-feishu-bridge-monitor-thread-isolation-learn.md) | 中文

## Problem

`threadIsolation: true`（生产 profile 对所有项目开启）时，`makeSessionKey` 对每条群消息都派生 `root:`/`thread:` 前缀的会话键——`root_id`/`thread_id` 缺失时回退到消息自身 id——因此 `isThreadSessionKey` 在群聊里恒为 true。两个以该谓词为条件的动作随之在监控群误伤：

- `dispatchWithQuote` 跳过 `fetchQuotedMessage`，监控群里引用消息的 `extraContent` 永远为空，`/learn` 即使用户确实引用了消息，也总是回复「⚠️ 请引用一条消息再发 /learn」。
- `shouldReplyInThread` 令每条监控群回复（包括上面那条报错）都以 `reply_in_thread: true` 发出，每次回复都在监控群里开一个新话题。

跳过的本意——"线程会话已携带上下文，引用前缀会淹没正文"——预设的是交互式 agent 会话；监控群从不运行 agent 会话，引用文本是 `/learn` 的数据而非会话上下文。该条件与退役的 Go 原版逐字相同（`platform/feishu/feishu_dispatch.go` 的 dispatch），不是移植回归：只有在部署全线开启 threadIsolation 并启用监控群之后才触发。测试漏掉了这个组合：platform-quote 用例全部用 `chat_type: 'p2p'`，isolated-thread 用例只断言了无 parent 分支。

## Decision

监控群在平台侧豁免这两条 thread 隔离行为：

- `dispatchWithQuote` 的引用抓取跳过条件追加 `&& !this.isMonitorChat(chatID)`。
- `shouldReplyInThread` 对监控群返回 false，文本与卡片回复改为普通引用回复——与轮询通路一致（`pollItemToMessage` 构造 per-user 会话键，本来就是内联回复）。

## Alternatives considered

**在 `makeSessionKey` 里为监控群派生非 thread 会话键。** 可见结果相同，但会话键还参与澄清问答匹配与 seen 去重；为监控流量改键派生的爆炸半径大于两处局部谓词调整。

## Consequences

thread 隔离下监控群的 `/learn` 能拿到引用文本；监控群回复（🔍 拉群通知、完成卡、`/learn` 确认）改为内联引用，不再开新话题。非监控群、spawned 群、p2p、未开 `threadIsolation` 的部署行为不变。`/learn` 仍无法引用轮询通路摄入的消息（README Known Limitations 有记录）。

## Testing

`platform-quote.spec.ts` 新增四个用例：threadIsolation 下监控群抓取引用（修复前为红）、非监控群仍跳过且 `getMessage` 零调用、监控群内联回复、非监控群仍话题回复。包套件全绿（2080 个测试），tsc/oxlint 干净。真机冒烟：监控群引用 + `/learn --ignore` → 内联「✅ 学到了」回复、示例落盘 `monitor_examples.json`、无新话题。
