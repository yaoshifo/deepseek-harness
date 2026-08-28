# Agent Note: 以相反键名风格指称已声明属性的未声明键必须 fail loud

Status: implemented

[English](2026-08-28-undeclared-key-style-variants.md) | 中文

## Problem

一张飞书收尾追问卡渲染成了单选，而 agent 请求的是多选。会话日志显示模型调用 `ask_user_question` 时传了 `"multiSelect": true`——camelCase，而工具 schema 声明的是 `multi_select`。两层机制让这个错误静默通过：question item 的 `additionalProperties: true` 使校验器完全跳过未知键；工具的 `execute` 只挑拣声明键，拼错的值在 bridge 兜底 `multiSelect` 为 false 之前就蒸发了。对该会话 282 次工具调用与全部 34 个暴露 schema 的全量比对发现，撞车的只有这一个键：camelCase 先验是词位特异的（OpenAI 风格 function calling 加上上下文里的 `multiSelect` 类型名），不是对仓库以 snake_case 为主的工具参数风格的误读（34 个 snake 键对 6 个 camel 键，其余键全部写对）。

## Decision

`validateJsonSchemaValue` 的 object 节点会把每个未声明键与声明属性名做忽略下划线与大小写的比较：归一形式与某个声明属性相同的键（`multiSelect` 对 `multi_select`，双向），无论对象开放还是封闭，都判为违规并附带指名正确键的提示。非变体的未知键维持既有语义——开放对象接受（workflow `args` 的透传保持合法），封闭对象拒绝。`ask_user_question` 的 question 与 option item 额外声明 `additionalProperties: false`，幻觉字段同样被拒。

## Alternatives considered

**把 `multi_select` 改名为 `multiSelect`。** 否决：snake_case 是本仓库工具参数的主流风格，改名是把一个键挪进 6 个键的少数派；且模型的先验按词位分布，逐键迎合无法泛化。

**全仓统一工具参数键名风格。** 否决：迁移要动所有模型可见 schema 与快照，而历史撞车只发生在这一个键、6 个 camel 键从未撞过——没有证据表明这轮翻腾能买到什么。

**在 `execute` 里宽容接受变体键（双读）。** 否决：掩盖模型的错误，把未修正的调用留在转录里，并让回放依赖隐式键映射。

**用提示词强调 snake_case。** 否决：一条指名正确键的 violation 是比文字建议更强、可回放的信号。

## Consequences

- 拼错键名的代价现在是模型一次自我修正往返——与事故会话中缺必填属性时已经生效的失败路径相同（模型收到 `INVALID_ARGS` 结果后立刻补上了缺失的 `id`）。
- 合法接受任意键的对象不受影响：没有声明属性就没有可碰撞的目标。
- `tool-workflow` 保留三处开放 schema；`meta`/`phases` 的风格变体现在在工具层以 did-you-mean 失败，取代引擎层的 `META_INVALID`——同样的错误结果路径，更早且更具体。
- did-you-mean 文本是模型可见面：`subagent-child-question-rejection` 的工具 schema 快照记录了封闭后的 `ask_user_question` schema。

## Testing

`packages/core/tools/tests/json-schema.spec.ts` 的校验器用例覆盖开放与封闭对象上的双向碰撞以及非变体未知键的分流；`packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts` 证明端到端的 camelCase 调用返回带提示的 `INVALID_ARGS` 且绝不触达 provider。
