# Agent Note: 采用率终判失败后从 feishu-bridge profile 摘除 lsp 工具

Status: implemented

[English](2026-09-02-lsp-tool-unmount-adoption-failure.md) | 中文

## Problem

lsp 工具以三包能力 seam 交付（[2026-07-15](../architecture/2026-07-15-lsp-capability-seam.zh.md)）。把它挂载进 feishu-bridge profile——双桥接主机的 live profile 与 bundled profile——声明了 `lsp`、`lsp-stdio`、`tool-lsp` 三个插件，向每个请求注入 LSP 提示区段，并在 grep 工具描述中交叉引用该工具（b650ab0fab）。部署携带预登记判据：挂载后一周内，至少 10% 的 harness coding 会话出现有机 lsp 调用，终判日期 2026-09-03。

## Decision

终判失败，profile 不再挂载 lsp 工具。摘除只发生在装配层；三个包、它们的测试与 lsp 快照 profile（`snapshots/acp/lsp-symbol`、`snapshots/session/lsp-definition`）全部保留。

2026-09-02 对挂载（2026-08-27 19:20）以来的 5.8 天做了度量，扫描双桥接主机共 3,874 份会话日志：

- 窗口内 31,350 次工具调用；lsp 9 次（0.029%），其中 8 次来自部署验证或自测会话。唯一一次有机调用是审计子代理的 `workspaceSymbol` 查询，且成功了。
- 148 个 harness coding 会话（窗口内创建、至少一次代码工具调用）；有机 lsp 会话占比 0.4–0.7%，对比判据的 10%。
- 双机近期会话挂载率 100%，零不是挂载失败；同一窗口内标识符形态的 grep 模式——`workspaceSymbol` 的替代场景——运行了 118 次。

维持挂载的成本约为每个模型请求 550 token（1,541 字符的工具条目加约 640 字符的提示区段），双机每个会话都在支付。grep 描述的交叉引用句随源码删除，spec 断言反转为 `not.toContain('lsp')`；快照 fixture 与 tool catalog 随源码跟进。

## Alternatives considered

**第二轮采用率工程（描述精修、失败恢复文案、免审批调用，或拦截 grep 家族）。** 被否决：判据差距 15 倍，唯一一次有机调用已经成功——瓶颈不在工具质量，在查询时刻的工具选择——而拦截只有堵住整个 grep 家族才有效，代价与 0.03% 的调用占比不成比例。

**维持装配现状。** 被否决：为一个模型不选择的工具持续支付每请求 token 成本与 link 包维护。

**删除 packages/lsp。** 被否决：三包是上游资产，fork 侧删除会在每次上游同步时重新出现。seam 保持完整，留待潜在的诊断消费者。

## Consequences

live 与 bundled profile 不再声明 lsp 插件及其服务器二进制依赖，daemon 的模型面失去 lsp 工具及其提示区段。诊断注入——仅存的有可工作先例的 LSP 方向——只需要 `ctx.lsp` 提供方，不需要面向模型的工具；seam note 对 freshness 与累积语义的推迟仍约束它。重新挂载只是配置操作：恢复三条 profile 条目与服务器二进制依赖，在 profile 内 `pnpm install`，reload。
