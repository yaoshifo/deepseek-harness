# Agent Note: 反风格键名的模型入参在输入边界规范化

Status: implemented

[English](2026-08-28-key-style-variant-normalization.md) | 中文

部分取代[风格变体拒绝](2026-08-28-undeclared-key-style-variants.zh.md)中输入路径的决策；该决策对输出校验与直接调用校验器仍然成立。

## Problem

风格变体拒绝落地数小时后,同样的 camelCase 习惯在另一个会话里造成了更糟的失败:收尾追问卡(`ask_user_question`)连续三次参数校验失败,每次报错结果——含 did-you-mean 提示——都完整出现在模型上下文里,而模型仍然逐字节原样重发(会话日志 seq 72508/72785/73089)。第二次尝试的推理甚至明确写出了正确修法("The tool schema uses `multi_select` (snake_case). I wrote `multiSelect`. Retry with correct property name."),但第三次调用一字未改;第三次失败后模型构建了一个错误理论(harness 序列化出错)并彻底放弃发卡,用户一张卡都没收到。repeat-tool-reminder guard 在 ×3 时提示,模型以放弃收场。两个政策如今构成了困境的两端:静默接受(早间事故——卡片渲染成单选)损坏语义,大声拒绝(本次事故——卡片发不出)丢失特性,而两者都依赖「模型读到提示并修改自己已发射的 JSON」,这一点 harness 无法依赖。

## Decision

以相反键名风格指称已声明属性的未声明键(`multiSelect` 对 `multi_select`,双向忽略下划线与大小写)会在**校验前被规范化为声明键名**:

- `normalizeKeyStyleVariants(schema, value)`(dsh-tools `json-schema.ts`)沿 `properties`/`items` 递归改写这类键,无改名时返回原引用,两种拼写并存时声明键胜出,对任意输入 total(非节点 schema、恶意 getter、环 → 原样返回)。`oneOf` 内部不规范化——那里的分支匹配并非仅按键名——联合内部的变体键仍然拒绝。
- 注册表在 `createExecution` 的无损快照与深冻结之间应用它,因此所有工具类型——defineTool、raw、MCP——都看到模型本意的键,pre-execute 政策(权限、审批)看到规范化后的形态。`tool/call` 事件仍记录原始参数供审计。
- `defineTool` 的 validate/execute/present/isConcurrencySafe 闭包同样先规范化(展示在注册表之外消费原始回放参数),`execute` 接收规范化后的值。
- 子代理结构化结果捕获在校验前规范化,父级拿到声明键名。
- feishu-bridge 的容错原始参数读取(后台嗅探、skill 输入解析、monitor triage 裁决)用字面量 mini-schema 规范化;chatroom picks 解析器对其内嵌 pick 数组做同样处理。

其余一切不变:非变体未知键维持接受/拒绝划分,封闭 `ask_user_question` item 的幻觉字段仍被拒,工具**输出**校验仍报告变体键(输出侧变体是代码 bug 而非模型输出),缺失必填仍大声拒绝——探针表明该类无法修复。

## Forward positioning: constrained decoding

探针(mify 转发、官方 Anthropic 兼容端点、coding 套餐 OpenAI 端点)显示 GLM 接受 `strict: true` 与 `response_format: json_schema` 但不施加约束:要求省略必填字段的提示在所有端点、开关两种状态下都成功。按部署裁定,harness 侧能力通路仍然接好——GLM 供应商启用 pi-ai compat `supportsStrictTools`/`supportsStrictMode`,dsh 给封闭根工具打 `constrainedSampling: {type: "json_schema", strict: "prefer"}` 标——上游哪天强制执行,strict 无需再改即可生效。`prefer` 语义在此期间保持请求合法,规范化则对一切无约束供应商充当不依赖模型的防线。开放根工具不打标:强制型引擎要求封闭 schema,扩大覆盖是根开放性决策,不是一个开关。

## Alternatives considered

**把 `multi_select` 改名为 `multiSelect`。** 否决:snake_case 是本仓库工具参数的主流风格,改名是把一个键挪进 6 个键的少数派;且模型的先验按词位分布,逐键迎合无法泛化。规范化让声明哪种风格与调用成功无关,是这个思路的一般形式。

**全仓统一工具参数键名风格。** 否决:迁移要动所有模型可见 schema 与快照,而历史撞车只发生在这一个键、6 个 camel 键从未撞过——没有证据表明这轮翻腾能买到什么。

**保留大声拒绝并加强提示。** 基于证据否决:提示三次指名正确键,模型两次原样重发;更强的提示仍然把成败押在模型服从上。

**用提示词强调 snake_case。** 否决:对抗提示探针显示 schema 以 5/5 压制提示压力——发射失败是长上下文习惯,不是理解问题。

**只开 strict 开关、不做规范化。** 否决:探针证明上游今天忽略 `strict`,光开开关是死配置;开关仍按前向布局打开,规范化才是与模型无关的一层。

## Consequences

- 变体键调用第一次尝试即成功:零往返、零模型依赖;本类的失败模式(三次拒绝、guard 提示、特性放弃)被关闭。
- 原始参数仍在 `tool/call` 事件中,审计与回放不变;规范化可从日志重建。
- 合法接受任意键的对象不受影响:没有声明属性就没有可改写的变体。开放透传(`tool-workflow`)语义不变。
- 规范化对合法参数幂等且保持原引用——未来只发声明键的约束模型走快路径,两层相辅相成而非冲突。
- 纯校验器中的 did-you-mean 分支保留(输出校验与直接调用方仍用),但模型输入路径不再触达。

## Testing

`packages/core/tools/tests/json-schema.spec.ts` 覆盖 walker:经数组项的递归改名、双写时声明键优先、开放对象规范化、同引用快路径、联合/非纯值/垃圾 schema/环/恶意 getter 的 total 性,以及双向碰撞的既有校验违规。`packages/core/tools/tests/tools.spec.ts` 证明 registry 边界(defineTool 与 raw 工具:工具体拿到规范化参数、pre-execute 看到规范化参数、开放透传不受影响)。`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` 证明端到端 camelCase 调用现在会发出多选提问。`packages/subagent/subagent-in-process-driver/tests/structured.spec.ts` 覆盖捕获路径,`packages/llm/llm-pi-ai/tests/context.spec.ts` 覆盖 strict 打标,feishu-bridge 各 spec 覆盖嗅探位点。
