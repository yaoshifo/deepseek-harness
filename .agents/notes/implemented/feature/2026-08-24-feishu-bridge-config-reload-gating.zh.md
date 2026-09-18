# Agent Note：feishu-bridge daemon 的配置改动统一经 /reload 生效

Status: implemented

[English](2026-08-24-feishu-bridge-config-reload-gating.md) | 中文

## 问题

`cordis.patch.yml` 的每次编辑都会经 Cordis 配置 HMR 即时热载：刷新在运行中的 daemon 里 dispose 并重建全部 engine 与 platform。这条重载路径屡次引发生产事故——静默丢新群消息的 WS 僵尸（2026-08-21）、多 project user-questions provider 冲突（2026-08-22）、以及曾误触 reload 退出通知的同 pid `apply()` 重跑——而且编辑器的中间保存每次都触发全量重载。daemon 本就有唯一一个刻意设防的生效点（`/reload`），配置应该搭它的车，而不是自行生效。

## 决策

两处配套改动，缺一不可：

1. **feishu-bridge bundle 禁掉 dsh-base 的 `hmr` 行**（`packages/acp/feishu-bridge/cordis.patch.yml`，headless 先例）。该行是配置监听的唯一所有者——启动器自己不挂任何监视器——因此这一行被禁用就是全部冻结：patch 层改动推迟到下次 boot 生效。它的模块 watcher 本只盯 profile 目录，但下面的 reload 前置校验会重写 profile 的 `cordis.yml` 根文件——模块 watcher 活着时 `include.refresh()` 会把这次重写当成配置变更、在 reload 飞行中热载旧 daemon（exit-notice 事故的同款触发形状）。删除该行的部署则回到 Cordis HMR。
2. **`reload.sh` 重启前校验**：构建之后、任何 stop 之前，跑 `dsh --profile <name> --dump-config`（不 boot 只组合 patch 层，绝不会有第二个进程去连飞书）。坏 `cordis.patch.yml` 在旧 daemon 仍在运行时被拦截——它带着最后可用树继续跑，群里收到既有的 `/reload` 失败回复，也不会引发 systemd 崩溃循环。

`/reload` 本身零改动：重启本来就从磁盘重读配置，失败回复链（脚本非零退出的 `finish()`）早已存在。前置校验的已知局限：dump 模式不求值 `!!js`、不校验插件 schema、不解析插件名——这类错误仍只在重启后的 boot 暴露（fail-loud 退出、systemd 重试；修好文件即自愈）。

## 否决方案

**全局默认冻结监听。** 破坏其它所有长驻 surface（web）的文档化即时编辑契约；禁用的 `hmr` 行是部署的选择，不该当产品默认。

**用真 boot 做前置校验。** 第二个 daemon 会给每个 app 开第二条飞书 WS 连接——正是僵尸事故记录的事件分裂隐患；`--dump-config` 不 boot 恰是为了避开它。

**在 stop 与 start 之间校验。** 那时磁盘上的配置已经坏了，「start」只会崩溃循环；旧 daemon 还活着时校验是失败后 bot 仍在线的唯一摆位。

**保留 HMR、靠运维纪律。** 没有强制力；事故史就是反例。

## 后果

配置编辑（profile yml、home yml）在 `/reload` 之前惰性，正合需求；重启仍会中断进行中的 turn（回滚到最后完整 turn）。reload marker 的同 pid HMR 分支（`reload-commands.ts`）在本部署成为不可达路径，作为防御逻辑保留。Loader 运行期写回 `cordis.yml` 不再热载任何东西（无人监听）。`reload-commands.ts`、i18n、快照零改动。

## 测试

`packages/acp/feishu-bridge/tests/bundle-patch.spec.ts`：把 dsh-base 的 patch 列表与桥自己的 bundle patch 依次组合，断言 base 的 `hmr` 行仍是 `disabled: true` 且无告警——上游若改行 id，桥的这条条目会告警并跳过、静默重新武装配置 HMR。同一套件还 pin 住 plan-mode 段的 lockstep。`reload.sh` 前置校验手工验证——临时 `DSH_HOME` 下坏 patch yml 使 `--dump-config` 退出码 1。文档：OPERATIONS.md §1.2/§3.3/§4/§5、systemd unit 模板、profile 模板头注释、MIGRATION.md D9、app-boot 双语 README。
