# Agent Note：JSONL 持久化后端的只读附加根

Status: implemented

[English](2026-09-09-session-persistence-readonly-roots.md) | 中文

## 问题

一个 dsh 进程只能通过自己挂载的单一 persistence 根来列出与读取会话。feishu-bridge 守护进程把完全标准的会话（同一插件、同一 SessionEventMap、同一磁盘布局）存在自己的根下（`~/.dsh/feishu-bridge-sessions`，由其 profile patch 配置），因此挂载 `~/.dsh/sessions` 的 Web UI 进程完全看不到它们。除根目录外两边会话完全可互换：bridge 不写任何包内私有的 durable 事件，冷读取也不需要 bridge 侧元数据。

## 决策

`session-persistence-jsonl` 新增 `readOnlyRoots: string[]` 配置。聚合发生在唯一的后端实例内部：`listProjectDirs` 遍历所有根（可写根在前），`findLog` 以与主根相同的最高代与迁移规则跨根解析 id，`assertStoredIdentity` 接受 header 与路径在任一配置根下的对应关系。所有写路径仍然只指向 `root`——`create` 拒绝已存在于任一根下的 id，对只读根会话发起写打开会报错并指名两个根。同一会话 id 出现在多个根下会大声失败而不是任选一份。加载即拒绝缺失、不可读、重复或等于 `root` 的只读根，因为本后端从不创建这些根。seam 之上的消费者零改动：session-query、session-controller 与 Web UI 的列表/follow/chat/trajectory 路径原样获得挂载进来的会话。

随本功能交付两个运维配套（均在仓库外，`~/.dsh/profiles/web/`）：Web profile patch 把 bridge 存储挂载为只读根；`bridge-takeover.patch.yml` 是应急 `--patch` overlay，把可写根直指 bridge 存储——并显式清空 `readOnlyRoots`——仅供 bridge 守护进程已死、不再持有写锁时，从 Web UI 继续 bridge 会话。

## 备选方案

**把 bridge 存储软链进默认根。** 否决：列表扫描 `readdir({ withFileTypes: true })` 只保留 `Dirent.isDirectory()` 的条目，对符号链接为 false——挂载的会话会被静默忽略。

**两个守护进程共享或迁移到同一个根。** 否决：lease 模型假设每个进程对每个会话根只有一个活写者；运行中的 bridge 守护进程加一个 Web 进程共用一个根会引入所有权与投影缓存竞争，且在活写者之下迁移约 3000 个会话目录有崩溃风险。

**Web 客户端插件在 controller 之外旁路读取 bridge 存储。** 否决：要重新实现标准链路已有的列表、分页与事件流，并放弃现成的 chat/trajectory 渲染器。

**挂多个 persistence 服务实例。** 否决：`ctx.sessionPersistence` 是单一服务槽；在那个 seam 聚合要改动抽象服务契约与所有消费者，而这是后端内部的事。

## 后果

Web UI 把 bridge 会话（id 前缀 `cc-`）与本地会话并列展示，按各自 cwd 的项目目录分组；打开即通过标准渲染器重放其 JSONL 事件。v0 header 被格式 catalog 拒绝的会话（在案的 60% 弃用存量，如 `origin: 'oneshot'`）与在可写根下一样保持不可见——挂载不改变该裁定。bridge 的 subagent 会话保持既有的 `origin: 'subagent'` 侧栏隐藏行为。全量列表成本随目录总数增长：本机一次冷扫描实测 3156 个磁盘会话目录（列出 1826 个）耗时 1.8 s，且因后端无索引而每次 `list()` 重复——对控制面板的会话列表可接受，该基线记录在此供未来索引工作参考。profile patch 条目的 `config` 会整体替换 bundle 层配置，因此任何覆盖本插件的 patch 都必须重述 `root`（Web profile patch 用与 dsh-base 层相同的 `dshHomePath('sessions')` 表达式重述了）。

## 测试

`packages/session/session-persistence-jsonl/tests/readonly-roots.spec.ts`（8 例，经 `ctx.plugin` 的真实组合、真实临时根）：跨根列表；只读根 `stat` 与冷 `open('read')` 不改动产物；写打开拒绝并指名两个根、可写根不受影响；对只读根已有 id 的 `create` 拒绝；跨根重复 id 在 `list` 与 `open` 双双大声失败；已发布 v0 代可列出且字节不变；被 schema 拒绝的 v0 代与在可写根下一样被跳过；缺失、自身重复、与可写根重复的只读根配置在加载时被拒绝。全包套件（348 测试）不变通过。
