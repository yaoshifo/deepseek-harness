# Agent Note: 记忆文件名后缀规范化

Status: implemented

[English](2026-08-17-memory-name-suffix-normalization.md) | 中文

## Problem

记忆工具把文件名当作模型撰写的字符串接收,而 `MEMORY.md` 索引行把同一个名字以 Markdown 链接目标的形式再写一遍——同一条事实在单次流程里产出两种拼写,却没有机制对账:`assertMemoryName` 只防路径逃逸,工具 schema 用 "e.g." 描述后缀,读取按精确字符串命中否则失败。会话向 `memory_write` 传 `name: "reference-foo"`,随后跟随自己的索引链接 `reference-foo.md` 读取时得到 `memory not found`;一次事故在共享的 Claude Code 记忆目录里留下 4 个无扩展名文件,索引行指向落空,下一个会话读不到上一个会话写的内容。

## Decision

文件名是信任边界上的输入,由 store 拥有其规范拼写;frontmatter 与内容仍交提示词自治,遵循 [claude-code-memory-compat](../feature/2026-08-14-claude-code-memory-compat.zh.md) 的决定——文件名不是格式内容。

- `writeMemory` 把请求名解析为落盘名:`MEMORY.md` 保持原名,其余名字缺 `.md` 后缀时补上。写入结果回告实际落盘的 `name`,工具渲染它(`Wrote 3 lines (8B) to reference-foo.md …`),索引链接因此按真实存在的文件撰写。
- `readMemory` 与 `deleteMemory` 在未命中时按另一种后缀拼写重试一次——带 `.md` 则去掉、不带则补上——自愈早于本规则写出的、以及 Claude Code 侧从不规范化的无扩展名文件。精确命中永远优先;重试对它不可达。

## Alternatives considered

**仅收紧描述("must end in .md")。** 作为唯一手段被否:schema 措辞是建议性的,而失败是结构性的——单次流程在两个语境里以不同惯例产出同一个名字。收紧后的描述与规范化一同交付,不取而代之。

**对无后缀名字硬性报错。** 被否:所有模型可见惯例(索引链接、`memory_list` 条目)给出的都是带后缀的文件名,补后缀是让写入对齐其他面已有的展示;报错把拼写差异变成硬失败,且对已落盘的文件无济于事。

**只做追加方向的重试。** 被否:事故方向是索引 `.md` 链接对上无扩展名文件,只追加够不到它;去/补两个方向对称,代价只是真正未命中时多一次 stat。

**写入时校验索引链接与文件名一致。** 被否:索引行按设计由模型撰写,插件既不生成也不改写;回告落盘名加未命中重试已闭合回路,无需一个会偏离 Markdown 实践的索引解析器。

## Consequences

代价:存量无扩展名文件在被重写或按另一拼写删除前留在磁盘上;后缀规则区分大小写——`foo.MD` 解析为 `foo.MD.md` 而非 `foo.md`。换来:每次写入都产出带后缀的文件名,读与删双向自愈,模型看到的就是下一个会话将读到的名字。
