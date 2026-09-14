# Skill 输出骨架

skillify 在 **Step 3** 写 SKILL.md 时 `Read` 本文件取骨架。这是默认结构，按实际增删——简单流程别给每步都堆注解。

## frontmatter 规则

- `name`：kebab-case。
- `description`：一句话，**写给模型当触发器**（不是写给人的摘要）。模型只靠它决定要不要加载这个 skill——触发短语必须写在这里。见 `anti-patterns.md` 第 4 条。
- **自由文本值（`description`）整体加双引号**：触发描述常含「冒号+空格」、引号、逗号——裸标量里的 `: ` 会被 YAML 当成新映射键，frontmatter 解析失败后 skill 被**静默跳过**、对模型不可见（`anti-patterns.md` 第 8 条）。
- `disable-model-invocation` / `user-invocable`：调用开关（布尔，连字符拼法）。仅在需要禁止模型自动调用、或禁止用户直接调用时写。
- **只写上面这些。** dsh 不解析 `allowed-tools`、`disallowed-tools`、`argument-hint`、`arguments`、`context`、`when_to_use`（下划线拼法）——写了也不生效（静默忽略）。工具授权走 dsh 的沙箱策略与权限预设，不是 per-skill 声明。`whenToUse`（驼峰）dsh 认，但只进用户侧技能列表（dsh web），**模型看不到**——别指望它做路由。
- **旧拼法会让 skill 整个消失**：`disableModelInvocation` / `modelInvocable` / `userInvocable` 被判为不支持的字段，该 skill 直接被丢弃（只在日志留一行警告），模型完全看不到它。调用开关一律连字符，`whenToUse` 例外是驼峰。

## 骨架

````markdown
---
name: {{skill-name}}
description: "{{一句话触发描述，含触发短语}}"
---

# {{Skill 标题}}

一句话说清这个 skill 做什么。

## 输入
- 输入名：这个输入的说明（必填 / 可选）

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
