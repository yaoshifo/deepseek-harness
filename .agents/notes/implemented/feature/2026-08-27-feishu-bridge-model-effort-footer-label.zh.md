# Agent Note: Feishu bridge status-footer model·effort label

Status: implemented

[English](2026-08-27-feishu-bridge-model-effort-footer-label.md) | 中文

## 问题

完成通知卡的 🤖 行只显示模型名与权限模式标签，同一 bot 的不同推理档位在卡片上完全无法区分，读卡的人看不出活跃路由声明的是哪一档。bridge 配置当时也表达不出部署的真实档位：`agent.reasoningEffort` 拒绝 `'max'`，而部署里的 glm 网关思考档位是 low/high/max（catalog 没有 medium 映射）。

## 决策

两个页脚构造器共用同一个 `formatModelLine` 渲染 🤖 行：`🤖 <模型>·<effort>[ · <模式>]`。effort 以紧连形式接在模型后——对齐钉死的产品示例 `zhipuai/glm-5.3-flash·max`——既有的间隔式模式段原样追加在其后。effort 文本来自 dsh adapter 既有的 `getReasoningEffort()` 探针，即活跃 provider 路由的配置值（Go GetReasoningEffort 对齐）。没有该能力、或配置值为空的 agent 逐字节保持原样。

显示源选路由配置而非 llm 运行时的生效默认值：路由行才是运营者声明「agent 跑在哪一档」的地方，与 `getModel()` 读的是同一个显式声明面，因此标签不需要给 bridge 引入新的核心服务依赖。要保持真实需人工维护一条一致性规则：`agent.reasoningEffort` 必须等于同一网关 pi-ai provider 层 `reasoning:` 默认值（现网配置两处均为 max）。

Config：类型与 Schema union 的 `agent.reasoningEffort` 增补 `'max'`；其余拼写错误仍在加载期 fail-loud。

## 备选方案

**从 llm 运行时探测生效档位（按模型的 `defaultEffort`）。** 否决：bridge 目前只消费结构化的 `ctx.agents`/`ctx.on` 切片；读模型 catalog 意味着新增服务依赖、页脚路径里加异步解析与缓存，且与 provider 默认值失同步时会静默漂移而非响亮报错。这也会绕过回复页脚已对齐的运营者声明面。

**整行改用间隔分隔符（` · max`）。** 否决：需求方钉死了紧连形态 `glm-5.3-flash·max`；重排模式段的间隔会扰动超出本次需求的卡片输出。

**路由未配置 effort 时什么都不显示，完全依赖网关默认值。** 空档位行为照此交付，但仅作为兜底——若只走 provider 默认这一条路，请求方所在部署（尚无路由级 effort）将看不到任何效果。

## 后果

共用状态页脚的所有卡片（完成通知卡、/new 卡、spawn 通知卡）都在模型旁标出声明档位。未声明 effort 的 bot 视觉零变化，这对无思考控制的网关是正确表现。包内 vitest 用例钉住三条渲染分支——紧连 effort、空 effort 回归、模式排序——以及带 effort 的折叠面板标题。允许档位的词表仍由 [adapter-owned reasoning effort capabilities](../../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) 所属的 llm adapter 掌握；本决策只选择 bridge 显示什么。
