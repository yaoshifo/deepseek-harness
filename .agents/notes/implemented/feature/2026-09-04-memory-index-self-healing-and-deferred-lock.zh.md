# Agent Note: Memory index self-healing signals and the deferred cross-session index lock

Status: implemented

[English](2026-09-04-memory-index-self-healing-and-deferred-lock.md) | 中文

## Problem

MEMORY.md 是由模型会话按两步纪律维护的聚合文件:先写主题文件,再用 `memory_index` upsert 其指针行。两类失败会破坏召回:

1. **纪律缺失** —— 会话写了主题文件却从未调用 `memory_index`。文件在磁盘上存在,但任何会话启动注入都不会列出它,于是永远不会被召回。一个部署的日志显示该比例约为 77 次写入中 1 次:写入 `codex-lsp-absence-audit.md` 的会话调了 4 次 `memory_write`、0 次 `memory_index`,而提示词与工具描述都在教第二步。
2. **丢失更新** —— `updateMemoryIndex`(`packages/memory/memory/src/store.ts`)读取整个索引、在内存中变换、再 rename 覆盖 `MEMORY.md`,没有任何协调。同一目录上两个并发调用可能各自写出丢弃对方指针行的基线状态。

## Decision

不加锁。两类失败得到不同处理,依据均为实测证据:

- **纪律缺失:两个自愈信号,均已落地。** 主题文件的 `memory_write` 结果携带 `indexed: boolean`(由新 store 原语 `hasMemoryPointer` 计算,与 `updateMemoryIndex` 的匹配同样双向容错拼写);为 `false` 时,渲染结果点名缺失的 `memory_index` 调用,此时写方会话仍持有写出好标题与 hook 所需的上下文。另一路,会话启动索引注入末尾追加一行未索引文件清单(新原语 `listUnindexedMemoryFiles`,至多列五个文件名加溢出计数),孤儿最多存活到该 scope 的下一个会话。该行双向容错拼写,排除 `MEMORY.md` 本身与点前缀工件,每 scope 每次会话启动多一次目录读——无孤儿时零额外 token。
- **丢失更新:搁置,重启触发线已记录。** 同一会话内,工具运行时本就串行化记忆工具:未声明 `isConcurrencySafe` 的工具按提交序独占执行(`packages/core/tools/src/index.ts`),同消息突发不会互踩。跨会话与跨进程写者保持不协调——包括 Claude Code 会话,它们彼此之间同样不协调。包 README 的 Known Limitations 承载完整画像与触发线:首次观察到真实跨会话重叠、chatroom persona 记忆写入量显著增长、或 CLI 与 daemon 会话常规共享同一 workdir。

## Forensics: where concurrent index writes actually race

两项调查支撑了搁置决定。

**Claude Code 2.1.228(本机安装的二进制逆向)。** CC 恰好只有三个 memory 工具——`memory_list`、`memory_read`、`memory_write`——没有 `memory_index` 也没有锁;索引维护是提示词纪律(「add a one-line pointer」段落),由 `memory_write` 整文件重写完成。二进制中仅有的 lock 相关字符串属于 Bun 包管理器。其 team-memory 层以服务端权威覆盖加「请把内容搬走」的用户警告解决并发。因此没有 CC 方案可移植;dsh 的 `memory_index`(dsh 专属工具)正是让引擎侧索引维护成为可能的前提。

**一个部署的会话日志(2,650 会话、约 10 天、最忙目录 235 次 index 调用)。** 对每次 `memory_index` 调用做区间重叠分析(派发时间戳至结果时间戳):同会话重叠为零(独占执行保证全程成立)、不同会话间重叠为零、十二对 stall-resume 镜像会话在相同时间戳写入相同内容(双执行、无害)、353 次写入中零次以 `MEMORY.md` 为目标(宽窗口的陈旧整文件重写从未发生)、磁盘上唯一的孤儿被证明是上述纪律缺失而非丢失更新。

给未来审计的方法警告:一串 upsert 结果行数相同**不能**证明丢失更新——串行的就地替换产生完全相同的签名。只有区间重叠(或字节算术不一致)能判别;这里的第一轮分析就曾把一次四调用突发误读为互踩,后被区间检查纠正。

## Alternatives considered

**用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 串行化 `updateMemoryIndex`(及整文件 `memory_write`)。** 跨会话跨进程无懈可击,仓库内已有四个消费者,是触发线命中后的既定修法。搁置原因:用实测零发生率换来新失败面——持有者崩溃遗留的 `MEMORY.md.lock` 会阻塞全部写者直至人工删除,且锁文件在与 Claude Code 共享的目录内频繁创建删除。

**乐观重读合并(rename 前校验基线,冲突则在新内容上重放)。** 在最终读取与 rename 之间留下静默残余竞态——恰是被消除的失败模式——并且在仓库已有锁工具的情况下新增自持重试循环。

**`memory_write` 从 frontmatter 自动生成指针行。** 否决:指针行刻意由模型撰写,因为 hook 质量决定召回;且偏离本包锁定的 Claude Code 观察行为。

**`memory_write` 可选 `title`/`hook` 参数(一次调用原子完成写加索引)。** 延后的升级路径而非否决:为采用者消灭第二步失败模式,每次记忆省一轮 LLM 往返,代价是每请求约 30 个 schema token 加提示词重教。若写时提醒被无视或孤儿率不降则升级。

**仅会话启动孤儿清单。** 单独不足——只能在写方会话结束后治愈,失去其写出好 hook 的上下文——但保留并与写时信号一同落地。

## Consequences

换来:零常驻 token 成本的确定性流程内纠正(提醒仅在未索引写入时出现)、跨会话自愈(任何现存孤儿在该 scope 下一次会话启动即被暴露)、以及以诚实的 README 限制条目替换原先「identical to two concurrent Claude Code sessions」的说法——旧说法准确,但遮住了同会话独占执行保证与跨会话实测记录。

代价:每 scope 每次会话启动多一次目录读;提醒触发时多几个结果 token;并发会话恰好在写入与检查之间移除指针行会产生一次性误提醒(无害——重索引幂等);跨会话丢失更新窗口按已记录的选择保持敞开,仅由上述触发线修复。

## Testing

包内 spec 端到端钉住两个信号:`tests/store.spec.ts` 的 `hasMemoryPointer` 与 `listUnindexedMemoryFiles` 行为、`tests/index.spec.ts` 的工具结果与渲染提醒、`tests/inject.spec.ts` 的提示行渲染与封顶、以及经真实插件体的组合注入。无 key 录制会话快照 `snapshots/acp/dsh-memory` 回放绿,两次 `memory_write` 结果均可见提醒;该快照的刷新顺带再同步了该场景 expected 文件中的既有源漂移(`web_fetch` 提示词段、`send_message`/`agent_id` schema 改名)——dev 上更大范围的快照套件存在约 95 个先于此变更、与之无关的场景失败。

## Related

- [dsh-memory package rename](../architecture/2026-08-28-dsh-memory-package-rename.zh.md) —— 本包在布局中的位置。
