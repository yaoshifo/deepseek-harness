# Skill 反模式 checklist

skillify 在 **Step 4** 保存前 `Read` 本文件，把生成的 skill 对照查一遍。命中就先修再存。

来源：Anthropic《Lessons from building Claude Code》九条经验反推。

## 清单（症状 → 为什么坏 → 怎么修）

### 1. 单文件该是文件夹
- **症状**：只有 SKILL.md，但内容含大量参考表 / 命令清单 / 脚本 / 模板。
- **坏**：SKILL.md 每次触发全量进上下文，又贵又稀释注意力。
- **修**：参考拆进 `references/`、脚本进 `scripts/`、模板进 `assets/`。SKILL.md 只留入口与"何时读哪个"的指引。判别：SKILL.md 超过 ~200 行或塞了大段参考，就该拆。

### 2. 复述显而易见
- **症状**：写了"Claude 默认就会做"的内容（如"如何写一个 Python 函数"、"用 git 提交"）。
- **坏**：只增 context 不增价值。
- **修**：每段问"**删掉它，Claude 默认行为会变吗？**"——不变就删。只留能把模型推出默认思路的部分（团队约定、内部 API、非默认偏好）。

### 3. 无 Gotchas 段
- **症状**：footgun 散落在 Rules 里，或根本没记。
- **坏**：gotcha 是 skill 信号最高的内容；不集中就难累积、难复用。
- **修**：单设 `## Gotchas`，每条"症状→做法"。原会话里用户纠正过的地方优先入此。

### 4. description 写给人看
- **症状**：description 是文绉绉摘要，无触发短语；或漏 `when_to_use`。
- **坏**：模型只靠 description 决定要不要加载，对不上号就永不触发（"欠触发"）。
- **修**：description 写"**何时触发 + 内容类型 + 交付渠道**"；`when_to_use` 列真实触发短语（中英都给，如"babysit"/"盯着 PR"）。把用户真实会说的词埋进去。

### 5. 钉死执行步骤
- **症状**：指令是"先跑 X，再跑 Y，然后 Z"，换情境就失效。
- **坏**：skill 可复用，死步骤在没料到的情境里崩。
- **修**：写"**意图 + 约束**"（目标是什么、什么不能碰），把执行路径留给模型当场定。

### 6. 该脚本的写成散文
- **症状**：确定性逻辑（跑检查、拼文件、解析输出）用大段文字描述，让模型每 turn 重建。
- **坏**：费 token 又易错。
- **修**：确定性部分提成 `scripts/foo.sh`，模型只负责调用与组合。

### 7. 无 setup 沉淀
- **症状**：每次运行都问用户同样的配置（如 Slack 频道、默认分支）。
- **坏**：打扰用户，且易不一致。
- **修**：一次性配置落 `config.json`，首次问、之后读。

### 8. frontmatter 非法 YAML（skill 静默不可见）
- **症状**：SKILL.md 在盘上、内容完好，但从不进 available_skills 目录，`skill` 工具按名加载也报 unknown。
- **坏**：`description` / `when_to_use` 裸标量含「冒号+空格」（如 `maintenance: preview`）→ YAML 解析失败 → 发现机制只记 warn 并静默跳过。无报错、无目录条目；且不带 `agents/openai.yaml` 侧卡的 skill 不过仓库 gate，坏文件照常上线。
- **修**：自由文本值一律整体双引号（内部引号改用「」）；保存前用 YAML 解析器机械校验，PARSE OK 才存。

## 用法

这是 skillify 的**复利资产**。以后用 skillify 造 skill 时撞到新的反模式，回手往这里补一条。
