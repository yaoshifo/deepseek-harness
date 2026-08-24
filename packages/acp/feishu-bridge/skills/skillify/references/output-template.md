# Skill 输出骨架

skillify 在 **Step 3** 写 SKILL.md 时 `Read` 本文件取骨架。这是默认结构，按实际增删——简单流程别给每步都堆注解。

## frontmatter 规则

- `name`：kebab-case。
- `description`：一句话，**写给模型当触发器**（不是写给人的摘要）。见 `anti-patterns.md` 第 4 条。
- **自由文本值（`description`、`when_to_use`）整体加双引号**：触发描述常含「冒号+空格」、引号、逗号——裸标量里的 `: ` 会被 YAML 当成新映射键，frontmatter 解析失败后 skill 被**静默跳过**、对模型不可见（`anti-patterns.md` 第 8 条）。
- `allowed-tools`：最小权限，用模式如 `Bash(gh *)` 而非裸 `Bash`。
- `when_to_use`：**关键**。以「当……时使用」（英文 `Use when...`）开头，含触发短语与例句。模型只靠它 + description 决定要不要加载这个 skill。
- `arguments` / `argument-hint`：仅当 skill 接参数才写，body 里用 `$name` 代入。
- `context`：仅自包含、无需中途用户输入的 skill 才设 `context: fork`（=另开一个独立子 agent 跑、看不到主对话历史；省略即在当前对话里跑）。

## 骨架

````markdown
---
name: {{skill-name}}
description: "{{一句话触发描述}}"
allowed-tools:
  {{最小权限列表}}
when_to_use: "{{何时自动调用 + 触发短语 + 例句}}"
argument-hint: "{{参数占位提示}}"
arguments:
  {{参数名列表}}
context: {{inline 或 fork —— inline 省略}}
---

# {{Skill 标题}}

一句话说清这个 skill 做什么。

## 输入
- `$arg_name`: 这个输入的说明

## 目标
清晰陈述目标。最好有明确的完成产物 / 判定标准。

## 步骤

### 1. 步骤名
具体、可执行。该上命令就上命令。

**成功标准**：必有！表明这步完成、可以往下走。可列表。

（逐步注解按需添加，见下。）

...

## Gotchas
从原会话提炼的 footgun，每条"**症状** → **做法**"。这是 skill 的复利资产——随使用累积，撞到新坑就补一条。
- **症状**：{{出错的表象}} → **做法**：{{正确的处理}}。
- ...
````

## 逐步注解（按需）

- **成功标准**：每步必有。表明这步完成、可以往下走。
- **执行（Execution）**：`Direct`（默认）/ `Task agent`（直链子 agent）/ `Teammate`（真并行 + 互通）/ `[human]`（用户做）。非默认才写。
- **产物（Artifacts）**：这步产出的、后续步骤要用的数据（PR 号、commit SHA）。仅后续依赖时写。
- **人工检查点（Human checkpoint）**：何时停下问用户。合并 / 发消息等不可逆动作、冲突判断、产出审查时写。
- **规则（Rules）**：硬规则。原会话里用户纠正过的地方特别有用——但纯 footgun 优先放 `## Gotchas`。

## 结构提示

- 可并行的步骤用子编号：3a、3b。
- 要用户做的步骤，标题里加 `[human]`。
- 保持简单：2 步的 skill 不必每步都注解。

## 如果 Round 2 决定做成文件夹

除了 SKILL.md，按需建子目录，并在 SKILL.md 里用"命中后 MUST 先读 `references/X.md`"指引模型按需读取（渐进式披露）：

- `references/` —— 参考材料（API 文档、命令清单、分类表、字段映射）。SKILL.md 只留入口与"何时读哪个"。
- `scripts/` —— 确定性脚本（跑检查、拼文件、解析输出）。让模型负责调用与组合，不重建样板。
- `assets/` —— 产物模板（如最终要生成的文件模板）。
- `examples/` —— 范例产物，供模型模仿（用 grep 抓片段，不要整读）。

判别：SKILL.md 应当**轻**。如果它已经超过 ~200 行或塞了大段参考表 / 命令清单 / 模板，就该把那部分拆进上面的子目录。`skills/html` 和 `skills/lark-doc` 是这套结构的成熟范例。
