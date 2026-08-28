# Agent Note: dsh-memory 包改名

Status: implemented

[English](2026-08-28-dsh-memory-package-rename.md) | 中文

## 问题

memory 包以 `@deepseek-ai/dsh-tool-claude-memory` 发布在 `packages/memory/tool-claude-memory`,Cordis 插件名、system-prompt section 名、组合 id、以及持久消息 source kind 全部叫 `claude-memory`。名字里有两处在误描述这个包:`tool-` 前缀暗示它只是个工具包,但它实际贡献 system-prompt section、会话开始的持久注入、以及工具三样东西;而 `claude` 限定词把一个实现细节(与 Claude Code 磁盘布局的兼容)当作了包的身份,可这个能力本身——agent 的持久记忆——是 dsh 自己的。持久 source kind `'claude-memory'` 更是把这种借来的身份带进了会话日志格式,每份部署日志都在用一个外来产品的名字称呼 dsh 的记忆能力。

## 决策

包改名为 `@deepseek-ai/dsh-memory`,目录为 `packages/memory/memory`(组目录布局规则:目录名 = 包名去掉 `dsh-` 前缀;先例 `packages/web/web`、`packages/goal/goal`)。Cordis 插件名、system-prompt section 名、所有组合 id 改为 `dsh-memory`。持久消息 source kind 与 `MessageSourceMap` 键改为 `'dsh-memory'`,类型改名 `DshMemorySource`;形状不变,仍是 `{ kind, version: 2, scope, project?, digest }`。

命名 Claude Code 自身行为的标识保留:`claudeProjectSlug` 编码的就是 Claude Code 的磁盘 slug 规则,陈述共享关系的措辞("shared with Claude Code"、兼容性描述)也保留——它们描述的是本包镜像的外部规范,不是本包。

按 pre-release 立场,不做兼容垫片:所有引用同步更新(组合 profile、examples、快照夹具、生成目录、tsconfig 聚合、tool-catalog 生成器)。

## 已考虑的替代方案

**保留持久 kind `'claude-memory'`,其余全改。** 保住改名前日志的去重连续性,且 kind 与 Claude Code 自己的会话开始 reminder 格式一致。放弃的原因:kind 是这个借来的身份触及持久数据的唯一位置——wire 格式恰恰是命名应当归属自己的地方——而且 pre-release 立场明确选择正确的基础而非垫片。代价有界:见「后果」。

**目录名用 `packages/memory/dsh-memory`。** 破坏组目录布局「目录名 = 包名去 `dsh-` 前缀」的约定,`packages/` 下其他包都遵循该约定。

**包名保留 `claude`(`dsh-claude-memory`)。** 从 Claude Code 兼容角度可检索,但包仍然以它镜像的东西而非它提供的能力命名。

## 后果

改名前写入的会话日志携带 kind 为 `'claude-memory'` 的注入;resume 时 `hasMemoryInjection` 不再匹配这些事件,每个 scope 的索引会向该续接会话再注入一次(模型同时看到旧快照与新快照)。`MessageSourceMap` 是 merge-extensible 的,旧 kind 走文档化的默认分支,日志仍可读;`SESSION_FORMAT_VERSION` 不变,因为 `user/message` 事件结构未变。

link 该包的部署 profile 必须更新依赖名与 link 路径;由于依赖清单变化,需要 profile install——仅 `/reload` 不会刷新已 link 包的身份。invariant 伴随插件(`dsh-memory-invariant`)只校验新格式的注入;旧日志中改名前的注入事件被它的 kind 过滤跳过,而不是报失败。

## 相关

- [Claude Code memory compatibility](../feature/2026-08-14-claude-code-memory-compat.zh.md) — 本 note 更新其名字事实的原包决策。
- [Memory index maintenance](../feature/2026-08-17-memory-index-maintenance.zh.md)
- [claude-memory global scope](../feature/2026-08-25-claude-memory-global-scope.zh.md)
