# Agent Note: claude-memory 全局 scope —— 默认开启的跨项目第二记忆目录

Status: implemented

[English](2026-08-25-claude-memory-global-scope.md) | 中文

## 问题

Claude Code 的记忆机制严格按项目隔离(`~/.claude/projects/<slug>/memory/`),dsh 的兼容插件逐字镜像了这一点。但会话学到的一些事实并不是项目事实——daemon 沙箱挡住 macOS 钥匙串,导致任何仓库里 `git push` 都报 `gh token invalid`;用户关于工作方式的反馈在任何地方都成立。唯一的跨项目通道,全局指令文件(`~/.claude/CLAUDE.md`),是人工维护且全文常驻注入的,适合放原则、不适合堆碎片:用户想要坑级别的记忆跨项目共享,又不想把指令文件变成流水账。

## 决策

**第二个记忆目录,而不是新机制。** global scope 复用整套记忆设施——文件格式、frontmatter、MEMORY.md 索引纪律、五个工具、原子写——只是把目标从按项目的 slug 目录换成 `<claudeHome>/memory/`。Claude Code 不读该路径;本部署正在迁离 Claude Code,这一取舍可以接受,而且无论哪种情况 project scope 都与 Claude Code 保持字节级兼容。

**默认开启;配置是退出开关。** global scope 随插件默认启用:任何部署无需配置即获得 `## Global memory` 附录、全局索引注入与 `scope` 工具参数。`global: { enabled: false }` 完全关闭(无附录、无第二次注入、无参数,传入 `scope: 'global'` 大声失败)。全局预算继承项目预算,组合显式声明的单一预算同时约束两个 scope;只覆盖全局数字则收紧(或放宽)全局注入内容的噪声上限。该默认值在落地当天由最初的 opt-in 设计翻转而来——部署所有者要求跨项目记忆免配置即用,且每个组合本就显式声明被继承的预算,预算纪律不变量得以保留。Schemastery 的两个怪癖塑造了 schema:缺省的嵌套对象到达时是 `{}`,且嵌套的 `required()` 字段在外层键缺失时仍被强制,因此 `apply` 从(可能为空的)对象解析默认开启语义,并在显式字节预算非正时于装载期拒绝。

**模型在写入时选择 scope;引导放在离决策点最近的三个面上。** `## Global memory` 提示附录携带一个单问判定(*这条记忆拿到一个无关项目的会话里还有用吗?*),并把 `When unsure, choose project` 作为失败安全默认——代价不对称:写窄了只是别处召回不到,写宽了是每个未来会话都注入噪声。`scope` 参数的 description 在模型读到参数的地方复述判定;全局索引帧头在每次召回时标明跨项目语义。

**不做定时晋升;改为惰性重归档。** 周期性的 project→global 晋升扫描被否决:它以比写入时更少的上下文重判语义;其事件率(每台机器每月屈指可数的几条)撑不起对全部项目目录的常驻 LLM 扫描;而且无人看守地写入全局注入内容会绕过让全局层值得信任的人工把关。同样的需求由三条路径覆盖:写时规则(新记忆)、提示词里的惰性规则——一旦观察到跨项目需求就当场重归档该条 project 记忆——以及部署后对既有存量的一次性清点审计,每次晋升由用户确认。

**Source 标记升版为 2,按 scope 去重。** `ClaudeMemorySource` 增加 `scope` 并把 `project` 改为条件字段;`hasMemoryInjection` 与 invariant companion 按 scope 去重,一个会话可同时携带一条 project 注入与一条 global 注入。旧日志里的 version-1 注入在去重时按 project scope 读取,但 invariant 会将其作为过时数据拒绝——pre-release 立场接受拒绝旧落盘格式,而不是背负兼容垫片。

## 后果

全局注入先于项目注入(稳定身份在前),各自有独立的 `<system-reminder>` 帧与预算。`memory_write`/`memory_index` 对各自 scope 的 MEMORY.md 应用各自预算;两个预算互不影响。global scope 的工具调用只要求一个归属会话——不需要 POSIX cwd、不依赖 slug——因此无 cwd 的会话仍可读写全局记忆;project scope 保留 slug 守卫。到达未启用全局部署的 `scope: 'global'` 实参在 `resolveCall` 中大声失败,而不是静默路由到项目目录(开放式参数根否则会吞掉这个未知键)。全局目录的并发保持 last-write-wins,写者群体扩大为本机上所有 dsh 会话。`examples/acp-agent` 的 dsh-memory 快照覆盖双注入与一次 scope=global 的写入/索引往返;包内测试固化提示锚点、按 scope 去重与走真实 Loader 启动加卸载的组合。

## 考虑过的替代方案

- **用户级 skills 目录作为全局通道** —— 零代码且双 harness 可见,skill description 也确实是"索引常驻 + 正文懒加载"的召回形态。被否决为主方案,因为 skill 是触发条件形态的工作流指引,丢失记忆语义(类型、溯源、去重),且停止使用 Claude Code 的决定消除了它唯一的论据。
- **晋升进全局指令文件** —— 碎片全文常驻注入,正是用户要避开的噪声形态;该文件留给人工撰写的原则。
- **硬校验把全局写入限制在 `user`/`feedback` 类型** —— 最典型的动机记忆(钥匙串坑)是环境事实,两类都不干净地匹配;"跨不跨项目"是代码做不了的语义判断,与插件"提示词纪律优先于 schema 强制"的既有立场一致。
- **cron 跑晋升扫描** —— 因上述理由否决;若错归档被证明常见,升级路径是按需审查 skill,而不是调度器。
