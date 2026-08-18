# Claude Code 记忆兼容

[English](README.md) | 中文

这个 overlay 让一个 `dsh web` 进程与本机 Claude Code 共享同一份记忆,而不改变出厂默认的 Web 组合:

```sh
dsh web --patch examples/claude-memory/cordis.yml
```

此后 dsh 与 Claude Code 读写同一个按项目隔离的记忆目录 `~/.claude/projects/<slug>/memory/`,`<slug>` 是会话工作目录中每个 `/` 和 `.` 替换为 `-` 后的结果。Claude Code 写下的记忆 dsh 能召回,dsh 写下的记忆会出现在 Claude Code 的下一个会话里。不引入任何自有存储。

机制由三个模型可见面承载。系统提示加入逐字照抄的 Claude Code 记忆策略段(一文件一事实、frontmatter `name`/`description`/`metadata.type`、四类记忆、`[[name]]` 双链、MEMORY.md 作为每条记忆一行的索引)。每个顶层会话第一个被采纳的 step 把该项目的 `MEMORY.md`(前 200 行或 25,600 字节,先到为准)折入持久上下文,包裹在插件自有的 `<system-reminder>` 框架里,并声明召回的记忆是背景上下文而非用户指令。五个工具 —— `memory_list`、`memory_read`、`memory_write`、`memory_delete`、`memory_index` —— 只在该目录内操作,直接走宿主文件系统而不经过可替换的 `ctx.fs` provider,使共享目录在任何部署形态下都留在本机。`memory_index` 每次调用 upsert 或删除一行指针;通用文件工具写不了这个目录——文件沙箱会拒绝——记忆策略段对此有明确说明。

注入每会话只发生一次:resume 与 compaction 不重注入,模型需要更新状态时用 `memory_read` 读取当前索引。子代理会话既不获得策略段也不获得注入。`memory_write` 会在已有 frontmatter `metadata:` 块内兜底补上 `node_type: memory` 与 `originSessionId` 溯源字段,与 Claude Code harness 的行为一致;对 `MEMORY.md` 的写入若超出行数或字节预算仍然成功,但携带"把细节移入主题文件并重写索引"的警告。文件名校验为单段路径——路径穿越在存储边界被拒绝;frontmatter 质量交给模型自律,与 Claude Code 完全一致。

并发会话(dsh 或 Claude Code)写同一记忆文件时按 last-write-wins 收敛,与两个并发 Claude Code 会话的行为相同。把 `claudeHome` 指向别的根目录,即可在不动本机真实 Claude Code 主目录的情况下实验。
