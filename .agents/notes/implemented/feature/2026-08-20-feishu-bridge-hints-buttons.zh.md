# Agent Note: feishu-bridge hints 快捷提示按钮

Status: implemented

[English](2026-08-20-feishu-bridge-hints-buttons.md) | 中文

## 问题

Go cc-connect 把三个全局配置组——`hints`、`hints_with_param`、`hints_common`——渲染为快捷提示按钮：compact 按钮折进完成卡的信息面板、每条参数 hint 一行「按钮+输入框」、common 按钮常显卡片底部，全部按持久化的点击频率排序，另有 `/hint` 卡片。M4-E 装配清查把整个 hints 面归入 C 类「引擎机制未移植」，`buildStatusFooterElements` 一直没带它——用户迁移过来的配置在任何卡片上都变不出按钮。

## 决策

`src/engine/hint-usage.ts` 移植 Go `HintUsage`（write-through JSON 落 `<dataRoot>/hint_usage.json`，频率降序稳定排序）。一处有意偏离：Go 的 load/save 只往返 `hints` 与 `hints_with_param`，静默丢掉 `hints_common` 计数；TS 存储三类全持久化。`src/engine/hints-panel.ts` 移植 `hintButtonName`/`ParseHintButtonName`（hint 文本 base64url 编码进 form 按钮名——Feishu form_submit 回调不带 action.value——超 95 字符回退 FNV-1a 哈希 + 进程生命周期反查表，与 Go `sync.Map` 同构：daemon 重启后旧卡上的哈希长按钮在两种实现里都不可解码）与三个元素构建器。两处 Node/Go 差异需显式处理：`Buffer.from(x, 'base64url')` 对非法字符静默跳过而 Go 解码器报错，故 `parseHintButtonName` 再编码校验、拒绝非规范名；Feishu 卡 schema 2.0 拒绝无提交后裔的 form（错误 300123），这正是当初移除页脚 form 包裹的原因——现在仅在配置了 hints 时恢复包裹，折入的 form_submit hint 按钮满足 schema。Go 在完全空页脚状态上的早退保持不变：hints 只搭载已有内容（workdir、usage、时长）的页脚，从不单独渲染。

`status-footer.ts` 先把面板元素并入 collapsed 再包 `status_footer_form`；common 按钮追加 `hints_common_form`。`feishu/platform.ts` 在空值分支解码 `hint__` 名，经 `setHintClickHandler` 上报点击（engine `start()` 接到共享 `HintUsage.increment`），`cmd:` 分支拼接 `_arg` 定位的表单输入（兜底首个非空字符串）并回显最终命令文本。`/hint` 渲染独立卡片或编号文本列表。配置位于插件顶层（`hints` / `hints_with_param` / `hints_common`，对齐 Go 全局 toml 键），`apply()` 跨引擎共享一个 `HintUsage`。

## 备选方案

**per-project hints 配置。** 否决：Go 在 `wire.go` 里对每个引擎全局接线三组列表，共享点击计数也只在进程级有意义。

**持久化哈希名映射以跨重启。** 否决：保持 Go 的内存语义少一个存储文件；损失窗口只是上次重启前旧卡上的按钮，且仅限编码名超 95 字符的 hint。

## 后果

完成卡、`/new` 卡与 `/hint` 都带按钮；点击跨项目按频率重排三组并跨重启保留。完成卡上的按钮作为普通用户消息在同会话分发，hint 与手敲命令不可区分（含 plan 模式审批流）。

## 测试

`tests/engine/hint-usage.spec.ts`（计数、稳定排序、三类持久化、损坏文件）、`tests/engine/hints-panel.spec.ts`（名字编解码含超限哈希路径与非法名拒绝、元素结构、频率排序）、`tests/engine/status-footer.spec.ts`（form 包裹面板合并、common form、空态早退）、`tests/feishu/card-action.spec.ts`（名字分发、`_arg` 提取与兜底、回显、点击上报）、`tests/engine/commands.spec.ts`（`/hint` 卡片、文本回退、空提示）、`tests/assembly-config.spec.ts`（配置接线、共享实例）。开发虾真机冒烟：`/hint` 卡与真实完成卡均渲染三组；按钮点击由用户抽查。
