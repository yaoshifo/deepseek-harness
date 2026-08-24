---
name: skillify
description: 处理 skill 生命周期的工具——创建（把当前会话里可重复的工作流捕获成一个新 skill）或规范化（把一个既有 skill 按规范审计并改造：拆文件夹、加 Gotchas、改 description、归一类等）。当用户想把工作流存成 skill、或想改造/规范化/audit 一个既有 skill 时使用。完成跨多步、含明确可复用模式的任务后，也在回合结束前主动提议一次（仅提议，不替用户决定；用户拒绝就不再提）。
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - AskUserQuestion
  - Bash(mkdir -p *)
when_to_use: >
  两种模式：
  创建（默认）——把当前会话的工作流保存/捕获/打包成一个新 skill。例句：'skillify this'、'把这个流程存成 skill'、'turn this into a skill'、'做成可复用命令'、'capture this process'、'把这次会话沉淀成 skill'。
  规范化——把一个既有 skill 按规范审计并改造。例句：'规范化这个 skill'、'normalize skill X'、'audit skill X'、'把这个 skill 整理一下'、'改造下 xxx skill'。
argument-hint: "[可选描述，例如「捕获 git rebase 工作流」]"
arguments:
  - description
---

# Skillify

你处理 skill 的生命周期——两种模式：
- **创建**（默认）：把当前会话里可重复的工作流捕获成一个新 skill。
- **规范化**：把一个既有 skill 按规范审计并改造（拆文件夹、加 Gotchas、改 description、归一类等）。

两种模式共用同一套规范资产（`references/` 下的参考文件）。

## 先定模式

按用户的请求二选一：
- **创建模式**（默认）：用户想把这次会话的工作流存成 skill。触发：'skillify this'、'把这个流程存成 skill'、'turn this into a skill'、'做成可复用命令'、'capture this process'。→ 走下面的"创建模式"步骤。
- **规范化模式**：用户想改造一个既有 skill。触发：'规范化这个 skill'、'normalize skill X'、'audit skill X'、'把这个 skill 整理一下'。→ `Read references/normalize-procedure.md` 并按它执行，**不走**下面的创建步骤。

判别：用户指定了**既有 skill 作为对象**（给了名称或路径）→ 规范化；谈的是**当前会话** → 创建。拿不准就用可用的结构化提问工具问一句。

本 skill 自身是个**文件夹**（SKILL.md + `references/` 下四份参考文件），按需 `Read`——这正是它教别人用的"渐进式披露"的活样本。详见文末"关于参考文件"。

## 创建模式

如果用户在 skill 名后提供了描述（`$description`），把它作为"要捕获什么"的高层意图。如果是空的，从上面的对话推断这个工作流的目的。

回顾上面的对话——它是你的素材来源。特别留意用户的消息（ta 如何引导和纠正流程）以及实际用到的工具/命令。

### Step 1：分析会话

提问之前，先分析会话，识别出：
- 执行了什么可重复的流程
- 输入/参数是什么
- 各步骤（按顺序）
- 每一步的成功产物/标准（例如不是"写代码"，而是"一个 CI 全绿的开放 PR"）
- 用户在哪里纠正或引导过你
- 需要哪些工具和权限
- 用了哪些 agent
- 目标和成功产物是什么

### Step 2：访谈用户

用结构化提问了解用户想自动化什么。要点：
- **所有问题都用结构化提问工具**（如本环境的 AskUserQuestion）——不要用纯文本提问。
- 每轮按需反复迭代，直到用户满意。
- 用户总有"其它"自由输入选项来打字补充或反馈——**不要**自加"需要调整"或"我来改"之类的选项。只给实质性的选项。

**Round 1：高层确认**
- 基于你的分析，建议 skill 的 name 和 description。请用户确认或重命名。
- 建议 skill 的高层目标（一个或多个）和具体的成功标准。
- **归一诊断（先做）**：`Read references/skill-categories.md`，把候选 skill 归入九类中的**一类**，连同 name/description 一起给用户确认。若横跨 ≥2 类，软提示"想做太多，考虑拆分或收窄"——不硬阻断。

**Round 2：更多细节**
- 把你识别出的高层步骤作为编号列表呈现。告诉用户下一轮会钻进细节。
- 如果你认为 skill 需要参数，基于观察建议参数。确保你理解别人需要提供什么。
- 如果不清楚，问这个 skill 该**在当前对话里跑**还是**另开一个独立子 agent 跑**：前者（默认，省略 `context` 字段）能看到对话历史、可中途插话引导；后者（写 `context: fork`）像把自包含的任务派出去、独立干完交结果，看不到主对话、无法插话。
- 问 skill 该存哪里。基于上下文建议默认值（仓库专属工作流 → 仓库；跨仓库的个人工作流 → 用户）。选项：
  - **本仓库**（`.claude/skills/<name>/SKILL.md`）—— 适合本项目专属的工作流
  - **个人**（`~/.claude/skills/<name>/SKILL.md`）—— 跨所有仓库跟随你
