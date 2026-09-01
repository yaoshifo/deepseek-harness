# Agent Note: 工作区指令 `@path` import——在既有管线内对齐 Claude Code

Status: implemented

[English](2026-09-01-workspace-instruction-imports.md) | 中文

## Problem

从 Claude Code 迁移而来的作者期望 `CLAUDE.md`／`AGENTS.md` 内的 `@path/to/file` 引用能把其他文件导入指令——README、`package.json`、共享规则片段。Harness 此前只加载候选文件并逐字渲染其字节；包 README 把 `@path` import 记录为刻意空白，因此拆分指令的仓库只能复制内容或为每个片段做 symlink。

## Decision

### 展开发生在加载时，位于既有管线内部

`src/imports.ts` 在每个候选内容的有界读取之后立即展开，覆盖 `src/files.ts` 的两个读取点（基线加载器与逐 scope 对账）。发现、每目录去重、渲染与字节预算因此不变地作用于展开后内容：没有新的渲染阶段，也没有新的会话事件。`AgentInstructionChange` 记录的 digest 是展开后内容的 SHA-1，渲染文本与日志身份保持精确一致；持久会话格式不变。

### 解析遵循 Claude Code 文档化的记忆 import 语义

行首或空白之后的 `@` 开启一个 token，延伸到下一个空白或反引号；尾部句子标点保持字面；跳过行内代码 span 与 fenced code block，代码 span 的反引号只在单行内配对。相对路径相对包含引用的文件所在目录解析，`~/` 相对操作系统 home 目录展开，绝对路径原样通过，递归在四跳处停止（`MAX_IMPORT_HOPS`——与 symlink 规则同类的外部 spec 常量，刻意不做配置字段）。无法加载的引用——缺失、不可读、超过 `maxSourceBytes` 或超出深度帽——渲染为一行 `[instruction import unavailable: <path>]`，坏引用对模型可见，但不会让基线的其余部分失败。

### 被导入内容在原位加框

引用 token 在其位置被替换为 `Imported from: <path>` 标记、被导入内容与 `End imported from: <path>` 标记。渲染正文继续通过既有的 `</system-reminder>` 转义，被导入文本无法关闭插件控制的框架。

### 刷新通过缓存元数据到达 import

`InstructionVersionState` 携带 `imports`——对一个 scope 的展开有贡献的传递闭包绝对路径。对账在某个缓存 import 被 touch 时加入其所属 scope，并跳过它的「版本未变」快速路径，因此只编辑被导入文件也会在下一个请求替换引用 scope 的渲染内容，而未变的 import 不注入任何内容。import 记录只存在于每会话内存缓存；resume 通过既有的确认读取取得新鲜展开。

### 信任来自提供方策略，而非审批对话框

Claude Code 用交互式审批对话框拦截外部 import。Headless 组合没有对话框表面：绝对与 `~/` import 读取已挂载 `ctx.fs` 提供方允许的内容——local provider 全宿主，sandbox provider 受限——与包已为 symlink 候选文档化的边界相同。

## Alternatives considered

- **渲染期展开**——否决：渲染是同步且无提供方的，而 import 需要通过 `ctx.fs` 的有界异步读取，它位于加载层；在加载时展开保持渲染器纯净。
- **把被导入文件当作伪 scope**——否决：伪 scope 会增加持久状态并复制候选机制；缓存元数据加 touch 匹配以零格式变更交付同样的可观察刷新。
- **import 失败时静默保留字面 token**——否决：静默跳过隐藏了缺失的引用对象；unavailable 标记点名缺口，且不让基线失败。
- **深度或启停的配置项**——否决：Claude Code 固定语义（四跳、常开）；对齐是外部 spec，不是随部署变化的选择。
- **交互式外部 import 审批**——否决：headless 没有对话框表面，文件系统提供方策略已为 symlink 候选拥有这条边界。

## Consequences

- 只含 `@AGENTS.md` 的 `CLAUDE.md` 会在真实 `AGENTS.md` 段落旁渲染加框的被导入内容，因为两者都是候选；完全共享继续使用 symlink 约定，既有按去空白内容去重会把它折叠。
- 基线与确认读取为每个被导入文件发起一次有界读取，`src/files.ts` 的聚合读取 `TODO(total-instruction-read-bound)` 因此同样覆盖 import；每文件 `maxSourceBytes` 与渲染预算约束模型可见结果。
- 不受信任的仓库多了一条把树外文本带进较低优先级指令的途径（绝对路径 import）；包 README 的信任条目同时点名 symlink 与 import，以提供方收敛为缓解手段。

相关：[工作区上下文决策记录](2026-06-24-workspace-context.zh.md)。
