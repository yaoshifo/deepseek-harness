---
name: dsh-absorb-upstream
description: "Use after an upstream merge into dev to review what changed, evaluate which fork features can absorb it, and land the chosen capability — triggers include 「合并后有哪些变化」「上游带来了什么」「二开能不能用上」「吸收上游」「absorb upstream」. Three gated phases: survey report → absorption assessment (wait for approval) → TDD landing (plan approval)."
---

# DSH Absorb Upstream

上游合并进 dev 之后的三段式吸收循环：盘点变化 → 评估二开功能能吃上什么（等拍板）→ 拍板后按 TDD 落地。与 `dsh-sync-upstream`（合并本身的守护流程）衔接：合并未做先走它；本 skill 从合并已存在开始。

## 输入

- `$description`（可选）：聚焦某个能力或包（如「看 steer 服务」）；缺省则全量盘点
- 合并范围（可选）：merge commit 引用或日期窗口；缺省取最近一次 `Merge branch 'master' into dev`
- 回复深度（可选）：默认「概括」；用户说「通俗的解释」时按白话直讲重答（直接讲事情本身，术语展开成大白话，用具体的事实和数字做支撑），不是继续往下走

## 步骤

### 1. 定位合并并盘点变化

**执行（Execution）**：Direct；大合并（数百提交以上）的聚合与 PR 梳理可并行。命中后 MUST 先读 `references/survey-commands.md` 取命令集与报告结构。

纯读操作，无门。产出按用户要求深度的变化报告（规模三件套 / 主题分布 / PR 清单 / 冲突裁决摘要 / fork 补丁提交）。用户可以只要报告就停。

**成功标准**：报告覆盖规模、主题、对二开的影响面；用户明确表示继续，或止步于此。

### 2. 吸收评估

**执行（Execution）**：Direct；大合并鼓励用 `feishu-bridge-subtask` 按能力/包分片并行调研（常规规模串行）。命中后 MUST 先读 `references/absorption-eval.md` 取方法论（三分类、托管架构验证、应用点映射表、discoverability 设计）。

**产物（Artifacts）**：评估报告——每个应用点带机制、价值、工作量、权衡，按推荐顺序排列。

**人工检查点（Human checkpoint）**：交评估即停，等用户拍板（「做吧」/选项卡勾选）。未拍板前一行产品代码不动。

**成功标准**：fork 相关能力全部归入「已等价 / 已半消费 / 完全未用」三类；应用点有可验证的价值与工作量判断。

### 3. 落地（拍板后）

命中后 MUST 先读 `references/landing-checklist.md` 取落地清单（TDD 垂直切片、flaky 基线甄别、Agent Note 三件套、双语 README 配对、typecheck、commit）。

**人工检查点（Human checkpoint）**：双门的第二道——出完整实施计划过 plan 模式批准后才动手；评估拍板管「做什么」，计划批准管「怎么做」。

**成功标准**：TDD 全程红绿；包级全量测试与 typecheck 干净；文档门禁（note 格式、双语配对）全过；按仓库规范自动 commit（不 push）。

## Gotchas

- **症状**：断言「fork 功能 X 能用上上游服务 Y」结果落点是错的（如初判 chatroom role 可走 subagent steer 服务）→ **做法**：断言前先验证 X 的托管形态——native continuable child / attended group / 进程内 handle 三态决定正确接入点（`deliverSubagentPrompt` / `deliverMachineMessage` / `Agent.steer` 直调）。详表在 `references/absorption-eval.md`。
- **症状**：新增测试后全量套件冒红，怀疑自己改坏了 → **做法**：先 `git stash` 跑基线全量对照——基线也红是既有竞态被调度时移暴露（修法参考同文件姊妹测试的既有模式，如 `vi.waitFor`）；基线绿才是自己引入。细节在 `references/landing-checklist.md`。
- **症状**：加了模型可见的新能力但模型从不使用 → **做法**：schema 即发现面——参数描述写决策指引（何时选它）而不只写语义，并在自然的提示点（如 spawn/ask 的结果消息）主动告知干预通道。
- **症状**：工作期间 dev 上出现不是自己创建的 merge commit → **做法**：并行会话/用户在推进，属正常；验证跑在实际工作树上、提交干净落顶即可，不用回滚不用惊慌。
