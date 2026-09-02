# Agent Note: 飞书卡片行数上限按渲染器的行尾语义计数

Status: implemented

[English](2026-09-02-feishu-bridge-card-line-counts-renderer-rule.md) | 中文

## 问题

流式过程卡靠按行计数固定每个工具条目代码块的高度——`packages/acp/feishu-bridge/src/streaming.ts` 的 `padToFixedLines`（输入 1 行 + `---` + 结果 3 行），以及 `src/feishu/progress.ts` 的 `padProgressLines`（payload 路径 6 行，外加每行 120 字符上限）。它们全部用 `split('\n')` 计数，但飞书 schema 2.0 卡片 markdown 遵循 CommonMark 行尾语义：孤立的 `\r` 也断行。携带 `\r` 分隔进度更新的工具输出（经 `2>&1 | tail -N` 的 git worktree/checkout、curl、npm 进度）把几十个渲染行压进一个 `\n`-行：行数上限看到的是「3 行」，约 1.6 KB 的原始 `\r` 文本穿过全部清洗环节（均按 `\n` 处理）后，被渲染端炸成 38 个视觉行——卡片高度冲出了固定窗口。

## 决策

行数计数改用渲染器的规则。`src/feishu/markdown.ts` 的 `splitCardLines`（与其他 schema 2.0 行断归一化放在一起）按 `/\r\n|\r|\n/` 切行；`padToFixedLines` 与 `truncateToMaxLines`（streaming.ts）、`padProgressLines`（feishu/progress.ts）经它计数并重组，卡片文本不再携带原始 `\r`，每个固定高度窗口都以诚实的 `... (N more lines)` 标记截断。规则放在行数规整函数里而非工具结果入口：`ProgressEntry.result` 只被 `render()` 消费，在计数环节修一次即覆盖全部入口——流式更新、payload 卡、离线重放。

## 备选方案

**在 `updateToolResult` 里归一化 `\r`。** 否决其作为唯一修法：只覆盖流式卡，payload 路径（`formatProgressToolResult`）仍按 `\n`-行计数，120 字符上限会继续把 `\r` 进度拦腰截断成乱码。

**在卡片管线（`buildPreviewCardJSON`）里归一化。** 否决：那时 `padToFixedLines` 已经判定文本放得下，计数之后再归一化会把渲染高度重新撑出窗口。

## 后果

带 `\r` 进度的工具结果在两条卡片路径上都渲染为诚实截断（前几行 + 溢出标记）；无 `\r` 输出与之前逐字节一致。原始工具输出到达模型与导出的内容不变。已知残留：`padToFixedLines` 没有每行字符上限（不同于 `padProgressLines` 的 120），超长单 `\n`-行仍可能把流式卡窗口折行撑高——另一类失效模式，未处理。

## 测试

`tests/streaming.spec.ts`：git-worktree 形状的 `updateToolResult` 案例（`tail -3` 后的 36 段 `\r` 更新）与 `line fixing counts lines with the renderer rule` describe。`tests/feishu/progress.spec.ts`：`formatProgressToolResult renderer line counting`。
