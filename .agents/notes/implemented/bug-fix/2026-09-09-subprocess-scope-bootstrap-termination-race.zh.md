# Agent Note：落在 scope bootstrap 窗口内的终止按送达信号结算

Status: implemented

[English](2026-09-09-subprocess-scope-bootstrap-termination-race.md) | 中文

## 问题

`times out and kills a backgrounded grandchild` 在满载全量跑时偶发失败、复跑通过。窗口就是 scope bootstrap——从 spawn 到 runner 消费其 launch request（tsx 下数百毫秒）——在其中触发的超时中止或 disposal 撞上两个叠加缺陷。其一，`directOutcome` 把所有未消费 request 的退出都变成启动失败拒绝（"subprocess scope exited before its bootstrap consumed the launch request"），即便退出携带的是我们自己的终止信号，cron 超时路径于是抛出原始启动错误而非超时分类。其二，在 systemd 尚在收尾启动时清空 scope cgroup 的 kill 会让瞬时 scope 卡在零任务的 `active` 状态（systemd 丢弃启动期间到达的空 cgroup 事件）；`rangeActive()` 随后永远报告范围存活，`waitForExit()` 永不结算，主机上累积空卡 scope（发现 14 个；在役 daemon 自己的 scope 已排除且未触碰）。在有 systemd 的主机上，「spawn 后立即终止」确定性地命中该竞态，这正是 `disposal kills still-running processes and awaits their exit` 在此类主机上一直失败的原因。

## 决策

bootstrap 窗口内的信号退出按该终止结算，它可能留下的空 scope 被释放而非继续等待。两半均已由上游落地（提交 b79a227cec）：当 launcher 退出携带本 owner 自己投递的信号（记于 `terminationSignals`）且 launch request 未被消费时，`LinuxScopeStartup.resolveOutcome` 返回该结果；不携带信号的未消费退出仍保持启动失败拒绝。残留的空 cgroup 由 `emptyRange()` 判定——已请求终止、客户端已离开、管理器报告的零任务数——并由 `releaseEmptyRange()` 停止该瞬时 unit，而不是推断其已停。另见同一调查落地的 [exec 边界 stdio 修复](2026-09-09-subprocess-scope-runner-nonblocking-stdio.zh.md)，该修复仍为 fork 本地。

## 备选方案

- **在结算层（`bindManagedProcess`）把 bootstrap 窗口的所有拒绝统一改写为终止：** 否决——它看不到 launcher 是否被信号杀死，会把真正的 runner 失败（错误 cwd、ENOENT）改写成干净的终止，且需要该层并不拥有的平台特定信号语义。
- **超时 kill 前等待 request 被消费：** 否决——崩溃的 runner 永不消费；超时必须及时终止，而不是挂在 bootstrap 进度上。

## 后果

- 落在 bootstrap 期间的 cron 超时报告 `timed out`；disposal 及时结算；卡死 active scope 无法再拖住 `waitForExit()`。
- 行为变化更新了两个断言旧窗口产物的测试：`local.spec.ts` 的竞态 teardown 用例现在断言送达信号（其兄弟用例仍钉住非竞态的 spawn 失败拒绝），`linux-scope.spec.ts` 的建立前取消用例同样更新。
- 有 systemd 的主机上 `local.spec.ts` 仍有两个失败（`releases a terminal after top-level exit reaches quiescence`、`retains a terminal whose automatic cleanup fails`）：它们 mock 了 `node-pty` 却没 mock `prepareLinuxTerminalScope`，于是真实 scope 启动跑在假终端上。属既有测试环境耦合，本修复未改变，在无用户管理器的 CI 容器中为绿。
- Windows Job runner 存在类似的 bootstrap 窗口（目标启动前的 IPC 消息）；未做检查，维持现有语义。
