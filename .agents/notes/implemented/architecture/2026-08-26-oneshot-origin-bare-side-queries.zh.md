# Agent Note: The oneshot session origin keeps side queries bare

Status: implemented

[English](2026-08-26-oneshot-origin-bare-side-queries.md) | 中文

## Problem

feishu-bridge 的旁路查询——群名生成（Go LightweightQuery）、predict-next、turn summary、monitor triage，以及 plan/reply 渲染 fork——都是全新的一次性 dsh 会话，全部任务上下文只经 prompt 传递。但会话组装仍会把所有按 cwd 派生的环境块注入进来：workspace 指令 baseline（agent-instructions）、项目记忆索引（claude-memory，按 adapter cwd——即项目主 workdir，绝不是 `/spawn -d` 的覆盖目录——取 slug）、`<available_skills>` 清单、完整的基础 system prompt，甚至给这个用完即弃的会话发一次 LLM 标题请求。线上实测一次群名生成：16445 input token 换 14 个 output token。比浪费更糟的是正确性：一个 `/spawn -d books` 建的群被改名「拉取RiskAI最新代码」——命名 fork 在 riskai 项目主目录组装，注入的 riskai 记忆索引把首条消息里的「这个项目」消解成了 RiskAI，而任务会话本身一直在 books 里正确运行、拉的就是 books 的代码。

## Decision

- dsh-session 与 dsh-agent 把粗粒度 `SessionHeader.origin` 联合类型扩出 `oneshot`（header 校验接受它；可选字段加值，不做格式版本提升）。该 origin 标记短生命周期、自含上下文的旁路查询会话。
- 上下文注入策略按 origin 路由：claude-memory 对一切携带 origin 的会话跳过索引注入（此前仅 subagent——索引注入从此只面向普通会话）；session-title 对 oneshot 会话跳过自动 LLM 标题生成（本地 fallback 标题保留——它不发模型请求）。
- feishu-bridge adapter 以 `origin: 'oneshot'` 创建 lightweightQuery 与 renderQuery 会话。lightweightQuery 完全 bare：一行式 complete system prompt 整体替换组装基线（buildCompletePromptSetup 保持渲染 note 所有的「整体替换 prompt ⟺ 指令通道静默」不变量），`tools.restrict({ allow: [] })` 屏蔽全部工具——skill 清单随工具一同消失，按项目的 MCP mask 折叠进这条唯一的 deny-all 限制而不再叠加第二条。renderQuery 只 deny 全局 `skill` 工具（渲染 skill 正文已烤进它的 system prompt；`write` 等工作工具保留），MCP mask 作为独立限制保留。

## Alternatives considered

- **为 memory 与 title 各加 suppress 缝**（镜像 `agentInstructions.suppress()` 的新服务）。否决：要开两条新缝并把 function plugin 重构成 service，而既有的 origin 字段在创建时刻就能精确路由这套策略。
- **把 spawn 的 workdir 传进命名 fork。** 否决：查询 bare 化后上下文只剩 prompt——没有记忆可供「这个项目」误消解，workdir 传递买不到任何东西。
- **复用 origin `subagent` 标记一次性会话。** 否决：它错误描述了会话性质（没有父级委派），并把 title/memory 策略耦合到委派语义上。

## Consequences

- 群名、predict-next、turn-summary、monitor-triage 与渲染请求收缩为 prompt 加极小 system prompt；一次命名请求从 ~16.4k input token 降到 ~1k，群名不再继承项目主目录上下文（`/spawn -d books` 的群得到基于内容的名字）。
- 凡携带 origin 的会话一律不注入记忆索引——未来的 origin 取值按构造继承该策略；普通交互会话不受影响，所有既有的 `origin === 'subagent'` 读取点（subagent lineage、client runtime、UI）都是精确匹配——旧日志回放不受影响。
- 天花板：未来某个需要工具或 cwd 上下文的轻量查询调用方不能直接套 bare——它需要自己的 toolFilter，或改走 forkQuery 式带父级 seed 的会话。

## Testing

`tests/agent-dsh/adapter-oneshot.spec.ts` 钉住 bare 轻量查询的组装（origin、逐字的单行 complete section、指令抑制、`allow: []`）与渲染 skill deny 及其未注册回退；`tests/agent-dsh/adapter-mcp-mask.spec.ts` 钉住折叠后的 deny-all mask 与渲染 fork 两条并存的限制；dsh-session、claude-memory、session-title 包测试钉住 origin 校验与两处注入门控。

## Related

[渲染 fork 屏蔽 workspace 指令注入](2026-08-26-render-fork-suppresses-instructions.zh.md) 持有本 note 所依托的「整体替换 prompt」不变量。
