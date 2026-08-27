# Agent Note: LSP workspaceSymbol name-based entry point

Status: implemented

[English](2026-08-27-lsp-workspace-symbol-entry-point.md) | 中文

## Problem

`lsp` 工具上线时只有四种操作（`goToDefinition`／`findReferences`／`goToImplementation`／`hover`），全部要求 `file_path` 加上落在符号上的一基 UTF-16 `line`／`character`。因此模型无法用一次调用回答它最高频的导航意图——"符号 X 在哪？"——必须先读文件、数列号，且位置一旦偏出符号就返回空。

对 1,801 个会话（约 37,000 次工具调用）的会话日志分析量化了后果：`lsp` 共被调用 14 次（0.04%），且全部来自该功能自身的开发或冒烟会话；挂载后 700+ 会话的有机采用为零，同期 grep 以符号式搜索被调用 731 次。提示词引导当时已经存在（工具区段与 grep 的交叉引用提示），工具本身也工作正常——所以障碍是结构性的：问题在输入契约，不在可发现性或故障。

决策时点的上游状态：`packages/lsp/` 与 upstream master 完全一致；上游自 2026-08-21 起静默、无 open PR、issue 区关闭，其文档明确把符号查询排除在四操作契约之外。等待上游等价能力没有时间表。

## Decision

`lsp` 工具暴露第五个按名操作：`workspaceSymbol` 接受非空 `query`，不需要任何坐标。工具描述与提示词引导以它开头，并教会工作流链条——`workspaceSymbol` 返回的 `path:line:character` 可原样传给位置操作。

seam 增加独立的 `LspService.symbol()` 方法而非第五个 `LspOperation`：符号查找的请求 schema 不同（无文件、无位置），也没有可路由的扩展名，因此服务端把请求按注册顺序扇出到所有已注册提供方并合并各组结果。server 缺少 `workspaceSymbolProvider` 能力的提供方不做贡献；所有提供方都缺少时调用以 `LSP_UNSUPPORTED_OPERATION` 失败；其余错误正常传播。grep 工具描述的交叉引用现在点名入口（"prefer the lsp tool (workspaceSymbol for a symbol name)"）。

真机 e2e 地板在发布前抓住了一个会阻断部署的怪癖：tsserver 的 `navto` 在文档打开前回答 `No Project`，最后一个文档关闭时卸载项目，因此在瞬态打开宿主下，裸符号查询在那里必然失败。为此请求携带可选的 `seedFilePath`：提供方读取该文件、按自己的映射派生 language id，实例在 `workspace/symbol` 期间临时打开它并记住供后续无种查询复用；没有种子时，实例重开上一次打开过的文档。工具把种子暴露为 `workspaceSymbol` 上被推荐的 `file_path`（冒烟实测显示冷首查会把模型推回 grep，因此描述改为开篇推荐）。

跨语言通用化来自混合部署的现实：无种查询不能让一个提供方的失败（冷的 tsserver）淹没其他提供方的答案，种子语言没有已配置服务器覆盖时必须可感知而不是无声的空。因此 `symbol()` 把带种请求路由到覆盖种子扩展名的唯一提供方（与 `query()` 的扩展名路由同构），对未覆盖的种子扩展名不做查询、直接返回安装建议，并把无种扇出合并、逐提供方附注失败。pyright、gopls、rust-analyzer 等现代服务器启动即索引整个工作区、无需种子——种子机制是与 tsserver 兼容的垫片，对它们无副作用地组合。

采用率是被度量的，不是被假设的：预声明判据是部署一周内 deepseek-harness coding 会话中出现有机 `lsp` 调用的比例 ≥10%，并按操作分布归因是哪个杠杆（schema 人机工学还是提示词引导）起了作用。问题分析中的会话日志扫描方法就是度量工具。

## Alternatives considered

**只改提示词** —— 不动 schema，加强 persona 或工具引导。作为唯一措施被否决：已有引导的有机使用率为零，且任何措辞都无法让一个只要坐标的接口一次调用回答按名查询。保留为互补杠杆。

**grep 到 LSP 的自动代理** —— 让 grep 识别符号形态的模式并隐式咨询 seam。被否决：隐式行为违反显式边界惯例，使 grep 契约不可测，并对模型隐藏 LSP 不可用路径。

**等上游** —— 保持 `packages/lsp/` 不动以免本地 diff。被否决：上游没有任何将交付此能力的信号（静默、无 PR、无 issue 通道、文档声明四操作封闭），而零采用的代价每天都在累积。diff 局限在三个包内，未来上游等价能力可做语义合并。

## Consequences

模型可以一次调用按名找到符号，输入人机工学与 grep 对齐而返回语义解析的声明位置；坐标操作从障碍变成链条的自然下一步。tsserver 种子机制增加了一个记住文档字段与每提供方一次有界种子读取，且按项目加载服务器上的冷无种查询会诚实地透出服务器错误而不是静默重试。fork 从此携带对上游 seam 与工具契约的本地扩展——未来上游的符号 API 需要语义合并，README 已标记该偏离。未解析的 `WorkspaceSymbol` 条目不带位置渲染，而不做 `workspace/symbol/resolve` 往返；空 query 的全量匹配语义在工具层被拒绝以约束服务器负载。在度量判据评估之前，采用率仍是未证实的；若失败，下一个杠杆（结果增强，或接受 grep 主导）是独立决策。

## Verification

包测试覆盖 seam（种子路由到覆盖提供方、未覆盖扩展名免查询返回、扇出合并顺序、不支持折空、失败与成功组并存、全失败聚合、无提供方与全不支持失败、信号透传、HMR 释放）、提供方路径（能力门控、种子读取与 language id 派生、种子与记住文档的打开、种子持久化供后续无种查询、取消与换传输重试、符号归一化与 kind 映射）、工具层（schema、经 executor 的逐操作参数校验、种子透传、失败附注与安装建议渲染、带截断与无位置条目的渲染、呈现）。真机 `typescript-language-server` e2e 钉住三条符号路径：冷无种的 `No Project` 失败、播种查询、位置查询后记住文档的兜底。keyless 的 `lsp-symbol` ACP 快照经真实 Loader 组合端到端驱动 fixture stdio server，钉住路由播种查询、未覆盖扩展名的安装建议与 `maxLocations` 省略标记；`lsp-definition` 与 `fs-glob-sampling` 的 expected 输出已随提示词、schema 与 grep 描述刷新。
