# Agent Note: Claude Code 记忆兼容

Status: implemented

[English](2026-08-14-claude-code-memory-compat.md) | 中文

## Problem

harness 缺少 Claude Code 持久 auto memory 的等价物:`dsh-agent-instructions` 覆盖 CLAUDE.md 式 workspace 指令,`examples/mcp-memory` 只是第三方 MCP 记忆服务的接线(默认关闭、独立存储)。同时在 Claude Code 和 dsh 里工作的用户,积累在 `~/.claude/projects/<slug>/memory/` 的记忆(按项目隔离、一文件一事实、`MEMORY.md` 作为每条记忆一行的索引)dsh 会话永远看不到;而任何 dsh 原生设计都会把这份语料分裂成第二个无人迁移的存储。

## Decision

`@deepseek-ai/dsh-tool-claude-memory`(`packages/memory/tool-claude-memory`)复用 Claude Code 自己的存储而非定义 dsh 原生存储:直接读写 `~/.claude/projects/<slug>/memory/`,`<slug>` 是会话 cwd 中每个 `/` 和 `.` 折叠为 `-` 的结果(磁盘实证:`/home/hm/.dsh/profiles/cc-connect` → `-home-hm--dsh-profiles-cc-connect`)。三个面对应 Claude Code 自己"持久引导 + 运行时召回"的拆分:

- 系统提示 section(order 110,工具引导区),逐字照抄 Claude Code `## Memory` 策略,仅适配工具名与实例化的目录。`tests/prompt.spec.ts` 的锚点测试固化承重句,提示词漂移即必须更新 README verbatim 块与快照的可见行为变更。
- 一次性会话开始 `user/message` 注入,内容为按预算截断的 `MEMORY.md` 索引,source 为 `{ kind: 'claude-memory', version: 1, project, digest }`,由插件自有的 `<system-reminder>`(含闭合标签转义)包裹,沿 `dsh-agent-instructions` 的 pre-step 模式折在认领的 prompt 之后。每份会话日志至多注入一次;resume 与 compaction 不重注入,模型经 `memory_read` 刷新。
- `memory_list`/`memory_read`/`memory_write`/`memory_delete` 四个工具操作该目录。

工具走宿主 `node:fs`,绝不走 `ctx.fs` provider:文件系统能力按部署可替换(e2b 沙箱指向远端世界),经它路由记忆 IO 会切断机器本地的共享契约。这是对 provider 可替换性的一个刻意例外,理由是外部产品拥有存储位置。

与 Claude Code 对齐意味着无 schema 强制:frontmatter 质量、索引行 hook、写前去重、删除错误记忆都交给提示词自治。插件只强制信任边界(单段文件名,并按[记忆文件名后缀规范化](../bug-fix/2026-08-17-memory-name-suffix-normalization.md)统一为 `.md` 后缀),并在 Claude Code 同样出手的地方补 harness 价值——向已有 frontmatter `metadata:` 块内增量回填 `node_type: memory`/`originSessionId` 溯源(只增量、绝不合成),以及对超预算的 `MEMORY.md` 写入给出事后警告。索引行绝不自动生成;单行 hook 是召回工件,生成的 hook 会无声劣化召回质量。

## Alternatives considered

**`$DSH_HOME/memory/` 下的 dsh 原生存储。** 否决:分裂语料、需要本可免费的迁移,并失去驱动本功能的"Claude Code 积累的记忆在 dsh 可用"属性。

**能力 seam(Service Definition / provider / consumer 拆分),文件存储作首个 provider。** 否决:格式由外部产品拥有,provider 无可变之处;每个外部布局一个兄弟包才是诚实的拓扑,`packages/memory/` 组即为此设。

**模型经普通 fs 工具读写记忆目录,同 Claude Code 的 Write。** 对 dsh 否决:产品 fs 能力是可替换 seam,沙箱部署会写进远端世界并悄然停止与 Claude Code 共享。专用工具使机器本地 IO 无条件成立。

**turn 结束自动提取(Claude 早期实验版 auto memory)。** 否决:Claude Code 正式版选择模型自写模式;写入时机、去重与"不该存什么"的判断恰是策略提示词编码的内容,后台管线只会以更差的上下文重复它们。

**agent-instructions 式的 baseline-identity 索引重组。** 暂缓:workspace 指令随模型编辑文件而变化,需要和解;记忆索引是工具可按需刷新的召回输入,为未观察到的漂移成本引入重组机制买不到东西。

## Snapshot support

场景的会话 cwd 是随机临时路径,注入消息内嵌其 slug,回放 fixture 每次运行都会漂移。`dsh-acp-snapshot` 因此新增 `{{cwdSlug}}` token:`normalize.ts` 把每个已知 cwd 拼写折叠为 slug,并以 slug 字符边界替换独立出现(粘连文本如 `<slug>-backup` 原样保留,维持既有 basename 契约);`refreshFixtureReplacements` 把新运行的 slug 映射到 fixture 的拼写或该 token。Windows 盘符 cwd 永不折叠(其"slug"仍含分隔符),跳过而非猜测。

## Consequences

- 接近上限的索引提醒(Claude Code 在超预算前提醒;本插件只在事后警告)是无格式变更的增量后续。
- 若 Claude Code 的 slug 规则在 Windows 上得到实证,`isPosixCwd` 守卫可无格式变更地放宽。
- 第二个外部记忆布局应作为兄弟包进同一组,而非藏进 provider seam。
