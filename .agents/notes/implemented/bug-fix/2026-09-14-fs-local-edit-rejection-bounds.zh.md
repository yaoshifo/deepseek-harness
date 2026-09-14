# Agent Note: fs-local 的 edit 拒绝消息按 read 上限封顶

Status: implemented

[English](2026-09-14-fs-local-edit-rejection-bounds.md) | 中文

（英文版为权威记录，本文件为其中文对照。）

## Problem

2026-09-13 的拒绝消息增强把每处匹配的**整行原文**嵌入——`FS_AMBIGUOUS_EDIT` 最多 10 处、`FS_EDIT_NOT_FOUND` 3 条候选行——且无长度上限。`readForEdit` 不设大小上限（只拒 NUL 二进制），minified 单行大文件里一次宽泛的 `old_string` 匹配即可拼出数 MB 的工具错误，不经截断流入模型请求与会话日志；而同批次的 write 拒绝却严格执行 read 上限。

## Decision

每条嵌入行按 2000 字符截断，后缀逐字复用 read 工具的 `... (line truncated to 2000 chars)` 标记；`matchStartLine` 只切 cap+1 字符，巨型单行不再整体物化。整条 `FS_AMBIGUOUS_EDIT` 消息按 50 KiB（`Buffer.byteLength`，UTF-8）封顶：shown 列表贪心截断并追加 `; list truncated` 标记，匹配总数保持精确。50 KiB 取值镜像 `READ_MAX_BYTES`——read 结果注入模型请求信道的既有封顶——因依赖方向禁止 fs-local import tool-fs 常量，故本地常量加同步注释。not-found 路径只做逐行截断：3 条截断行在结构上到不了总封顶，列表截断分支会是死代码（JSDoc 记录了该依据）。`matchStartLines` 沿有序匹配 offset 单调计数行号，不再每处匹配都从头重扫。

## Consequences

minified 单行大文件里宽泛的 `old_string` 现在得到有界的拒绝消息（每匹配最多一条截断行，列表整体 50 KiB 封顶），而非数 MB 的模型可见错误。匹配总数与行号前缀保持精确，模型的纠正回路不变；只有嵌入的证据被截断。按错误码分支的调用方不受影响（错误码未变）。

## Alternatives considered

给 `readForEdit` 本身设上限被否：edit 需要全文内容，封顶应落在唯一到达模型的工件——拒绝消息——上。not-found 路径同时实现列表截断被否为死代码：3 条逐行截断的候选在结构上到不了 50 KiB 封顶。
