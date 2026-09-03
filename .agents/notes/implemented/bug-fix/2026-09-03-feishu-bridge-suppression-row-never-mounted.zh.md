# Agent Note: feishu-bridge 的 suppression 注册表通过 insert 行挂载

Status: implemented

[English](2026-09-03-feishu-bridge-suppression-row-never-mounted.md) | 中文

## Problem

bridge 的 bundle patch 曾用 id 定位条目（`- id:` 加 `name:`，无 `insert:`）注册 `agent-instruction-suppression`。`applyEntryPatches` 对非 insert 条目只会在组合树既有行里按 id 找目标，id 匹配不到就跳过——它永远不会新增行——而 dsh-base 并未定义这行（安装版 0.1.2-alpha.2 与工作区 0.1.2-alpha.3 均已核实）。于是[suppression 注册表](../architecture/2026-09-07-agent-instructions-suppression-host-plane-service.zh.md)从未挂载，适配器两个调用点又都是可选链、服务缺失即静默不抑制：bare-persona 会话与所有走 complete-prompt 的一次性查询（render fork、群命名、predict-next、turn summary、monitor triage）持续获得完整的工作区指令注入——cwd 祖先链上的 AGENTS.md/CLAUDE.md 进入了系统提示已被整体替换的会话。

缺陷在两天的线上运行中始终无人察觉。boot 路径在 root Include 内应用 bundle patch，早于任何 logger exporter 存在，loader 的 `patch: entry "agent-instruction-suppression" not found` warning 无处输出；`/reload` 预检把 `--dump-config` 的 stderr 落在 `feishu-bridge-config-check.err`，但只在 dump 失败时才回显。`tests/bundle-patch.spec.ts` 收集了组合 warning，却只对 plan-mode、ask-user、dsh-memory 三类行断言为空。

## Decision

该行改为 `insert` 条目——与 patch 里 `tool-ask-user`、`dsh-memory` 这两个 base 未随附行同形——并把 `@deepseek-ai/dsh-agent-instructions` 声明为 bridge 依赖，使非 link 安装也能解析该行的包。bundle-patch spec 断言该行以正确的 id 与 name 存在、且无任何 warning 点名它。解析不需要改 profile：patch 行里的裸包名从运行中 CLI 的安装锚点解析，live daemon 跑的是工作区 `apps/cli` 构建，`/suppression` 子路径在那里解析到工作区包；profile `node_modules/.pnpm` 下钉注册表版本的副本只是未被使用的传递依赖。

## Alternatives considered

**把该行加进 dsh-base、保留 id 定位条目。** 注册表是 bridge 专属的宿主面能力；base 挂载它会让每个 base-backed profile 都发布该服务，包括 serviceless 插件形态本要保护的 web preset 组合。

**让引擎在 id 定位条目匹配不到时 fail loud。** 共享 overlay 本就合法地面向缺少某些行的组合树——逐条 warning 是 `parsePatchList` 的成文契约——抛错会破坏所有 patch 层的语义。跳过行为是正确的；缺陷在条目写法。

## Consequences

`/reload` 之后，bare-persona 与 complete-prompt 会话不再获得工作区指令注入：人设契约不再混入 cwd 祖先文件，render fork 也不再背负整份项目指令文件的无用提示载荷。两个观测缺口仍然敞开：boot 期 patch warning 依旧无处输出，`/reload` 也依旧只在失败时回显预检 stderr——排查被静默跳过的 patch 行，需要在 dump 之后重读 `feishu-bridge-config-check.err`。spec 的行存在断言是这行形态的回归钉。
