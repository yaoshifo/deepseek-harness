---
description: "memory 包组：Claude Code 兼容的持久记忆——共享的按项目记忆目录、跨项目全局 scope 与记忆工具——面向 dsh 会话。"
kind: "package-group"
---

# memory/ — Claude Code 记忆兼容

[English](README.md) | 中文

## 概述

`memory/` 包组让 dsh 会话在外部拥有的布局中持有持久记忆：`memory/` 包共享 Claude Code 的按项目记忆目录（两个 harness 因此召回同一批事实），增加本机所有 dsh 会话共享的跨项目全局 scope，并提供记忆工具与会话开始的索引注入。存储不引入任何自有内容——格式、slug 编码与索引纪律保持与 Claude Code 实证行为锁定。

## 目录

- [包清单](#packages)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包清单

把外部产品拥有的记忆布局共享给 dsh 会话的插件。

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.zh.md) | Claude Code `~/.claude/projects/<slug>/memory/` 共享:策略 section、会话开始索引注入、memory 工具 | — |

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
