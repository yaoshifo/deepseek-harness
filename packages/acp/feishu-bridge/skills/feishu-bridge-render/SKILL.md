---
name: feishu-bridge-render
description: "内部专用——仅 feishu-bridge 的 plan/reply 渲染会话使用。把一份 plan 或一轮已完成回复渲染成单文件浅色主题 HTML——只渲染概览；完整 plan/回复不重复（已在对话里发过）。plan 子型产出执行者可用的结果概览；reply 子型产出有证据的一屏完成结果。由 feishu-bridge 的 plan_render 渲染会话经 dsh skill 注册表内联调用；不对模型广告、不用于 coding 会话直接使用。"
disable-model-invocation: true
user-invocable: false
---

# feishu-bridge 渲染 skill

本 skill 把一份 **plan** 或一轮 **回复** 渲染成**浅色主题 HTML 的 body 片段**（`<div class="wrap"> … </div>`）。调用方（feishu-bridge 的渲染会话 prompt）指明 `plan` 还是 `reply` 子型，并在用户消息里给出 `html_path`（写文件路径）与内容块。

**你只输出 body 片段**——`<div class="wrap">` 开始、`</div>` 结束的 HTML。**不含** `<!DOCTYPE>`/`<html>`/`<head>`/`<title>`/`<style>`。CSS 由 feishu-bridge 引擎用固定模板注入（class 名对应该模板），你不再写 CSS、不写完整 HTML 文档——这能省下大量输出 token。写完整 HTML 文档（带 `<style>`/`<head>`）是失败模式。

---

# 输出格式（最高优先级，与预算同级）

- 只写 `<div class="wrap"> … </div>` 这一个块到 `html_path`。
- **绝不**输出 `<!DOCTYPE>`、`<html>`、`<head>`、`<title>`、`<style>` 或任何 CSS——engine 用固定 CSS 模板包住你的片段。
- body 内的样式只靠本 skill 定义的 class（`.wrap`/`header`/`.summary-band`/`.diagram`/`.key-point`/`.keypoints`/`.file-list` 等），或内联 SVG 的属性。不要在 body 里加 `<style>` 块或 `style=` 行内样式表。

---

# 硬性预算 + 去重（两子型共用，最高优先级）

这三条凌驾于下面所有组件规则之上——组件上限只是为了让产出凑进预算，遇到冲突先满足这三条。

- **可见正文总字数 ≤ 300 个中文字符**：只管正文——含 header 标题/副标题、`.explain`、`.key-point`、`.summary-band`、keypoints；**不含图里的 `<text>` 标签**（图标签有独立预算，按需保留关键实体名与关系，不挤占正文 300 字）；**不含** HTML 标记（CSS 已由 engine 注入，不在你的产出里）。300 是**上限不是目标**——宁可少写，把字数留给最重要的信息。
- **每个事实只出现一次（去重）**：header 副标题、图的标签、`.explain`、`.key-point`、keypoints 之间**不得互相重复**同一信息——选一个最合适的位置说，其余不写。典型重复要避免：header 副标题已说背景/问题，`.explain` 就别再复述同一句；图已画的流程/结构，文字别再逐步重述。
- **只放最重要的信息**：砍掉一切非决策相关的细节。凑数式组件（无真实数字的 `.summary-band`、无重点的 `.key-point`、与图重复的 `.explain`）整段省略，不要为了填满版面而硬凑。
- **术语边界（概览保留什么、丢什么）**：只保留决策相关的 specifics——错误码（如 `230011`）、配置项/flag、用户可见 API、改动涉及的核心文件路径、数字、成功判据、并发/兼容性边界。**不保留实现层标识符**——任何语言的函数名、方法名、变量名、字段名、内部 helper 名、**测试函数名**等代码符号，除非它本身就是用户可见 API；成功判据用大白话描述（如"加测试断言 prompt 含 spawn"），不点名测试函数。这些属于完整 plan/回复，已在对话里发过，不进概览。

---

# 子型 `plan`：只渲染概览

## 定调：先讲结果，只放概览

plan 的正文是给**执行**用的技术内容（文件路径、命令、术语），原样铺开非技术读者看不懂、也懒得看。这份 HTML 是给**人快速看懂并决策**的，所以：

