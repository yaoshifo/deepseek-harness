---
description: "面向部署方与维护者的目录级 MCP 发现：工作目录位于配置根目录内的会话，把该目录下 Claude Code 兼容的 .mcp.json 服务器挂载进自己的 agent scope。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-workspace

[English](README.md) | 中文

<a id="summary"></a>
## 概述

`dsh-mcp-workspace` 为 harness 提供与 Claude Code 等价的目录级 MCP 隔离：工作目录下存在 Claude Code 兼容 `.mcp.json` 的会话，会把其中声明的 MCP 服务器挂载为仅该会话 agent scope 可见的工具，命名沿用 mcp-client 的 `mcp__<serverName>__<tool>`。其他目录的会话看不到该文件里的任何工具，无需为各项目配置白名单。发现只信任显式 `roots` 绝对目录清单——roots 之外一律不挂载——且默认不启用。主要代价：roots 内每个会话各建一条连接（stdio 服务器即各起一个子进程），以及会话创建期受 `startupTimeoutMs` 限制的等待。

## 目录

- [概述](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## Use this package

插件是 Host 服务（`ctx.mcpWorkspace`）。在 `cordis.yml` 中加载并列出允许挂载各自 `.mcp.json` 的目录：

```yaml
- id: mcp-workspace
  name: '@deepseek-ai/dsh-mcp-workspace'
  config:
    roots:
      - /home/hm/workspace/dida
      - /home/hm/workspace/riskai
    startupTimeoutMs: 10000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | `[]` | 绝对目录路径；会话 cwd 等于或位于某个 root 之下时挂载其 `.mcp.json`，其余 cwd 不挂载并记 error 日志 |
| `startupTimeoutMs` | `10,000` | 会话 setup 期间单个服务器初始连接 + 工具发现的上限；超时服务器的工具晚到 |

消费者在会话创建时组合挂载：feishu-bridge adapter（fresh/fork/resume 三路径，位于项目 `mcpServers` 遮罩之外）、API session controller 的 `composeAgent`、以及 subagent 子任务工厂（子任务按自身 cwd 挂载）。`/mcp` 通过 `mountedFor(cwd)` 列出当前会话的目录挂载。profile 未加载该插件的消费方跳过该特性并每进程 warn 一次。

受信目录中的 `.mcp.json` 遵循 Claude Code 项目格式。解析按 Claude Code 文档的语义映射；误配条目跳过并记录问题，不影响会话：

| 条目 | 映射 |
|---|---|
| 无 `type` 或 `type: "stdio"` 且有 `command` | stdio 传输；子进程在 `.mcp.json` 所在目录运行 |
| `type: "http"`（别名 `type: "streamable-http"`）且有 `url` | streamable-http 传输 |
| 有 `url` 无 `type` | 配置错误：跳过（Claude Code 对同样误配也是报错跳过） |
| `type: "sse"` | 跳过：本客户端无 SSE 传输 |
| `command` 与 `url` 并存、`type: "ws"`、未知 type | 跳过 |
| 未知字段（如 Claude Code 的 `alwaysLoad`） | 忽略 |

`${VAR}` 与 `${VAR:-default}` 引用在 `command`、`args`、`env` 值、`url`、`headers` 值中按 daemon 进程环境展开；缺失且无默认值的引用保留 `${VAR}` 字面文本并告警，与 Claude Code 行为一致。单文件内重复的 server 名导致整个文件失败（全部跳过）。server 名须匹配 `[A-Za-z0-9_-]{1,32}`。

## Understand the implementation

服务是继承 Cordis `Service` 的类插件，注册为 `ctx.mcpWorkspace`。`wrap(setup)` 把挂载组合到创建期 `AgentSetup` 上：内层 setup 先执行（其 publication commit 透传），随后每个映射出的服务器通过 `agentCtx.plugin(mcp-client, config)` 挂载进未发布 agent 的 scope，工具随 agent 销毁而消失，绝不进入进程级全局工具视图。会话 cwd 在 setup 内部从 `agentCtx.agent.session.header.cwd` 解析，因此 fresh/fork/resume 三条路径都按会话自身记录的 cwd 挂载，调用方无需传递。`mountedFor(cwd)` 为 `/mcp` 重读同一文件。原始文本中的重复 server 名由扫描器检测（JSON.parse 会静默保留最后一个重复项），每次挂载记录文件的 mtime 与内容摘要，审计线索可回答哪个文件版本把哪些服务器放进了哪个会话。

### Source map

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：`Config`（roots/startupTimeoutMs）、`wrap`/`mount`、`mountedFor`、roots 信任判定、取证日志 |
| [`src/parse.ts`](src/parse.ts) | Claude Code 兼容 `.mcp.json` 解析：映射、跳过、重复检测、`${VAR}` 展开 |
| [`src/types.ts`](src/types.ts) | 仅类型 |
| [`src/invariant.ts`](src/invariant.ts) | 包 invariant 伴随件（无运行时 invariant；可观测状态归工具注册表所有） |

## Model Experience

### 目录挂载的 MCP 工具

#### What the model sees

cwd 位于配置根目录内的会话看到 `.mcp.json` 服务器的工具以 `mcp__<serverName>__<rawName>` 命名注册为原生工具，携带服务器提供的描述与输入 schema，与全局 mcp-client 行完全一致。其他目录的会话与进程级全局工具视图永远看不到它们。目录挂载在会话内遮蔽同名全局行。

#### Token effect

目录工具定义进入 roots 内会话的每个请求；其他会话不付出任何 token。`startupTimeoutMs` 超时后的晚到注册从会话的下一个请求起加入定义。

#### KV Cache effect

目录工具定义前缀在挂载集合不变时保持稳定。`.mcp.json` 的改动只影响之后创建的会话，既有会话保持可复用前缀；晚到注册的服务器会替换定义，可能从第一个变化 schema token 起使复用失效。

## Known Limitations and Deferred Work

- **MCP 子进程绕过 dsh 沙箱 policy** — `.mcp.json` 声明的 stdio 服务器由 daemon 经 MCP SDK 直接 spawn，不经过会话的文件沙箱 policy；roots 内可被沙箱 agent 写入的 `.mcp.json` 对该目录后续每个会话都是可执行代码。`roots` 必须保持收窄；交互式逐服务器审批（对齐 Claude Code 的项目服务器审批）推迟。
- **无连接共享** — roots 内每个会话各建一条连接；stdio 服务器即每会话一个子进程，同目录并行子任务按任务数放大。mcp-client 传输层共享池推迟。
- **不向上遍历、不监听文件** — 只读会话 cwd 的 `.mcp.json`，改动只影响之后创建的会话。
- **不支持 `type: "sse"`** — 条目跳过并记录问题；为 mcp-client 增加 SSE 传输推迟。
- **stdio 相对 command 经 daemon PATH 解析** — 与强制绝对路径的 ACP 路径不同；被植入的 `.mcp.json` 可指名 PATH 上的任意程序。
- **同名全局服务器被遮蔽且无告警** — 会话内 scoped 注册获胜，全局实例继续服务其他会话；mcp-client 的名字保留按 scope 分键，本服务看不到全局名单。
- **录制 keyless 会话快照需要 API key** — composition 测试已钉住模型可见的工具名集合与一次真实工具调用；会话驱动快照待有 key 时补录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
