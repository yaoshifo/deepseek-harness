# Agent Note: feishu-bridge 迁移时 profile 丢失了 lsp 三行

Status: implemented

[English](2026-08-21-feishu-bridge-profile-lsp-rows.md) | 中文

## Problem

`packages/acp/feishu-bridge/profile/` 的 M0 profile 模板（提交 `feb2533467`）把生产 cc-connect profile 的 lsp 依赖抄进了 `package.json`（`dsh-lsp`、`dsh-lsp-stdio`、`dsh-tool-lsp`），却把 `cordis.patch.yml` 里对应的 `lsp` / `lsp-stdio` / `tool-lsp` 三行 insert 丢了。MIGRATION.md 自己的迁移清单点名 lsp 复用不动，漏抄与迁移计划相悖。Cordis 只组装 patch 树点名的插件，于是这些包一直处于「装了没挂」状态：bridge 会话不暴露 `lsp` 工具，而 `grep` 工具描述（提交 `b650ab0fab`）仍在推荐它。两天会话的工具调用统计——1,590 次调用、零次 lsp——暴露了这个缺口。

## Decision

repo 模板与部署 profile（`~/.dsh/profiles/feishu-bridge/cordis.patch.yml`）都恢复了这三行，并在 `lsp-stdio.servers` 里挂上完整的语言 server 表：typescript（profile 自带 `typescript-language-server`，绝对 `node_modules/.bin` 路径）、python（pyright）、go（gopls）、java（jdtls，`JAVA_HOME` 钉在 LTS JDK）、rust（rust-analyzer）、c/c++（clangd）——对应本部署所服务的 workspace 项目语言盘点。`typescript-language-server` 与 `typescript` 是 profile 依赖，随 profile 一起安装。

patch 注释记录的部署约束：

- lsp-stdio 在加载时解析每条 server command，一条坏条目——命令缺失或启动失败——会挡掉**全部** provider 注册。先装 binary 再改 patch；失败的行不是单语言降级。
- launchd daemon 上的 command 一律绝对路径。`~` 不展开、profile 的 `.bin` 目录不在 daemon PATH 上、加载时的 PATH 解析不可靠。repo 模板以裸名作为机器无关默认，并在注释里说明。
- 模板的系统 server 行在部署机 daemon PATH 解析不到时 fail-loud；该部署把裸名换成绝对路径。

## Alternatives considered

**部署 profile 也用裸 command 名。** 否决：一个解析不到的名字会一次性禁用全部 lsp provider，且 launchd PATH 与交互 shell 不同。

**按项目配置 server 表。** 不可表达：lsp-stdio 每个部署只接受一份静态 server 表。按项目的 pyright 解释器或按项目的 jdtls data 目录作为已知限制接受——一个 jdtls 实例和一个 data 目录服务全部 Java 项目，pyright 只解析一个全局解释器。

## Consequences

bridge 会话对 `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.pyi/.go/.java/.rs/.c/.h/.cpp/.cc/.hpp` 暴露 `lsp` 工具。Java 首次查询要付 JVM 启动加导入索引的成本、可能超时一次；后续查询正常。profile patch 编辑经 Cordis HMR 免重启到达运行中的 daemon，验证以会话日志（`tool/call` 与 `isError: false` 的 `tool/result`）为准，而非进程状态。