- **主干 = 执行者可用的结果概览**：固定按“目标或结论 → 影响范围 → 风险或约束 → 验证状态 → 关键决策”的优先级选信息；没有内容的层次不硬凑。验证状态要区分已经执行并成功的检查与尚待执行的验证计划，不能把计划运行的测试写成已通过。
- **不重复完整技术原文**：完整 plan（Context 背景、文件清单、命令步骤、验证）已在对话发过，**不进 HTML**——HTML 只放概览，细节就丢掉，别塞进概览区。
- `.key-point` 先说结果或影响，但保留判断所需的术语、数字、文件名、成功判据和限制。
- **行内强调**：正文（header 副标题、`.explain`、`.key-point` 内容）里，每句挑**最关键的 1 个**结果/数字/名词包进 `<strong>`（自动渲染为 accent 色加粗）。是强调不是装饰——一句最多 1 处，无关紧要别加粗。

调用方传的是 `<plan-markdown>`（**原始 markdown**）。你面向不了解本次实现背景的技术协作者提炼概览，不要把原文渲染进 HTML（原文已在对话里）。

## 组件

只有一区：**概览区**（主干，大白话）。组件清单是**封闭集合**——不要发明清单外的自定义组件/CSS 类（如自造 `.change-item` 卡片）。不满足触发条件的组件**不放**；plan 里有的细节**不进 HTML**（完整 plan 已在对话里，概览只放提炼，别堆细节）。

> 下面组件用的 class（`header`/`.sub`/`.summary-band`/`.cell`/`.num`/`.diagram`/`.explain`/`.key-point`/`.label` 等）都对应 engine 注入的固定 CSS——你只管用这些 class 写 body 片段，不用管 CSS 怎么实现。

### 概览区（默认可见，大白话）

| 组件 | 何时放 |
|---|---|
| `<header>` | 题目（取 plan 首 `#` 标题）+ 一句话讲清目标或结论。先用易懂表达，仅保留决策相关的 specifics（见上「术语边界」）。**必放**。 |
| `.summary-band`（3–4 格，**可省**） | 仅当能帮助执行者快速判断影响范围、风险或约束、验证状态时才放。无真实数字用定性标签（小改 / 中改 / 重构，低 / 中 / 高），**不编造**精确指标；尚未执行的测试标为验证计划，不写成通过。无统计价值时整段砍掉。**计入 300 字预算，预算紧时优先砍**。 |
| 图解（**按需，最多 1 张**） | 只有存在真实的调用链、数据流、模块关系、状态变化、前后结构或方案对比时才画；纯机械修改、单一测试结果、简单结论不要画。图只表达关系，文字只表达结论，`.key-point` 只表达决策、风险或待办；三者不得重复同一事实。流 / 分层 / 前后对比优先 CSS 部件，复杂拓扑才用 SVG。 |
| `.key-point`（**≤2，可省**） | 挑**决策、风险或约束相关**的 1-2 条，标成四周粗框块。**首子节点写 `<div class="label"><svg class="icon"><use href="#icon-…"/></svg></div>`**（语义图标，见下「图标」），标签文字与配色由 CSS 按修饰类自动注入、不写文字：`decision`→关键决策、`risk`→主要风险（红）、`constraint`→核心约束（靛蓝）、不修饰→重点。**硬上限 2 条**——满屏重点=没重点。先说结果/影响，仅保留决策相关的 specifics（见「术语边界」）；纯机械改动无重点时整段省略。 |
| `table.compare`（**可省**） | 仅当有**真实的二维对比**（方案 A vs B / 新旧做法 / 配置矩阵 / 多维属性对照）才放，≤4 列 × ≤5 行——**不要**用 SVG `<rect>` 手画表格，用真表格。无对比维度不放。 |

> 完整技术 plan（Context / 文件清单 / 步骤 / 验证）已在对话发过，**不进 HTML**——本子型只渲染上面的概览区。

## 产物结构（plan 子型 — 照这个填，**只写 body 片段**）

