# Agent Note：/mcp 关键词过滤

Status: implemented

[English](2026-09-08-feishu-bridge-mcp-query-filter.md) | 中文

## 问题

`/skills` 当天先获得了模糊搜索，`/mcp` 仍是平铺列表。server 有好几个、每个 server 的工具行又截断在 8 个名字，「`read_file` 属于哪个 server」只能逐行肉眼扫。分页则是个伪问题：live profile 挂 5 个 server、每行工具已截断，卡片天然有界在十几行。

## 决策

`/mcp [关键词]` 过滤**全部三段**——在线组、健康监视的降级 server、工作区挂载——只显示匹配的 server。在线组的匹配是任一空白分隔关键词（大小写不敏感）出现在 server 名**或其任一工具名**中，与 `/skills` 的逐词 AND 语义一致；降级与工作区条目仅按名匹配（它们没有工具名可匹配）。过滤视图回显关键词与 命中/总数（`mcp_query_line`）；零命中获得专属回复（`mcp_no_match`），与注册表为空（`mcp_empty`）区分。降级检测继续对照未过滤的组——被监视 server 的工具存在但被过滤掉时，它是被过滤而非降级。不做分页、不做快照：工具注册表读取是同步的，命令也没有卡片动作。

## 备选方案

**整体照搬 /skills（分页 + 快照）。** 否决：5 个 server 渲染约十几行有界内容，分页会把一眼的事拆成翻页；同步数据源也让快照机制失去必要。

**只过滤在线组，降级/工作区段不过滤。** 否决：查询时冒出用户没要的工作区段，违背聚焦的初衷。

## 后果

`/mcp zzz` 现在回复无匹配，而不再把尾随裸词当未知命令穿透给 agent（此前 /mcp 后的词被当作参数忽略）。i18n 面为两个新键（`mcp_no_match`、`mcp_query_line`）加改写的 `mcp`/`mcp_usage`；用法文案点名了工具归属查询的例子。若 server 数量将来超出一屏，再议分页——今天的渲染有意保持单卡。

## 测试

`tests/engine/skills-mcp-commands.spec.ts`：server 名过滤（大小写不敏感）、工具名命中带出所属 server、名称与工具名的逐词 AND、降级/工作区段按名过滤、🔍 范围回显、无命中与空注册表分流。
