# Agent Note: lark 工具注册名为 `lark-cli` 并经官方内嵌 skills API 路由飞书业务域任务

Status: implemented

[English](2026-08-25-feishu-lark-cli-naming-and-skills-routing.md) | 中文

## Problem

桥的 lark 透传工具以 `feishu_bridge_lark` 之名落地：一个逐字透传 `lark-cli` 子进程、带按项目凭据路由的包装，但对 lark-cli 覆盖的 18 个飞书业务域没有任何指引。缺口有两层。其一是命名：官方 lark-cli 的 skill 正文、官方文档、CLI 输出通篇写 `lark-cli docs +fetch`，工具名迫使模型对读到的每一处引用做一次心智翻译。其二是指引：Claude Code 时代的 lark skill 迁移到 dsh 后没有对应物，agent 裸调工具、靠猜旗标操作——而 lark-cli 自带 28 个内嵌、经 agent 实测的 skills（`skills list` / `skills read <skill>[/<file>]`，go:embed 构建时打进二进制、与版本锁定），却没人被路由过去。

## Decision

工具注册名为 `lark-cli`（`src/tools/lark.ts`）——与官方 CLI 逐字一致，官方内嵌 skills 里的每处命令引用都字面映射到工具调用。这是对 dsh 原生工具 snake_case 命名惯例（`web_search`、`feishu_bridge_send`）的有意例外：注册表对名字无格式约束，MCP 工具名已广泛使用连字符，模型侧映射收益高于惯例。

工具 description 内嵌官方渐进式披露工作流：任何飞书业务域任务（docs、sheets、Base、calendar、mail、wiki、IM、tasks、approval、OKR…）先以 `["skills","list"]` 发现域，再以 `["skills","read","<skill>"]` 读该域指引，按需 `["skills","read","<skill>/references/<file>.md"]`——只读当前步骤需要的参考，绝不一次读完（lark-cli 自己的 SKILL.md 恰好如此要求）。description 随工具 schema 进每个模型请求，不新增 skill 文件、目录条目或 prompt 段；内嵌内容与所装 lark-cli 二进制版本自动同步，零维护成本。

## Alternatives considered

**切换到官方飞书 MCP（larksuite/lark-openapi-mcp）。** 否决：它是 Beta，README 写明硬缺口——不支持文件上传下载、不支持直接编辑云文档正文（仅导入与读取）——而 lark-cli 每周更新、覆盖 200+ 命令；其工具定义膨胀上下文（官方 FAQ 让用户用 `-t` 把工具数压到约 10 个以内）；还需要第二套 OAuth（`lark-mcp login --oauth`），与桥已有的按项目凭据路由重复。

**把 lark-cli 的 skills 挂成静态 dsh skill 文件（GitHub 检出或 `npx skills add`）。** 否决：拷出的快照在 lark-cli 升级那一刻就与二进制漂移；skill 正文假定 bash 调用，需要改写成工具透传；28 条目录描述膨胀每个会话的 skill 列表（官方 lark-cli issue 区恰有此抱怨）。内嵌 `skills list`/`skills read` API 才是官方为自研 agent 设计的按需通道。

**在桥的 bundled skills 目录里放一个薄壳引导 skill。** 否决为独立文件：工具 description 永远对模型可见，不占目录条目，承载同样的路由指令——薄壳 skill 只是重复它。

## Consequences

官方 skill 文本里每处 `lark-cli docs +fetch` 现在都按名字直接映射到工具调用。代价：「全准」的按工具权限记忆以 `(agent, tool)` 为键，用户需对改名后的工具重新批准一次；历史会话日志重放不受影响（记录的是当时实际使用的名字）。改名是有记录的惯例例外——若 dsh 日后引入工具名格式校验，`lark-cli` 需要显式豁免。

已知限制：skill 指引以 `@./xxx` 表达本地文件参数、以 lark-cli 子进程 CWD 为基准，而工具从守护进程 CWD spawn lark-cli；传本地文件路径的操作必须先解析为绝对路径。lark-cli 的每次运行 skills 提示器保持抑制（`LARKSUITE_CLI_NO_SKILLS_NOTIFIER`），因为路由提示已由 description 承担。

## Testing

`tests/tools/lark-tool.spec.ts` 断言新名下的注册与干净注销（HMR 安全）。feishu-bridge 全套：2379 通过。