```html
<div class="wrap">

  <!-- ===== 概览区（默认可见，大白话）===== -->
  <header>
    <h1><svg class="icon"><use href="#icon-map"/></svg> {题目}</h1>
    <p class="sub">{一句话：背景或要解决的问题（为什么要做），大白话提炼}</p>
  </header>

  <!-- 有统计价值时：可选 .summary-band（3–4 格）；无则砍掉 -->

  <!-- 有真实结构关系时才画：图只表达关系，.explain 只表达结果/影响 -->
  <div class="diagram">
    {内联 SVG 或 draw skill 产出的 SVG}
    <div class="explain">{≤2 句结果或影响，仅保留决策相关的 specifics（见「术语边界」）}</div>
  </div>

  <!-- 决策相关的 1-2 个 .key-point（四周粗框，大白话写）；无则省略 -->
  <!-- 首子节点 .label 包语义图标，标签文字+配色由修饰类自动注入：decision→关键决策 / risk→主要风险(红) / constraint→核心约束(蓝) / 不修饰→重点 -->
  <div class="key-point decision"><div class="label"><svg class="icon"><use href="#icon-diamond"/></svg></div>{大白话：结果/影响}</div>

  <!-- 有二维对比时：可选 <table class="compare">（≤4×5，方案/新旧/配置对照）；无则省略 -->

  <!-- 完整技术 plan（Context/文件清单/步骤/验证）已在对话发过，不在此 HTML 重复 -->

</div>
```

---

# 子型 `reply`：一屏概览

## 定调：EXECUTIVE SUMMARY，不是教学长文

用户要的是**扫一眼就知道"做了什么"**。因此：

- 先在内部把素材分为**已完成、关键结果、未完成/风险、后续**，页面只选其中有内容且最重要的 2–3 类。主体是 **key-point 清单**，每条**一行**：动作 + 产物/影响。**不要**把任何一条展开成多段教学。
- 查看、尝试、分析、推测只是过程，不能写成已完成；只有代码已修改、命令已执行并成功、产物已生成，或纯调查任务已得到有证据的结论，才算完成。**没有证据**不得写成“已修复”“已验证”“已生成”。
- **不要**每节配可视化、**不要**强制举例、**不要**为每个流程画图。
- 完整回复已在对话里——HTML 概览区只放"结论 + 关键条目"，不重复完整原文。
- 组件清单是**封闭集合**，但**按内容需要选用**：每个组件下方写明触发条件，不满足就**不放**，不要硬凑。宁可少一段，不要凑一段。

`<strong>` 全局已是 accent 色加粗——`.keypoints` 清单的动作用它自带强调，正文（`.explain`、header `.sub`）里也挑每句**最关键的 1 个**产出/影响包进 `<strong>`，一句最多 1 处，别滥用。仅当有**远比其他条目重要**的单条结论时才额外加 1 个 `.key-point` 块。

## 组件

> class（`header`/`.sub`/`.summary-band`/`.keypoints`/`.key-point`/`.file-list` 等）对应 engine 注入的固定 CSS——只管用这些 class 写 body 片段。

| 组件 | 说明 |
|---|---|
| `<header>` | 题目 + 一句话："这轮做了 X，结果是 Y"（结论 + 产出） |
| `.key-point`（**≤1，可省**） | 仅当某条结论/影响**特别重要**（修复阻断性 bug、引入破坏性变更、关键决策落地）时，单独拎成四周粗框块。**首子节点写 `<div class="label"><svg class="icon"><use href="#icon-…"/></svg></div>`**（语义图标，见下「图标」），标签文字与配色由 CSS 按修饰类自动注入、不写文字：`conclusion`→核心结论、`impact`→关键影响、`risk`→主要风险（红）、不修饰→重点。**硬上限 1 条**。多数 reply 不需要——key-point 清单本身已是重点，别为了用而用。放 header 后或"做了什么"清单后。 |
| `.summary-band`（3–4 格，**可省**） | 维度建议：改动文件数 / 新增 vs 修改 / 是否加测试 / 影响面 |
| 主体 key-point（**≤4**，每条 1 行） | 标题"做了什么"：动作 + 产物/影响 |
| `.file-list`（**≥2 个文件改动时放**） | 文件 + 类型徽章 + 一句改动。**≤4 行**，超出写"+N 个"；吃预算，放它就相应减少 keypoints |
| 图（**按需**，最多 1 张） | 只有存在真实的组件/模块关系、数据流、调用链、状态变迁或前后结构时才画；简单确认、单文件机械修改、纯测试结果不画 |
| 尾部 key-point（**可选**，≤3） | 标题"注意/后续"（标题前放 `triangle-alert`/`clock` 图标） |
| `table.compare`（**可省**） | 仅当改动是**对比性变更**（接口前后 / 配置新旧 / 方案取舍）才放，≤4 列 × ≤5 行。reply 偏一屏概览，无对比维度不放。 |


