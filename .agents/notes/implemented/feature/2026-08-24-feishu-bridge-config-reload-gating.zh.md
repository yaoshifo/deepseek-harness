# Agent Note：feishu-bridge daemon 的配置改动统一经 /reload 生效

Status: implemented

[English](2026-08-24-feishu-bridge-config-reload-gating.md) | 中文

## 问题

`cordis.patch.yml` 的每次编辑都会经 Cordis 配置 HMR 即时热载：刷新在运行中的 daemon 里 dispose 并重建全部 engine 与 platform。这条重载路径屡次引发生产事故——静默丢新群消息的 WS 僵尸（2026-08-21）、多 project user-questions provider 冲突（2026-08-22）、以及曾误触 reload 退出通知的同 pid `apply()` 重跑——而且编辑器的中间保存每次都触发全量重载。daemon 本就有唯一一个刻意设防的生效点（`/reload`），配置应该搭它的车，而不是自行生效。

## 决策

三处配套改动，缺一不可：

1. **`DSH_CONFIG_HMR_DISABLED`**（任意非空值即关闭，`DSH_TELEMETRY_DISABLED` 同款语义）加在 `runProfile`（`apps/cli/src/profile-boot.ts`）：置位后启动器不挂兜底 watch-only HMR 服务、不注册任何 `watchUserPatches` 监视器（profile 层与 home 层都不挂），并打一条 info 日志——监视器没装上必须与「装失败」可区分。patch 层改动推迟到下次 boot。
2. **feishu-bridge bundle 禁掉 dsh-base 的 `hmr` 行**（`packages/acp/feishu-bridge/cordis.patch.yml`，headless 先例）。该模块 watcher 本只盯 profile 目录，但下面的 reload 前置校验会重写 profile 的 `cordis.yml` 根文件——模块 watcher 活着时 `include.refresh()` 会把这次重写当成配置变更、在 reload 飞行中热载旧 daemon（exit-notice 事故的同款触发形状）。不设环境变量的部署仍经启动器兜底保有配置 HMR，文档化热载契约在别处不受影响。
3. **`reload.sh` 重启前校验**：构建之后、任何 stop 之前，跑 `dsh --profile <name> --dump-config`（不 boot 只组合 patch 层，绝不会有第二个进程去连飞书）。坏 `cordis.patch.yml` 在旧 daemon 仍在运行时被拦截——它带着最后可用树继续跑，群里收到既有的 `/reload` 失败回复，也不会引发 systemd 崩溃循环。

`/reload` 本身零改动：重启本来就从磁盘重读配置，失败回复链（脚本非零退出的 `finish()`）早已存在。前置校验的已知局限：dump 模式不求值 `!!js`、不校验插件 schema、不解析插件名——这类错误仍只在重启后的 boot 暴露（fail-loud 退出、systemd 重试；修好文件即自愈）。

## 否决方案

**启动器监听改为全局 opt-in。** 破坏其它所有长驻 surface（web）的文档化即时编辑契约；开关是部署的选择，不该当产品默认。

**用真 boot 做前置校验。** 第二个 daemon 会给每个 app 开第二条飞书 WS 连接——正是僵尸事故记录的事件分裂隐患；`--dump-config` 不 boot 恰是为了避开它。

**在 stop 与 start 之间校验。** 那时磁盘上的配置已经坏了，「start」只会崩溃循环；旧 daemon 还活着时校验是失败后 bot 仍在线的唯一摆位。

**保留 HMR、靠运维纪律。** 没有强制力；事故史就是反例。

## 后果

配置编辑（profile yml、home yml）在 `/reload` 之前惰性，正合需求；重启仍会中断进行中的 turn（回滚到最后完整 turn）。reload marker 的同 pid HMR 分支（`reload-commands.ts`）在本部署成为不可达路径，作为防御逻辑保留。Loader 运行期写回 `cordis.yml` 不再热载任何东西（无人监听）。`reload-commands.ts`、i18n、快照零改动。

## 测试

`apps/cli/tests/config-hmr-switch.spec.ts`：空 bundle 临时 profile 的 REAL `runProfile` 启动——对照例在开关未设时观察到 patch 即时生效（同时证明编辑必须自包含：每次刷新把全部层重新应用到重读的空根上，只写 id 定位覆盖会告警且毫无变化）；开关置位时无兜底 HMR 服务、编辑保持惰性；开关置位且组合自带 `hmr` 行时服务存在、编辑仍惰性。红验证：只还原 `profile-boot.ts` 的开关改动时两条惰性用例失败。`reload.sh` 前置校验手工验证——临时 `DSH_HOME` 下坏 patch yml 使 `--dump-config` 退出码 1。文档：OPERATIONS.md §1.2/§3.3/§4/§5、systemd unit 模板、profile 模板头注释、MIGRATION.md D9、app-boot 双语 README。