- **结构决策（与"存哪里"一起问）**：这个 skill 该是单文件还是文件夹？启发式：需要参考材料/脚本/产物模板 → 文件夹（建 `references/` `scripts/` `assets/` `examples/`）；短小纯流程 → 单文件也行；拿不准 → 倾向文件夹。文件夹结构说明详见 `references/output-template.md` 末尾。
- **跨运行记忆？**：这个 skill 需要跨运行记住状态吗（典型：每日汇总、增量回顾——要算"自上次以来变了什么"）？需要则 `Read references/skill-memory.md`，按约定给新 skill 加三步（先读 `~/.claude/skill-memory/<name>.log` → 干活 → append 一行）；无状态 skill（一次性、纯查询、纯渲染）不加。

**Round 3：拆解每一步**
对每个主要步骤，如果不是一目了然，问：
- 这一步产出什么后续步骤需要的东西？（数据、产物、ID）
- 什么能证明这一步成功了、可以往下走？
- 是否该让用户在继续前确认？（尤其是合并、发消息、破坏性操作等不可逆动作）
- 有哪些步骤是独立的、可以并行？（比如同时发 Slack 和监控 CI）
- 这一步该怎么执行？（比如总是用 Task agent 做代码评审，或为若干并发步骤调一个 agent team）
- 有哪些硬约束或硬偏好？必须或不必须发生的事？
- **这段该不该是脚本？**：若某步是确定性的（跑检查、拼文件、解析输出），提示存成 `scripts/foo.sh` 而非散文——让模型负责调用与组合，不重建样板。
- **这是 gotcha 吗？**：若涉及用户在原会话里纠正过的 footgun，路由到产物的 `## Gotchas` 段（不只是 Rules）。

这里可以多轮结构化提问，每轮聚焦一个步骤——尤其是超过 3 步或澄清问题很多时。按需迭代。

**重要**：特别留意用户在会话里纠正你的地方，用它们来指导设计。

**Round 4：收尾问题**
- 确认这个 skill 何时该被调用，并建议/确认触发短语。（例如对一个 cherry-pick 工作流你可以说：当用户想把一个 PR cherry-pick 到 release 分支时使用。例句：'cherry-pick to release'、'CP this PR'、'hotfix'。）
- 如果还不清楚，也可以问其它 gotcha 或要注意的地方。

信息够了就停止访谈。**重要**：对简单流程不要过度提问！

### Step 3：写 SKILL.md

在 Round 2 选定的位置创建 skill 目录和文件。

`Read references/output-template.md` 取骨架（含 frontmatter 规则、逐步注解、`## Gotchas` 槽、文件夹结构说明），按它生成。

**显而易见过滤器（写每段前问一句）**："删掉这段，Claude 默认行为会变吗？"——不变就删。只留能把模型推出默认思路的部分。

若 Round 2 决定做成文件夹：建目录 + 生成对应 reference/script/asset 文件，而非只写一个 SKILL.md。SKILL.md 里用"命中后 MUST 先读 `references/X.md`"指引模型按需读取（渐进式披露）。

### Step 4：确认并保存

**反模式审计（保存前）**：`Read references/anti-patterns.md`，把生成的 skill 对照清单查一遍（单文件该是文件夹 / 无 Gotchas / 复述显而易见 / description 无触发短语 / 钉死步骤 / 该脚本的写成散文 / 无 setup 沉淀）。命中就先修再存。

**frontmatter 机械校验（保存前）**：用可用的 YAML 解析器实际解析一遍 frontmatter（如 `node -e` 配 js-yaml、`python3 -c` 配 PyYAML），确认解析得到对象且含 `name` 与 `description`。PARSE OK 才算过——yaml 代码块的语法高亮目测不算。

写文件前，把完整的 SKILL.md 内容作为 yaml 代码块输出在回复里，让用户能在语法高亮下 review。然后用结构化提问问一个简单问题确认，比如"这个 SKILL.md 可以保存吗？"——不要用 body 字段，问题保持简短。

写完后告诉用户：
- skill 存在了哪里
- 怎么调用：`/{{skill-name}} [参数]`
- 可以直接编辑 SKILL.md 来打磨

---

## 关于参考文件

- `references/skill-categories.md` —— 创建模式 **Round 1** 归一诊断用的九类表。来源是 Anthropic 博客《Lessons from building Claude Code》。
- `references/output-template.md` —— 创建模式 **Step 3** 写 SKILL.md 用的骨架（frontmatter 规则 + 逐步注解 + `## Gotchas` 槽 + 文件夹结构说明）。从这个文件能看出"骨架本体"被迁出 SKILL.md 以保持入口轻量——这就是渐进式披露。
- `references/anti-patterns.md` —— 创建模式 **Step 4** 与规范化模式**第 2 步**共用的反模式审计清单。这是 skillify 的**复利资产**：撞到新反模式，回手往里补一条。
- `references/normalize-procedure.md` —— **规范化模式**的五步流程（读目标 → 审计 → 提议拍板 → 应用 → 复审）。只在规范化模式 `Read`。
- `references/skill-memory.md` —— 创建模式 **Round 2** 判断新 skill 要不要跨运行记忆时 `Read`（每日汇总、增量回顾类要；无状态 skill 不要）。

两种模式共用 `anti-patterns` + `categories`；创建模式额外用 `output-template` + `skill-memory`，规范化模式额外用 `normalize-procedure`。新生成的 skill 若要做成文件夹，可以模仿 skillify 自己的结构。
