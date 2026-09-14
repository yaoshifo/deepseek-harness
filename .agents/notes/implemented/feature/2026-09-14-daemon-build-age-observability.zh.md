# Agent Note: daemon 构建年龄在 /status 与 reload 通知中可见

Status: implemented

[English](2026-09-14-daemon-build-age-observability.md) | 中文

## 问题

运行中 daemon 的代码身份不可见：被重建或新提交落下的 daemon 与最新的看起来完全一样，核查需要手工拼三处证据（进程起点、lib 文件 mtime、git 历史）。2026-09-14：落后两天的 daemon 冒充了已 reload——用户以为跑过 `/reload`，实际上一次是两天前；并行会话留下的新磁盘构建让目录看起来是新的。

## 决策

daemon 每次启动捕获一次构建身份（`src/engine/build-info.ts`，在插件启动 settle 中、`completePendingReload` 之前调用）：启动时刻、已加载插件 dist 文件与 daemon 入口（`process.argv[1]`）的 mtime、模块所在仓库的 git HEAD。在两个面渲染：

- `/status` 在既有模板文本后追加构建行：`构建: daemon <启动时刻> 启动 · lib <mtime> · HEAD <短sha>`；随后在磁盘构建新于已加载构建（mtime 差 >1s，提示 `跑 /reload 生效`）或 HEAD 越过捕获 sha（`+N 提交`，计数走 `git rev-list --count`，不可算时 `+?`）时追加漂移行。
- `/reload` 完成通知追加同一行——构建中途落地的提交会让刚重启的 daemon 立刻过时，通知正是说这件事的时机。

全部只读且 fail-soft：git 不可用时 sha 降级为 `-` 并去掉 HEAD 漂移行；文件 stat 不到降级为 `-`；未捕获（settle 之前）什么都不渲染。行模板走 i18n（`status_build*` 键，按表约定 en+zh）。

## 备选方案

**reload.sh 构建时写盖章文件。** 暂不采用：只覆盖 reload 驱动的构建（手工 `pnpm run build` + 重启会让它过期或缺失），且为边际精度引入跨进程契约。启动时 HEAD 在 reload 流程里是近距离代理（构建与重启相隔秒级）。

**每张完成卡页脚常驻 daemon 构建年龄。** 不采用：事故需要的是按需检查与 reload 时刻检查，不是常驻页脚；`status-footer` 的组装在逐回合热路径上。

## 后果

- 启动时 HEAD 近似所建提交：reload 流程下二者一致；构建开始到 daemon 启动之间落地的提交会高报（加载的代码可能早于捕获的 HEAD），脏构建树不反映。天花板记录在此；若实际咬人，盖章文件是升级路径。
- `/status` 与通知在既有路径上各加两次有界 git 调用（2s 超时）；daemon 启动在 settle 前多一次捕获（本地 `rev-parse` 毫秒级）。
- 非仓库部署（如有）显示 `HEAD -` 且永不出现 HEAD 漂移行；磁盘更新漂移仍然工作（纯 stat）。

## 测试

`tests/engine/build-info.spec.ts`：注入身份出摘要行；磁盘更新出 /reload 提示；亚秒 mtime 抖动被忽略；HEAD 前移出带计数的行；计数不可算降级 `+?`；捕获 sha 为空与实时 sha 不可用都抑制 HEAD 行；未捕获不渲染；`captureBuildInfo` 从真实模块路径填充、repo HEAD 与 git 实测对证。`tests/engine/commands.spec.ts`：/status 追加该行（漂移三行齐全）、捕获前保持沉默。`tests/engine/reload-commands.spec.ts`：完成通知仅在已捕获时携带构建行（既有精确相等的通知测试原样通过，钉住未捕获形态）。三个 spec 共 90 测试全绿；仓库 typecheck 绿。
