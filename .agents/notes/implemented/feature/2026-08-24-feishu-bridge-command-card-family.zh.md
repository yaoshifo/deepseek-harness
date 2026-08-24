# Agent Note: feishu-bridge 命令卡族（list / status / switch / help / delete-mode）

Status: implemented

[English](2026-08-24-feishu-bridge-command-card-family.md) | 中文

## Problem

卡平台上，桥的 `/list`、`/status`、`/switch`、`/help` 仍是纯文本，而其他交互面（dir 选择器、cron 管理卡、提问卡）都已是按钮卡：切换会话要手打 `/switch 3`，帮助输出是一整块 markdown。还有两个按钮天生是死的：cron 卡的返回按钮（`nav:/help`，`cron-commands.ts`）落进 `handleCardAction` 硬编码分支链的静默无处理器丢弃；`/dir` 卡刻意省掉了返回按钮，因为要导航到的帮助卡并不存在。Go cc-connect 有一整套——`renderListCard`、`renderStatusCard`、`renderHelpGroupCard`、delete-mode 卡状态机——此前一个都没移植。

## Decision

`packages/acp/feishu-bridge` 在三个模块补齐该家族：

- `src/engine/session-card.ts`：`renderListCard`/`renderListCardSafe`（每会话一行 `act:/switch <agentSessionID>` 按钮、激活行 primary、`nav:/list` 翻页、`nav:/help` 返回、危险色 `act:/delete-mode enter` 入口）、`renderStatusCard`（状态文本经 `splitCardTitleBody` 拆成绿色标题 + markdown 正文）、delete-mode 状态机（`select → confirm → deleting → result`，`executeDeleteModeAction` + `performDeleteModeAsync`）。删除副作用先走可选的 `SessionDeleter` agent 能力（`src/core/types.ts` 新增，agent 实现时才调用），然后总是清掉桥自己的账本映射（`deleteByAgentSessionID` + `setSessionName('')`）；发起聊天的当前活跃会话受保护。
- `src/engine/misc-commands.ts`：`renderHelpGroupCard` —— 四个分组 tab（`nav:/help <group>`：session/agent/tools/system），行内容由已注册命令表经静态分组映射生成，provider 快捷命令注入 agent 组。行按钮派发 `cmd:/<id>`（平台侧命令路由），卡承载命令（`list`、`status`、`dir`、`help`）例外，用 `nav:` 就地刷新卡片。
- `src/engine/engine.ts` `handleCardAction`：新增 `nav:/help`、`nav:/list`、`nav:/status`、`act:/switch`（停掉交互会话 → `switchToAgentSession` → `clearHistory` → 重渲列表卡）、`act:/delete-mode` 分支；共享的 `refreshOrReplyCard` 辅助替代复制粘贴的刷新/回落模式。`cmdList`/`cmdStatus`/`cmdHelp` 在卡平台走路由到卡、其余保持既有纯文本回复；无参数 `/switch` 渲染列表卡作为选择器。`dir-card.ts` 恢复返回按钮。

delete-mode 的入口是列表卡上的按钮而非 Go 的 `/delete` 文本命令：桥没有 `/delete`，且路线图 B5 批次明确以列表卡为入口。

## Alternatives considered

**路线图里的 `act:/list switch|delete N` 按钮形态。** Go 参照实现里并不存在：`renderListCard` 发的是每行 `act:/switch <id>`，删除走独立 delete-mode 卡。按真实形态移植；路线图那行是简写。

**移植 Go 的 `/delete` 文本命令作为 delete-mode 入口。** 本批次否决：它会拖进 Go 的批量序号删除语法（`/delete 1,3-5,8`），而桥从未移植过；卡入口一个按钮就能交付同样的选择器。

**在 dsh adapter 上实现 `SessionDeleter`（直接删原生会话存储）。** 否决：原生 `sessionPersistence` 服务设计上只追加，其磁盘布局（jsonl 还是 sqlite）是后端私有的。从桥伸手进去会重复 B7 负责的会话账本改造；在出现原生删除面之前，删除只作用于账本。

## Consequences

卡平台获得了会话选择器和带 tab 的帮助浏览器；cron 卡与 `/dir` 卡的返回按钮现在导航到帮助分组卡，不再是死按钮。纯文本平台不变（`/list`、`/status`、`/help`、`/switch` 保持文本回复）。删除会话目前只清桥自己的映射与命名：默认 `filter_external_sessions: false` 下，被删会话仍可能被原生持久化存储列出、重新出现在 `/list` —— 该缺口在会话账本换成原生（路线图 B7）时收口。桥本身不实现 `SessionDeleter`，该能力目前只有测试覆盖。

## Testing

`tests/engine/session-card.spec.ts` —— 列表卡行/值/分页、状态卡拆分、帮助 tab、`act:/switch` 副作用加就地重渲、`nav:/help`/`nav:/list`/`nav:/status` 路由、delete-mode 状态机（含 SessionManager 副作用、活跃会话保护、结果卡推送）。`tests/engine/dir-card.spec.ts` 与 `tests/engine/engine-card-action.spec.ts` 更新了 `/dir` 返回按钮与已注册的 `nav:/help` 路由。feishu-bridge 套件：2194 通过。
