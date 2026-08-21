# Agent Note: feishu-bridge /stop 成功后静默——停止卡片即反馈

Status: implemented

[English](2026-08-21-feishu-bridge-stop-silent.md) | 中文

## 问题

停止一个运行中的回合会发两次确认。进度卡的 ⏹ 停止执行按钮（`cmd:/stop`，经 `cmd:` 派发分支合成为普通 `/stop` 消息）和手打的 `/stop` 都进入会话命令处理器，回复文本「⏹ 执行已停止。」（`execution_stopped`）；而 `cmdStop` → `stopInteractiveSession` → `markStopped` 已经把同一张卡片 PATCH 成红色 ⏹ 已停止 header 加 ▶ 继续执行 footer，文本消息重复了卡片 header 稍后展示的内容。

## 决策

stop 处理器只在无任务可停时回复（`no_execution`）；停止成功时无论来源（卡片按钮或手打命令）都静默，停止卡片的 PATCH 即成功反馈。

`execution_stopped` 的 i18n key 与译文保留在 `keys.ts`/`messages.ts`，尽管已无代码消费：这两个文件是 Go cc-connect i18n 表的 1:1 移植，文件头声明了再生成契约（"regenerate against that file when it changes"），删单条会让表隐性分叉——下次再生成时它会被复活。

已知取舍（产品决策接受）：关闭 `useInteractiveCard` 时没有停止卡片，手打 `/stop` 成功后完全无反馈。若该模式将来变得重要，升级路径是来源标志方案（标记 `cmd:` 合成消息、仅对其静默）。

## 考虑过的替代方案

**仅对卡片按钮来源静默（`Message` 上加来源标志）。** 需要给 `dispatch()` 穿透一个新 `isCardCommand` 字段，只为保住手打 `/stop` 的文本回复。产品决策把手打也纳入静默后该标志失去消费者，遂弃用。

**随行为一并删除 i18n key。** 会让 1:1 生成的 Go 表分叉；见决策。

## 后果

卡片模式下每次停止少一条消息。点击过期卡片（无任务运行）仍会收到「没有正在执行的任务」文本。其余 `cmd:` 按钮不受影响——只有 stop 处理器变了。

## 测试

`tests/engine/commands.spec.ts`：新增处理器级测试双向驱动 `dispatchCommand('/stop')`——有活跃 interactive state 时 `p.sent` 必须为空，没有时必须回复 `no_execution`。既有的 close 阻塞测试删掉了对旧回复的手工复刻，改为断言平台收不到任何消息。全包 1948 绿；仓库 typecheck 绿。