**summary-band**：只放**能帮扫一眼定范围**的维度。没有真实数字时用**定性标签**（如"小改 / 中改 / 重构"、"低 / 中 / 高"），**不要编造**精确指标。**纯查询 / 无统计价值时直接砍掉整个 summary-band**（header 后接 key-point），不要硬凑空格。

**key-point**：每条**严格一行**（≤30 个中文字符），结构 `<strong>动作</strong> — 影响/产物`。**禁止**两三行散文、禁止堆砌细节——细节不进 HTML（完整回复已在对话里）。提炼自原文，不要逐条翻译原文 bullet。

**file-list**：涉及 **≥2 个文件改动**时放（纯查询 / 单文件 / 纯文本**不放**）。每行 `<span class="badge {类型}"></span><code class="path">{文件路径}</code><span class="what">{一句改动}</span>`。徽章只写 class、中文由 CSS 自动填：`add`→新增 · `mod`→修改 · `del`→删除 · `fix`→修复 · `refr`→重构。

> 完整回复已在对话里，**不进 HTML**——本子型只渲染概览区（`<plan-rendered-html>` 片段仅作提炼素材，不原样嵌入）。

## 图解（按需，最多 1 张）

只有存在真实的模块关系、调用链、状态变化、数据流、前后结构或方案对比时才画图；简单确认、单文件机械修改、纯测试结果不画。图只表达谁连接谁、数据如何流动、状态或结构如何变化；文字只表达这对用户的结果、影响和限制；`.key-point` 只表达需要决策、注意或尚未解决的事项。图中已有的步骤、节点和流向不得在 `.explain` 或 key-point 中逐项复述。

## 产物结构（reply 子型 — **只写 body 片段**）

```html
<div class="wrap">

  <header>
    <h1>{题目}</h1>
    <p class="sub">{一句话："这轮做了 X，结果是 Y"}</p>
  </header>

  <!-- 有真实结构关系时才画：图只表达关系，.explain 只表达结果/影响 -->
  <div class="diagram">
    {内联 SVG 或 draw skill 产出的 SVG}
    <div class="explain">{≤2 句结果或影响，仅保留决策相关的 specifics（见「术语边界」）}</div>
  </div>

  <!-- 有特别重要的结论时：可选 1 个 .key-point 块（四周粗框）；多数 reply 省略 -->
  <!-- 首子节点 .label 包语义图标，标签文字+配色由修饰类自动注入：conclusion→核心结论 / impact→关键影响 / risk→主要风险(红) / 不修饰→重点 -->
  <!-- 有统计价值时：可选 .summary-band（3–4 格）；纯查询砍掉 -->

  <h2><svg class="icon"><use href="#icon-list"/></svg> 做了什么</h2>
  <ul class="keypoints">
    <li><strong>{动作}</strong> — {产物/影响}</li>
    <!-- ≤4 条，每条一行 -->
  </ul>

  <!-- 涉及 ≥2 个文件改动时：<h2><svg class="icon"><use href="#icon-folder"/></svg> 改动文件</h2> + <ul class="file-list">…</ul> -->
  <!-- 对比性变更时：可选 <table class="compare">（前后/新旧对照，≤4×5）；无则省略 -->
  <!-- 有后续时：可选 <h2><svg class="icon"><use href="#icon-triangle-alert"/></svg> 注意/后续</h2> + <ul class="keypoints">（≤3） -->

  <!-- 完整回复已在对话里，不在此 HTML 重复 -->

</div>
```

---

# 图解 + 解释的调性：易懂，但技术准确性优先

面向**不了解本次实现背景的技术协作者**：先用一句易懂的话说明结论或影响，必要时紧跟决策相关的 specifics（见「术语边界」）。

- **结果导向**：`.explain` 只说关系带来的结果、影响或限制，不逐步复述图中的节点与流向。
- **技术准确性优先**：简化表达不能改变适用范围、成功判据、并发边界或兼容性代价；类比仅在能降低理解成本且不会替代技术事实时使用。
- **职责分离**：图只表达关系，文字只表达结论，`.key-point` 只表达决策、风险或待办；同一事实只出现一次。

