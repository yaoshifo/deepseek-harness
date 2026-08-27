# Agent Note: plan/reply 渲染图解的拓扑路由 CSS 部件

Status: implemented

[English](2026-08-27-feishu-bridge-render-topology-parts.md) | 中文

## Problem

plan/reply HTML 渲染卡的图解已经塌缩成视觉上扁平的条带：2026-07-16 可靠性收敛（CC-connect 时代）之后，渲染 skill 把所有常见拓扑都导向仅有的三个 CSS 部件——`.flow`/`.layers`/`.diff`，各自只是一行文字芯片加 CSS 箭头——并在其它场合劝退手画 SVG。在 `~/.claude/plans/` 留存的 2026 年 8 月 270 份渲染产物里，206 份是这三种条带，50 份干脆没有图；用户判定插图「太过于简单」。中间复杂度（分支流、中心辐射、阶段推进）没有任何可达路径：CSS 部件太简、手画 SVG 被劝退，而 skill 里「复杂图调 draw skill」的指引是死的——渲染 fork 禁用了 `skill` 工具（464 份历史渲染中 0 份用过 kroki/mermaid）。

## Decision

把确定性部件词汇从 3 种扩到 13 种拓扑，落在 `diagramCSS`（`packages/acp/feishu-bridge/src/engine/plan-render-templates.ts`）加 `skills/feishu-bridge-render/SKILL.md` 里的拓扑路由表——每条拓扑映射到一个部件并带节点数上限：`.flow`（含 `data-if` 条件标签）、`.flow-v`（竖向主干 + 扇出分支）、`.hub`（中心 + 卫星）、`.stages`、`.stages-v`、`.timeline`、`.lanes`、`.tree`、`.cycle`、`.kanban`，加上既有的 `.layers`/`.diff`。模型仍然只填语义文本，排版与连线全部由 CSS 完成。手画 SVG 收窄为真图状拓扑（网状、多角色时序、ER）的专用门，skill 里的 draw skill 死引用全部删除。

**部件设计红线：** 连线必须是结构化元素——`.flow-v` 的显式 `<b></b>` 箭头、`.hub` 的真实 `<i class="stem">` 竖线加卫星容器的 `border-top` 总线、`.stages` 的相邻圆点两两线段——绝不使用靠猜坐标的负 margin 绝对定位伪元素拼线。组装正确性用浏览器几何断言验证（Playwright `getBoundingClientRect`：stem 两端与总线和中心严丝合缝、总线覆盖每根刻度线、箭头居中且紧贴上下节点、层级树每层缩进精确到像素、无横向溢出），而不是视觉模型——本轮曾有一份视觉模型自查对断裂连线误报通过，用户一眼就看出了问题。手画门这边，`fitSVGTextSizes`（挂在 `assembleHTML` 的 `ensureSVGViewBox` 之后）在引擎侧复算 skill 的字符系数标签公式，把仍溢出的节点标签缩到能放下的最大字号（下限 10）——提示词公式是纪律，引擎兜底是保证。

## Alternatives considered

- **放开 skill 鼓励手画 SVG。** 否决：那是把 7 月的循环（表现力 → 溢出/重叠 → 收紧）再走一遍。引擎级字号兜底其实从未存在过——优化 1–4 计划里的「Go 侧自动缩字号」同样从未落成代码，真正落地的只有 `ensureSVGViewBox`/`sanitizeSVGVars` 和提示词公式——而 2026-07-16 的收敛恰在公式落地的同一天拍板，说明仅靠提示词纪律救不回手画。低 effort 渲染模型执行提示词里的字号公式，正是当初的失败模式；现在的设计是手画门收窄 + 引擎侧 `fitSVGTextSizes` 兜底，而不是放宽手画。
- **复杂拓扑走 diagram-render（kroki.io/mermaid.ink）。** 否决：这会给渲染路径引入网络依赖，而它已经出过一次 kroki 过载事故；渲染会话也缺少把渲染产物 SVG 拼进片段的机制。渲染管线按设计保持零网络依赖。
- **调高渲染会话的 reasoning effort。** 用户否决：effort `low` 是刻意的速度取舍。

## Consequences

图解表达力现在来自部件词汇而不是放松坐标纪律，可靠性与表达力不再是取舍关系。markup 契约多了结构化元素（`.flow-v` 内容元素之间的 `<b></b>`、`.hub` 的三段结构）；SKILL.md 示例把它们钉死，漏写时优雅降级（节点照常渲染、连线消失）而不是破坏版面。对真正图状拓扑，表达力天花板仍低于真 SVG——这是有意割舍；本地布局引擎属于另一个独立提案。节点数上限逐部件由路由表文字约束，超限即改走相邻形态或手画门。

## Testing

`tests/engine/plan-render.spec.ts` 断言 11 个新部件选择器与 token 经共享 `{{DIAGRAM_CSS}}` 槽位进入两个模板，并覆盖 `fitSVGTextSizes`（默认/显式/组继承字号、tspan 多行、下限 10、无框标签跳过、assembleHTML 接线）——98 个测试全绿。一次性 Playwright 几何脚本（45 项检查）在用真实 plan 模板与 Lucide sprite 组装的全部件页面上验证了落库的 `diagramCSS` 字符串本体；demo PNG 已发用户目验。该页面同时是未来新增部件的参照：任何新连线必须先过几何断言再落库。
