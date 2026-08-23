# Agent Note: 移除 cc-connect-bridge 包

Status: implemented

[English](2026-08-23-remove-cc-connect-bridge.md) | 中文

## Problem

harness 一度承载两个飞书侧桥。`dsh-cc-connect-bridge` 是原两层架构中的 stdio JSON-RPC 运行层——Go cc-connect daemon 经它与 dsh 通信。M8 cutover（2026-08-21/22）把全部生产项目（含最后一个 claudecode 型项目）迁到 `dsh-feishu-bridge`——engine 与飞书 WS 平台同驻一个 daemon 进程、无桥协议；Dev 服务器的 `cc-connect.service` 随之 stop 并 disable。此后该包零消费方，却仍占一个 tsconfig project reference、生成式 catalog 小节，以及 16 个存量 lint 错误——仓库级 lint 门因此常红。

## Decision

用户于 2026-08-23 裁定 cc-connect 路径退役：dsh 一律经 `dsh-feishu-bridge` 直连。`packages/acp/cc-connect-bridge` 整包删除，连带 tsconfig.host.json 的 project reference、lockfile importer 与生成式 catalog 小节；`packages/acp/feishu-bridge/reload.sh` 去掉与兄弟脚本 reload 的对比句；AGENTS.md 现状行只列 feishu 桥。git 历史与原 Go cc-connect 仓库仍是行为参照；被删包中没有 feishu-bridge 缺失的机制。

## Alternatives considered

**把包留作休眠参照。** 落选：零消费方的死面仍占一个构建目标、catalog 空间与 lint 债，且每个读者都得重新核实它确实无人使用。

**挪到 `experimental/` 下。** 落选：换个路径的死代码还是死代码——不进发布并不能造出消费方，也换不回维护成本。

## Consequences

代价：扩展 stdio JSON-RPC 桥（在 capability seam 之上实现 resume/cancel/approvals/questions）的仓内参照实现从树中消失；要重建该传输层的人从 git 历史或原仓库起步。收益：只剩一条桥接路径；仓库级 lint 门转绿（16 个存量错误全部位于该包）；catalog 只列可加载的包。

## Testing

无可钉行为：删除的是无依赖方的自包含包。`pnpm install` 剪掉 importer、`pnpm run clean` 清走孤儿构建产物，typecheck/lint/doc-sync/hygiene 各门在无它的树上验证通过。