---

# 原生画图参考（三种常见形态优先 CSS 部件，其余手画 SVG，免网络）

三种最常见形态**优先用 CSS 部件**（`.flow` / `.layers` / `.diff`，见下）——你只填语义文本、不写任何 SVG 坐标或字号，CSS 自动排版与画箭头，**杜绝字号溢出 / 节点重叠**。状态变迁等其它拓扑手画原生 SVG（免 kroki.io 网络往返、最快）。真正复杂的图（多角色时序、ER、数据图、字节布局）才调 `draw` skill。

## CSS 部件（首选，只填文字）

外层仍用 `<div class="diagram">` 包裹，图下紧跟 `.explain`。节点可用 `class="core"`（靛蓝粗边）/ `class="risk"`（红）语义上色，与 SVG 节点同义。

- **流 / 管线**（`.flow`）：横向几个 `<span>`，块间箭头自动画。
  ```html
  <div class="flow"><span>输入</span><span class="core">引擎</span><span>输出</span></div>
  ```
- **分层架构**（`.layers`）：上下叠的带，每带一个 `<div>`。
  ```html
  <div class="layers"><div>前端</div><div class="core">服务</div><div>存储</div></div>
  ```
- **前后对比**（`.diff`）：左右两栏 + 中间箭头。
  ```html
  <div class="diff"><div class="before">旧：手写 CSS</div><div class="arrow">→</div><div class="after">新：引擎注入</div></div>
  ```

**节点可带图标前缀**（标识类型：DB / API / 用户 / 队列等）：在 `<span>`/`<div>` 内文本前放 `<svg class="icon">`，`.icon` 自动 1em 对齐、颜色随节点语义（`.core`→靛蓝、`.risk`→红）。
  ```html
  <div class="flow">
    <span><svg class="icon"><use href="#icon-inbox"/></svg> 请求</span>
    <span class="core"><svg class="icon"><use href="#icon-cpu"/></svg> 引擎</span>
    <span><svg class="icon"><use href="#icon-database"/></svg> 存储</span>
  </div>
  ```

## 手画 SVG（部件覆盖不到的拓扑才用）

**模板已预置的 SVG 固定部分（你不再写，写了白费输出 token）**：
- **不写 `xmlns`**——inline SVG 在 HTML 里不需要。
- **不写 `<defs><marker>`**——箭头 marker 已由模板全局提供（`id="cc-arrow"` 灰=结构、`id="cc-arrow-flow"` amber=流，见下「连线语义」），连线只写 `marker-end="url(#cc-arrow)"` 或 `url(#cc-arrow-flow)`。
- **不写默认 `fill`/`stroke`**——`rect`/`circle`/`polygon` 默认浅填充+边框、`line`/`path` 默认灰线、`text` 默认墨色，由 CSS 提供。**强调节点改用语义 class**（见下「节点语义标记」），不写 inline `fill="var(--accent)"`。

参考形态（`<svg viewBox="0 0 W H">…</svg>`，无 xmlns）：

- **状态 / 决策**：菱形 `<polygon>` 或圆 `<circle>` + 箭头连线。
- **状态机**：`<rect rx="8">` 节点按进度着色（`class="done"` 已通过 / 默认 进行中 / `class="risk"` 失败终态）+ `<g class="flow">` 迁移连线（`marker-end="url(#cc-arrow-flow)"`）；分支用多条 `<line>` 从同一节点出发。横向排 `viewBox="0 0 360 80"`、节点宽 90、间距 45 是个稳妥起点，按实际节点数缩放。
- **hub-spoke（中心辐射）**：中心 `<g class="core">` 大节点居中，周围 ≤6 个 `<rect>` 小节点 + 辐射 `<line>`（`marker-end`）。`viewBox` 四边留足 60px 边距防连线/箭头出界；周围节点 >6 个时改用 `.flow` 横排或拆图，避免辐射线交叉成一团。
- **其它非线性的拓扑**（环形、网状依赖等）：用 `<rect rx="8">` + `<text>` + 带箭头 `<line>`/`<path>`（`marker-end="url(#cc-arrow)"`）。

### 节点语义标记（克制，CSS 自动上色）

