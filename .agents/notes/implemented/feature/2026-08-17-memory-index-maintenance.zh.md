# Agent Note: memory_index 维护工具与沙箱围栏句

Status: implemented

[English](2026-08-17-memory-index-maintenance.md) | 中文

## Problem

通往记忆目录的两条写路径在设计上就分岔了:memory 工具走宿主 `node:fs`([claude-code-memory-compat](2026-08-14-claude-code-memory-compat.zh.md) 的机器本地共享契约),通用 `edit`/`write` 走沙箱化的 `ctx.fs`,而 `workspace-write` 模式拒绝 `~/.claude`——它不在任何可写根之下。`MEMORY_PROMPT` 承诺逐字对齐 Claude Code,但在 Claude Code 里通用编辑工具写记忆目录是成功的,在 dsh 里则以 `FS_SANDBOX_DENIED` 失败。保留 Claude Code 习惯的模型会对 MEMORY.md 伸手用 `edit`,浪费一次调用,还会看到一条升级提示——而对该目录而言,提示里唯一更宽的模式是错误的补救。另外,维护索引需要全量内容重写 MEMORY.md,一行指针更新要重发整个索引。

## Decision

`memory_index` 成为第五个工具,策略提示词追加两句 dsh 专属说明。

该工具按记忆文件名 upsert 或删除一行指针。匹配容忍两种 `.md` 拼写(与 `memory_read`/`memory_delete` 的自愈一致)并把重复行折叠为一行;无匹配的 upsert 追加在最后一个非空行之后,缺失的索引会补上规范的 `# Memory Index` 头。写入走存储层原有的原子 temp-and-rename 并带同样的索引预算警告;`MEMORY.md` 本身被拒绝作为索引键;upsert 的 `title`/`hook` 在工具边界必须是非空单行。标题与 hook 仍由模型撰写——工具只维护模型口述的一行,绝不发明召回内容。

提示词的索引段落新增:用 `memory_index` 维护指针而非重写索引;memory 工具是该目录唯一的写通道,通用文件工具会被文件沙箱拒绝。对齐原则由此精化而非放弃:除 dsh 真实不同之处外逐字照抄 Claude Code,并把差异写进提示词,而不是让模型通过一次被拒的调用去发现它。`memory_write` 与 `memory_delete` 的描述现在把指针步骤指向 `memory_index`。

索引的读-改-写保持存储层一贯的 last-write-wins:与并发的全量 `memory_write` 竞争时,收敛方式与两个并发 Claude Code 会话完全一致。

## Alternatives considered

**在 `memory_write`/`memory_delete` 内自动维护指针。** 否决:这两个工具保持单一职责,且自动改写行可能覆写手工维护的 hook;只有当提示词已指向该工具而模型仍系统性跳过索引维护时再评估。

**把记忆目录注册为沙箱可写根,让通用 `edit` 直通。** 否决:在非本地文件系统 provider(e2b)下,通用工具会写进沙箱的 `~/.claude`,悄悄切断机器本地共享;还会绕过 `.md` 归一化与索引预算警告。拒绝通用写入的围栏本身是对的——缺口在提示词没有说出来。

**通用 `memory_edit`(对 MEMORY.md 的任意行替换)。** 否决:字符串匹配式编辑易错且扩大信任面;按名定位的类型化 upsert 与文档承诺的"每条记忆一行"契约一致。

**在 `FS_SANDBOX_DENIED` 报错信息里加重定向提示。** 暂缓:需要沙箱并不具备的"插件自有目录"注册表;等出现更多宿主本地插件目录再做才有规模价值。

## Consequences

- `MEMORY_PROMPT` 与 Claude Code 原文的偏离变大;锚点测试与 claude-memory 快照钉死该偏离,提示词改动必须在同一变更内带上 README 逐字块与快照。
- 索引维护从全量重写变为一次有界调用;no-op 的 remove 回告当前索引统计而不写入。
- acp 的 `claude-memory` 快照场景现在端到端覆盖 `memory_read` → `memory_write` → `memory_index`。
