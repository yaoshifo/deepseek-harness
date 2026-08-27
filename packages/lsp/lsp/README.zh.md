# @deepseek-ai/dsh-lsp

[English](README.md) | 中文

**LSP 能力 seam**：抽象 `LspService`（`ctx.lsp`）定义 harness 具备哪些语义代码导航能力（转到定义、查找引用、查找实现、悬停、按名查找工作区符号），并通过语言服务器提供方实现，不把模型约定绑定到本地子进程。

本包承担 LSP 能力的 Service Definition 角色：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-lsp`（本包） | Service Definition：服务、以品牌化 id + 扩展名映射为 key 的提供方注册表、逐查询选择、请求／结果词汇、`LspError` 分类体系 |
| `@deepseek-ai/dsh-lsp-stdio` | Service Provider：通用本地后端，注册已配置的 stdio 语言服务器提供方 |
| `@deepseek-ai/dsh-tool-lsp` | Consumer：面向模型的 `lsp` 工具，基于 `ctx.lsp` |

该 seam 恰好公开四种语义位置操作：`goToDefinition`、`findReferences`、`goToImplementation`、`hover`，外加按名的 `symbol` 扇出查找，且没有通用 JSON-RPC 逃生口，因此任何协议载荷或未经评审的命令／修改都无法通过 `ctx.lsp` 到达提供方。

## 服务 API（`ctx.lsp`）

| 成员 | 语义 |
|---|---|
| `registerProvider(provider)` | 注册后端，以原子方式保留其品牌化 `id` 与每个规范化文件扩展名。任何无效输入或冲突都不会发布内容，并抛出 `LspError`（`LSP_INVALID_PROVIDER`／`LSP_CONFLICT`）。返回释放所有保留项的 disposer。随调用 fiber 释放。 |
| `query(request, signal?)` | 按文件最终扩展名选择提供方，从该提供方的映射派生 `languageId`，并运行一次查询。没有匹配项时抛出 `LspError` `LSP_UNAVAILABLE`。 |
| `symbol(request, signal?)` | 把一次按名符号查找按注册顺序扇出到所有已注册提供方（符号查询没有可路由的文件扩展名），并合并各组结果。server 缺少 `workspaceSymbolProvider` 能力的提供方不做贡献；所有提供方都缺少该能力时抛出 `LspError` `LSP_UNSUPPORTED_OPERATION`，没有已注册提供方时抛出 `LSP_UNAVAILABLE`。可选的 `seedFilePath` 为只在项目加载后索引符号的服务器临时打开一个项目文件。 |

选择逐查询进行且与顺序无关：一个提供方独占一组扩展名，因此注册和 HMR（热模块替换）顺序绝不会改变路由。扩展名 key 规范化为小写且以点开头；`languageId` 只用于同步临时文档，绝不参与选择。第一版没有 glob、language-id 或显式路由 selector。

提供方注册的是**能力**而非工具。`dsh-tool-lsp` 是面向模型的名称、描述、提示词指引、schema 和呈现的唯一 owner。

## 词汇

`LspQueryRequest`（`operation`、`filePath`、`position`、`workspaceRoot`）：每个字段都必填，因此没有字段需要实现默认值，也不存在 `resolve()` 步骤。位置与范围使用从零开始的 UTF-16，与协议一致；工具拥有从 1 开始的光标约定。`findReferences` 始终包含声明，提供方在内部强制执行，因此调用方没有 flag。`LspQueryResult` 是封闭的判别联合：导航使用 `{ kind: 'locations'; locations; resolvedWorkspaceUri }`，悬停使用 `{ kind: 'hover'; hover }`（内容或 `null`）；消费方通过 `switch` 实现穷尽检查，因此新增分支会使编译失败，直到完成处理。`resolvedWorkspaceUri` 是提供方的规范工作区 `file:` URI；调用方相对化位置 URI 时以它为基准，而不是对可能含符号链接的请求根应用宿主平台路径规则。

`LspSymbolRequest`（`query`、`workspaceRoot`、可选 `seedFilePath`）命名该 seam 的符号查找：没有文件、没有位置，匹配语义属于 server。每个提供方回答一个 `LspSymbolResult`（按其 server 的相关性顺序排列的 `symbols`，加上各自的 `resolvedWorkspaceUri`）；未解析的 `WorkspaceSymbol` 以 `location: null` 保留条目。`seedFilePath` 指定一个临时打开的项目文件，供符号索引依赖已加载项目（tsserver）的服务器使用。完整约定见 `src/types.ts`；`src/index.ts` 给出 `LspError` code，包括 `LSP_DISPOSED` 和 `LSP_MALFORMED_RESPONSE`。

## 模型体验

通过 `dsh-tool-lsp` 间接影响；该工具拥有面向模型的 `lsp` schema、提示词与渲染结果，本注册表自身不贡献提示词或 schema。

#### KV Cache 影响

不会直接失效；请求前缀变更由 `dsh-tool-lsp` 负责。

## 已知限制与暂缓事项

- **同一运行时内扩展名归属互斥**：两个提供方不能同时声明 `.ts`，即使 language id 不同；重叠会使注册失败。预期扩展是在注册之上增加部署配置的 selector；它可以放宽互斥保留，而无需把提供方选择加入模型输入（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.zh.md)）。
- **四种位置操作加按名符号查找**：call hierarchy 与 `documentSymbol` 暂缓（它们需要不同 schema）；diagnostics 需要独立的新鲜度／累积规则；修改操作（rename、code action、formatting）需要独立工具，并集成预览、权限和写入策略。
- **对上游 seam 的 fork 扩展**：上游把该 seam 封闭在四种操作；`symbol()` 是 fork 本地新增，等待上游出现等价能力（若出现则做语义合并）。
- **没有观测表层**：可用性只能通过运行 `query()` 并按抛出的 `LspError` code 路由来观测；没有提供方变更事件或能力状态查询。
