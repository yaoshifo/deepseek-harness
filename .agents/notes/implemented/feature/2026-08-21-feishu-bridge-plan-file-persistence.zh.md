# Agent Note: Plan-file persistence — the bridge writes presented plans to ~/.claude/plans

Status: implemented

[English](2026-08-21-feishu-bridge-plan-file-persistence.md) | 中文

## Problem

dsh 的计划只以 `exit_plan_mode` 工具调用的形式存在于 session 日志——没有 Claude Code `~/.claude/plans/*.md` 那样的独立文件记录。bridge 的 Go 前身桥接的是 Claude Code 本体，其 plan mode 会写这些文件（引擎对 Write 进 `.claude/plans/` 的子串检测、plan-render 的兄弟 HTML 逻辑都围绕它们生长）。在 dsh 会话上这条读取路径是死的——没有任何指令让 dsh 模型写计划文件，且 dsh plan mode 本身限制写操作——于是 plan 卡片完全依赖 inline `plan` 参数运行，持久、可浏览的计划库无从积累。

## Decision

由引擎在呈现时确定性地持久化计划：ExitPlanMode 卡片分支（`engine.ts`）中，当没有模型自写的计划文件路径且 `planDir` 非空时，`savePlanFile`（`engine/plan-file.ts`）把完整未截断的 markdown 写入 `planDir`，写出的路径成为 `activePlanFilePath`——卡片从文件发送，plan-render 的 HTML 落在旁边。命名对齐 Claude Code 的实证行为：`<cwd-slug>-<标题slug>.md`，cwd slug 取项目 workdir（`getWorkDir()` 结构探测，`process.cwd()` 兜底），标题 slug 复用 `slugifyTitle`/`extractMarkdownTitle`（保留 CJK，与目录中 Go 时代文件一致）。同名但内容不同的文件追加 `-YYYYMMDD-HHMMSS` 后缀另存——修订永不覆盖；内容相同则原文件不动。`projects[].planDir` 配置目录（默认 `~/.claude/plans`，展开 `~`；`''` 关闭）。写失败记录警告并回退 inline 卡片，回合绝不因此中断。模型自写的计划文件仍然优先且永不被改写。

## Alternatives considered

**指示模型写计划文件（Claude Code 的原生机制）。** 落选：dsh plan mode 对工作区只读，harness 需要在 core 给 plans 目录开写豁免；且交付依赖模型自觉——对用户视为唯一持久记录的产物来说不可接受。

**在 dsh core 插件里持久化计划。** 落选：`dsh-plan-mode` 刻意是 log-only、非落盘的状态插件；计划 UX（卡片、导出、HTML 渲染）是 bridge 的领域，core 文件落点会引入只有这一个消费方需要的目录策略决策。

**修订时覆盖同名文件。** 落选：Claude Code 保留带时间戳的兄弟文件；被拒绝计划的前一版恰是用户想 diff 的内容；覆盖也让「内容相同则跳过」无法与破坏性改写区分。

## Consequences

dsh 计划记录与真 Claude Code 的计划记录同库，靠 cwd slug 按项目区分——统一计划库的收益，代价是目录中文件的 agent 来源是隐含的。记录在呈现时（批准前）即存在，被拒绝的计划也会留下文件，与 Claude Code 一致。文件名取呈现时刻的项目 workdir；会话中途 `/dir` 切换后，下一份计划按当前 workdir 命名而非最初那个。时间戳用本地时钟，同秒同名冲突会覆盖带时间戳的兄弟文件——为对齐与原子性接受（`atomicWriteFileSync` 保证不产生撕裂文件）。

## Testing

`tests/engine/plan-file.spec.ts`：helper 的命名/修订/去重/建目录用例，加上事件循环集成——呈现即写入全文文件、`planDir: ''` 跳过持久化、模型自写的 `.claude/plans` 文件永不被覆盖且卡片以其为源、目录不可写时回退 inline 卡片且不抛异常。