绝大多数节点**不写 class** = 默认白底灰边。仅给少数关键节点用 `<g class="…">` 包裹加标记（每张图 `core` ≤2 个）：

- `class="core"` 核心组件/服务 → 靛蓝粗边突出
- `class="external"` 外部/第三方依赖 → 灰虚线
- `class="risk"` 风险/告警点 → 红边红字
- `class="done"` 已完成状态 → 绿边（进度语义：`done`=已完成 / 默认灰=未完成·进行中 / `risk`=受阻·风险；与 `core` 正交，一个节点可既 `core` 又 `done`）

写法：`<g class="core"><rect … rx="8"/><text …>名称</text></g>`——rect/text 都**不写 fill/stroke**，CSS 按类上色。不要 inline 颜色，不要给普通节点加 class。（`font-size` 例外，见下文「标签字号按框图大小确定性计算」，允许且鼓励按需写。）

要求：`viewBox` 紧凑贴合内容、文字不溢出矩形、SVG 标签闭合合法。外层用 `<div class="diagram">` 包裹（CSS 已自带 `max-width:100%`，SVG 会自适应）。

**标签字号按框图大小确定性计算**（不要凭感觉，每个 `<text>` 都过一遍）：默认 18（CSS 默认值，不写 `font-size` 即用 18）。先估算文字宽度——`文字宽度 ≈ Σ(每字符系数) × 字号`，字符系数：中文/全角 1.0、大写英文/数字 0.65、小写英文 0.55、标点/空格 0.3。安全条件：`文字宽度 ≤ rect 宽 − 16`（左右各留 8 padding）。默认 18 满足条件就用 18；不满足就缩小字号直到满足，下限 10——用 `<text font-size="N">`，或在节点组上统一设 `<g font-size="N">`。缩到 10 仍溢出时不要卡住任其溢出：加宽 rect、或拆成多行（多个 `<text>`/`<tspan>`）、或缩短文字。输出前逐个标签复算一遍宽度确认不溢出。`font-size` 是允许且鼓励按需写的属性，与 `fill`/`stroke`（不写，CSS 按类上色）不同。

### 节点内图标（标识节点类型，可选）

节点 `<g>` 内可放一个 Lucide 图标标识类型（DB / API / 用户 / 队列 / 缓存 / 外部服务等）。**SVG 坐标空间内不用 `.icon`（其 `1em` 会覆盖 `width` 属性），改用 `.ico`**——不锁尺寸，尺寸由 `<use width/height>` 给定，颜色靠所在 `<g class="core|risk|external">` 的 `color` 自动传递：

```html
<g class="core">
  <rect x="0" y="0" width="120" height="40" rx="8"/>
  <use class="ico" href="#icon-database" x="8" y="11" width="18" height="18"/>
  <text x="34" y="25" font-size="16">Postgres</text>
</g>
```

- 写法：`<use class="ico" href="#icon-<name>" x=".." y=".." width="W" height="H"/>`，放 `<g>` 内、`<rect>` 之后、`<text>` 之前。
- **`width`/`height` 必写**（默认 100% 会撑满整张 SVG），常用 16–20。
- `x`/`y` 是图标左上角；`<text>` 的 `x` 相应右移 = 图标 `x` + 图标宽 + 8（padding）。
- 颜色自动随节点语义（`core`→靛蓝、`risk`→红、`external`→灰），**不写 `stroke=`/`fill=`**。
- 仅当图标增加语义时才加（每节点最多 1 个，单图 ≤6 个，见下文红线）；不逐节点强撒。
- 常用类型图标：DB→`database`、API/服务→`server`/`webhook`、用户→`users`/`user`、队列→`layers`/`workflow`、缓存→`hard-drive`、外部→`cloud`、安全→`shield`/`lock`、告警→`triangle-alert`。

### 连线语义（流 vs 结构）

手画 SVG 连线默认灰（`#999` + `cc-arrow` marker）= 静态结构关系。**数据流 / 调用链 / 状态迁移**用 amber 区分：把连线 wrap 进 `<g class="flow">` 并换 flow 箭头：

```html
<g class="flow"><line x1="96" y1="40" x2="132" y2="40" marker-end="url(#cc-arrow-flow)"/></g>
```

