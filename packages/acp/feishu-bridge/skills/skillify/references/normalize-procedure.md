# 规范化模式流程

skillify 在**规范化模式**（用户给了一个既有 skill 要改造）下 `Read` 本文件。对象是一个既有 skill——用户提供路径或名称。

核心：规范化是**判断活**，不是机械活。先看清现状，逐条审计，**侵入性改动必须用户拍板**，拿不准就问。

## 流程

### 1. 读目标
- 确定目标 skill 的路径。用户给了名称就定位到 `~/.claude/skills/<name>/`（个人）或 `.claude/skills/<name>/`（仓库）；给了路径就直接用。
- `Read` 它的 SKILL.md。若是文件夹，用 `Glob` 列出全部文件，掌握现有结构（有没有 `references/` / `scripts/` / `examples/`，各自装了什么）。
- **先别改**——先看清现状：frontmatter（name / description / allowed-tools / when_to_use 齐不齐）、SKILL.md 体量、是否已是文件夹、中英文是否混杂。

### 2. 审计
`Read references/anti-patterns.md` 和 `references/skill-categories.md`，对目标逐项查：

- **归一**：干净落九类里的哪一类？横跨了没？（横跨本身是规范化要解决的问题之一。）
- **反模式 7 条**（逐条对照）：
  1. 单文件该是文件夹（SKILL.md 超 ~200 行 / 含大段参考表、命令清单、模板）
  2. 复述显而易见（删掉 Claude 默认行为不变的内容）
  3. 无 Gotchas 段（footgun 散落或没记）
  4. description 写给人看（无触发短语 / 漏 when_to_use）
  5. 钉死执行步骤（"先 X 再 Y"而非给目标）
  6. 该脚本的写成散文（确定性逻辑没存成 `scripts/`）
  7. 无 setup 沉淀（每次问同样配置）
- **额外**：SKILL.md 超 ~200 行该外置；`references/` 用得对不对；frontmatter 字段全不全；若目标是增量回顾类 skill 却无记忆机制，提示考虑 `Read references/skill-memory.md` 加上。

整理成**问题清单**，每条三行：现象 → 违反哪条 → 建议改法。按严重度排序（影响触发 > 结构 > 内容）。

### 3. 提议 + 用户拍板
用 AskUserQuestion 把问题清单**分批**呈现，让用户选改哪些。**所有问题都用 AskUserQuestion**（沿用创建模式的纪律）。

**侵入性改动必须征得同意**——不能擅自做：
- 拆成文件夹 / 移动文件
- 删段落（即便判定为"显而易见"也要用户点头）
- 改 description / name（影响触发）
- 加 Gotchas（需要用户回忆 footgun 的具体症状）

低风险改动（修格式、补 when_to_use 例句、修笔误）可以打包一并提议。

### 4. 应用
按用户勾选的清单改：
- 守"显而易见过滤器"——但删除要有第 3 步的用户授权。
- 拆文件夹时：`mkdir` 建 `references/` 等，把超长内容迁出去（Write 新文件 + Edit 原 SKILL.md 删掉那段），SKILL.md 只留入口 + "何时读哪个"的指引。
- 加 `## Gotchas` 段，把用户回忆出的 footgun 路由进去（每条"症状→做法"）。
- 改 description / when_to_use 成触发导向（参考 `anti-patterns.md` 第 4 条）。
- 必要时 `Read references/output-template.md` 对齐骨架（Gotchas 槽、frontmatter 规则、文件夹结构）。

### 5. 复审
- **重跑第 2 步审计**，确认问题清单清零（或用户明确选择保留的）。
- 给用户一个 **before/after 摘要**：改了哪几条、剩哪几条（含用户选择保留的理由）。
- **不自动提交**。让用户 `git diff` review 后自己决定是否 commit。

## 注意
- 拿不准就问，别替用户决定删除 / 拆分。
- 若目标 skill 横跨九类 ≥2，软提示用户考虑拆成两个 skill——这是规范化模式的合法产出之一（创建模式做不了这件事）。
- 守 skillify 自己教的规矩：渐进式披露（SKILL.md 轻、详情外置）、单文件该升级成文件夹时就升。
