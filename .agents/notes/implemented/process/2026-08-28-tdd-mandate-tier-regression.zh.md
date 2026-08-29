# Agent Note: TDD 强制约束的层级回归——常驻提示段优先于 skill description

Status: implemented

[English](2026-08-28-tdd-mandate-tier-regression.md) | 中文

## Problem

2026-08-24 的 dotfiles 迁移（commit `12ceaa3`，与本仓库 `7c12e26012` 对应）把全局 CLAUDE.md 的行为强制约束折进 `tdd` 与 `skillify` 两个 skill 的 description，其假设是：每会话可见的目录行与常驻指令具有同等行为约束力。「默认测试驱动」与 skillify 提议两节从机器本地的全局指令文件中删除，只剩目录条目。

迁移前后各约四天的会话日志测量显示：机制完好，TDD 实践崩塌——

- deepseek-harness coding 会话的助手输出携带 red-green 循环语言的占比：迁移前 37/56（66%），迁移后 18/126（14%）；强实践会话（≥3 处提及）从 29/56 跌到 6/126。
- `tdd` skill 部署正常——迁移后 139/139 个会话的目录都含该条目——两侧模型也未变（均为 glm-5.3）。可见不等于遵从。
- 迁移前的 reasoning 明确援引该强制约束（"TDD: red-green loop per global instructions"）；迁移后仍在实践的会话则是在决策时刻临场掂量目录行。测试仍在写（仓库测试政策与 pre-push 检查强制），但抽样的会话翻转为先实现后补测试（8 个中 6 个）。

这与 [workspaceSymbol 采用率研究](../feature/2026-08-27-lsp-workspace-symbol-entry-point.zh.md)记录的是同一个决策瞬间召回失败：description 对熟练意图不可靠触发，因为模型不会在动手实现的瞬间重读目录。

## Decision

两条强制约束恢复为随包部署的常驻系统提示段——不回到机器本地的全局指令文件：

- `tddDefaultPrompt()` 注册为 `feishu-bridge-tdd-default` 段（order 20），进普通会话**与** subtask 子会话：两个分支都跑编码回合，且被撤销的全局指令文件本就覆盖所有会话类型。
- skillify 提议并入 `agentConventionsPrompt()` 成为第四段：它是回合末面向用户的提议，与好奇心上报同级，保持 plain-only——subtask 子会话经父会话回报。
- `tdd` 与 `skillify` skill 的目录条目与正文不动。提示段承载强制约束，skill 按需承载循环细节。行为默认值需要常驻祈使句；description 行只负责路由召回。

## Alternatives considered

**把强制约束放回 ~/.claude/CLAUDE.md。** 否决：机器本地配置重新引入 2026-08-24 迁移封死的新机器部署缺口（dev 服务器的符号链接状态未核实）；仓库侧提示段经 `git pull` + daemon reload 即部署。

**改为强化 skill description。** 否决：崩塌期间 description 本就每会话对模型可见，更强的措辞面对的是同一个刚刚失败的决策瞬间召回机制。

**subtask 子会话也拿约定段。** 对 skillify 提议否决：它面向用户，subtask 子会话经父会话呈现发现——与好奇心上报、收尾卡片既有的 plain-only 层级一致。

## Consequences

普通会话携带约 1450 字符的约定段加约 360 字符的 TDD 默认段；subtask 子会话只携带 TDD 默认段；chatroom 人设整体替换系统提示、两段皆无，与其对约定段的既有处理一致。编码行为的覆盖与被撤销的全局指令文件持平；chatroom 角色无损失（bare persona 本就抑制指令注入）。

复测判据：部署后一周内，deepseek-harness coding 会话的 red-green 循环语言占比应恢复到迁移前 66% 的基线附近。扫描口径：对 feishu-bridge 会话存储的 `assistant/message` 事件做 `zstdcat` 行级正则，会话按 2026-08-24 10:21 迁移 commit 分界，分母取 coding 会话（含 ≥1 次 grep/read/edit/write/glob/bash/lsp 工具调用）。两个方法坑：解压前必须用 glob 解析会话目录（截断的会话 id 会让 `zstdcat` 静默失败返回空输出）；按会话计数须过滤 mem0 slug 的渲染会话。