- 静态结构（模块依赖、包含、层级）→ 默认灰线 + `marker-end="url(#cc-arrow)"`
- 数据流 / 调用链 / 状态迁移 → `<g class="flow">` + `marker-end="url(#cc-arrow-flow)"`（amber）
- 流线与节点语义正交：一个 `core` 节点可被 `flow` 连线指向——节点边框靛蓝、连线 amber，各自独立上色。
- 一张图以一种连线为主；另一种仅用于确实需要突出的少数连线，别无规律混用。

---

# 图标（Lucide，可选点缀）

模板预置了**全量 Lucide 图标 sprite**（~1750 个，engine 按需抽取注入）。你**不写 SVG path**，只写引用：

```html
<svg class="icon"><use href="#icon-check"/></svg>
```

- `class="icon"` 已定义：1em 方块、`stroke:currentColor`（颜色随宿主——在 `.key-point.risk` 里变红、在 `strong` 里变 accent、在 `.muted` 里变灰）。
- **不写** `viewBox`/`path`/`fill`/`stroke`——sprite 由 engine 从全量集抽取你引用到的 symbol 注入图标 sprite 槽位，产物只含用到的图标（~3KB）。
- id 用 Lucide 官方名（kebab-case），加 `icon-` 前缀：`#icon-check`、`#icon-arrow-right`。名字写错静默不渲染（不报错，不破坏布局）。

## 图标速查表（按语义分组）

> 仅列高语义常用项；全量 ~1750 个都可用，凭 Lucide 命名直接写 `#icon-<name>`（见下方「多样性」）。

| 语义 | id（去掉 `#icon-` 前缀） |
|---|---|
| 完成/成功 | `check`, `circle-check`, `check-check`, `badge-check`, `circle-check-big` |
| 失败/移除 | `x`, `circle-x`, `trash-2`, `circle-slash`, `ban`, `archive`, `archive-x` |
| 告警 | `triangle-alert`, `circle-alert`, `octagon-alert`, `siren` |
| 决策/目标 | `diamond`, `flag`, `target`, `crosshair`, `goal`, `signpost`, `compass` |
| 约束/安全/鉴权 | `lock`, `shield`, `shield-check`, `key`, `fingerprint`, `scan-face`, `shield-half`, `shield-alert`, `key-round`, `user-check` |
| 信息/提示 | `info`, `lightbulb`, `circle-help` |
| 新增/创建 | `sparkles`, `plus`, `plus-circle`, `rocket`, `square-plus`, `circle-plus`, `folder-plus`, `party-popper` |
| 修改 | `wrench`, `pencil`, `pencil-line`, `eraser`, `brush`, `square-pen` |
| 重构/回滚 | `refresh-cw`, `rotate-cw`, `undo-2`, `git-branch`, `history`, `repeat`, `replace`, `git-fork` |
| 文件/代码 | `file`, `file-code`, `file-plus`, `file-minus`, `folder`, `package`, `terminal`, `code`, `git-merge`, `git-pull-request`, `braces`, `binary`, `square-code`, `file-terminal`, `file-cog`, `file-json`, `regex`, `code-xml`, `file-search` |
| 流向/路径 | `arrow-right`, `arrow-down`, `chevron-right`, `corner-down-right`, `move-right`, `route`, `milestone`, `map`, `map-pin`, `navigation`, `waypoints`, `split` |
| 数据/系统 | `database`, `hard-drive`, `cpu`, `server`, `cloud`, `layers`, `workflow`, `network`, `boxes`, `container`, `cloud-upload`, `component` |
| 时间 | `clock`, `timer`, `calendar`, `hourglass`, `alarm-clock`, `calendar-clock` |
| 清单/搜索 | `list`, `list-tree`, `clipboard-list`, `search`, `scan-search`, `filter`, `scroll-text`, `clipboard-check`, `scan-line` |
| 调研/分析 | `microscope`, `telescope`, `flask-conical`, `chart-scatter`, `git-compare` |
| 设计/方案 | `drafting-compass`, `pencil-ruler`, `ruler`, `pen-tool`, `palette`, `swatch-book`, `frame` |
| 集成/组合 | `puzzle`, `blocks`, `plug`, `plug-zap`, `merge` |
| 通信/通知 | `message-square`, `send`, `share`, `radio`, `bell`, `megaphone` |
| 媒体/内容 | `image`, `file-text`, `book-copy`, `newspaper`, `presentation` |
| 其它/状态 | `eye`, `link`, `download`, `upload`, `book-open`, `bug`, `zap`, `trending-up`, `flame`, `gauge`, `activity`, `trending-down` |

不在表里的图标：凭你对 Lucide 命名的了解直接写 `#icon-<name>`（全量 sprite 都有），名字对即可渲染。

## 用法约束（克制：图标是区域锚点，不是逐条装饰）

- **plan 子型 header `<h1>` 图标必放**：按 plan 主题选 1 个点题图标作全图主锚点——规划/路线→`map`/`route`/`milestone`、方案/设计→`drafting-compass`/`lightbulb`/`pencil-ruler`、修复→`wrench`/`bug`、重构→`refresh-cw`/`git-branch`、调研/分析→`search`/`microscope`、新功能→`sparkles`/`rocket`。冷门主题凭 Lucide 命名自选（全 2007 个都支持）。
- **reply 子型 header `<h1>` 图标可选**：`circle-check`/`check-check` 等，不强求。
- **每个区域 `<h2>` 标题前各放 1 个语义图标**（reply）：做了什么→`list`、改动文件→`folder`/`files`、注意/后续→`triangle-alert`（内容偏待办可换 `clock`/`flag`）。**清单每条 `<li>` 内不加图标**——`▸` bullet 已够，逐条撒图标是噪音。
- **file-list 行内不加**（reply）：已有 `add`/`mod`/`del` 文字徽章表改动类型，行内再放图标是重复。区域 `<h2>` 标题前放 `folder`/`files` 图标。
- **`.key-point` 块若存在则必放 1 个语义图标**：写在首子节点 `<div class="label"><svg class="icon"><use href="#icon-…"/></svg></div>` 内（标签文字由 CSS 自动注入，与图标同处一行）。`risk`→`triangle-alert`、`decision`→`diamond`、`constraint`→`lock`、`conclusion`→`check`、`impact`→`zap`、不修饰→`flag`。key-point 本身 plan ≤2、reply ≤1，无重点时整段省略（不硬造）。
- **区域锚点按需放，每类区域最多 1 个**（不逐条撒即可，无总数硬上限）。plan：header h1 必放 + key-point .label 必放；reply：各 h2 区域标题各 1 个 + key-point .label 必放。图标是区域锚点不是逐条装饰——清单 `<li>` 内不加。
- **多样性**：同一篇里区域锚点图标尽量不重复——三个区域别都放 `check`，能用 `circle-check`/`flag`/`badge-check` 区分就区分；需要更贴切的场景图标时凭 Lucide 命名直接写 `#icon-<name>`（全量 sprite 都支持），不必拘泥速查表。拼不准时优先回退速查表稳妥项，避免拼错静默丢失。
- **图内节点图标单独预算**（与区域锚点独立）：每节点最多 1 个，仅当标识节点类型/状态有语义价值时放；单张图节点图标 ≤6 个。图标是点缀不是装饰：300 字预算优先于图标；不写 path；不发明表外的自造 id（用 Lucide 官方名）。
- **新旧名都支持**：sprite 含全 2007 个图标（主名 + 旧别名）。Lucide 重命名过的图标优先用新名（`triangle-alert` 而非 `alert-triangle`），但旧别名也能渲染。

---

# 红线（两子型共用）

- **只写** `html_path` 指定的文件，不要写别处。
- **只写 body 片段**（`<div class="wrap"> … </div>`）——**绝不**输出 `<!DOCTYPE>`/`<html>`/`<head>`/`<title>`/`<style>`；CSS 由 engine 用固定模板注入，你写完整 HTML 文档会与模板冲突、且白费输出 token。
- **不要**返回 HTML 正文——stdout 只回报一行结果（调用方 prompt 的 Return 段会说明格式）。
- **不要**联网（web search / web reader）——内容全在用户消息里。
- **不要**发明清单外的 class/元素——尤其**不要** `reply-full` 这类多余外层 wrapper（用 `header`+`<h2>` 分组即可），**不要** `<details>`/`<summary>`（产物是静态 PNG 截图，折叠后内容不可见，是假能力；次要细节本就不进 HTML，完整内容在对话里）。
- **不要**用 SVG 手画表格（`<rect>`+`<text>` 排成网格冒充表格）——二维对比用 `<table class="compare">`。
