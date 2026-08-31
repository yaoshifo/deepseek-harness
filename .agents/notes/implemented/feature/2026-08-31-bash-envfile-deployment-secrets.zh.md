# Agent Note: envFile——bash 执行器的部署级 secret 注入

Status: implemented

[English](2026-08-31-bash-envfile-deployment-secrets.md) | 中文

## Problem

cc-connect 时代的 secret 架构（见 `~/.config/secrets-management-guide.md`）：`~/.zshenv` source `~/.config/secrets.env`，整棵进程树（含 agent 每次新起的 shell）自动携带全部 secret，配合 Go 侧 deny 规则拦截读文件与 `printenv`。迁移到 dsh 后该机制断开：`ctx.subprocess` 一律经 `scrubbedParentEnv()` 擦除凭据形状变量名（`/KEY|PASSWORD|SECRET|TOKEN/i`，`packages/subprocess/subprocess/src/index.ts:44`），agent 的 bash 命令拿不到 `*_API_KEY` 类变量；名字不含那四个词的（`*_SIG`、`*_WEBHOOK`、`*_ACCOUNT`、`*_URL`）反而照常透传。LLM 路由（credentials seam 的 `apiKeyEnv`）与 cron exec 作业（engine 原生 `spawn('sh', ['-c'])` 不过 scrub）各有自己的注入路径，三条路径互不一致。

## Decision

`LocalBashExecutor` 上一个可选 `envFile` Config 字段，指向操作者维护的 `KEY=VALUE` 文档（600 权限），其条目以原始名合并进每条命令的显式 env。这是 scrub 自身语义的部署级表达——「显式条目是 caller 的慎重选择所以幸存」（`ShellExecSpec.env` 的 seam 注释明文）——也符合仓库「deployment-varying choices 是 validated Config fields」惯例。`SandboxBashExecutor` 以 `export type Config = LocalConfig` 整体继承（`packages/shell/bash-sandbox/src/index.ts:35`），一处改动覆盖沙箱与非沙箱两条执行路径。

### 热加载粒度 = 每条命令

文件读取放在 `spawnSpec()`（`run()`/`start()` 每次调用各走一次）：改值、追加键、删行都在下一条命令生效，同一回合内亦可，无需 `/reload`。已在运行的后台进程 env 在 spawn 时刻固定（进程语义）。`envFile` 路径本身在 cordis.patch.yml 变更仍需 `/reload`。对照：systemd `EnvironmentFile`（LLM 路由、cron exec 用）仍需 daemon 重启。

### 分层与 fail-loud

合并序 `{ ...ENV_OVERRIDES, ...envFile, ...spec.env, ...spec.dshEnv }`：终端覆盖 < 文件 < 调用方显式 < 受信 `DSH_*`。构造时读一次校验（缺失/坏行/空值 → 插件加载失败指名行号；空值拒绝，防手滑发布空 secret）；运行中文件消失 → 该条命令响亮失败。解析语义与 `~/.zshenv` 的 `IFS='=' read` 对齐但更严：首个 `=` 分割（值可含 `=`）、跳过空行与 `#` 注释、坏行抛错。

### 暴露面定性

条目对命令可见即对模型可见——与 cc-connect 同级（`printenv`/`echo $X` 从来拦不住，deny 规则拦的只是读文件）。因此部署把该文件当评审白名单：feishu-bridge 部署指向专用 `~/.config/agent-secrets.env`（文件即白名单），而不是全量 `secrets.env`。新凭据消费方的选择口诀是「谁发起带凭据的调用」：harness 发起的调用走配置引用（`apiKeyEnv`、MCP headers）；harness 替模型代跑的专用工具在自己的 spawn 边界做逐子进程注入（lark-cli 工具）；只有 agent 的任意命令才落到 envFile。工具式安全的来源是面窄——窄面工具不提供能回显凭据的动词——因此不存在「带凭据跑任意命令」的通用包装工具：那是换皮的 envFile，安全收益为零。真正的隔离（模型完全看不到值）只能是 harness 侧消费（`apiKeyEnv`、MCP headers）——新增集成优先走各自的 seam，而不是往 bash env 里塞。

### 白名单的模型可见性

配置了 `envFile` 且组合了 system-prompt 服务时，执行器注册一个 boot 固定小节（`bash:env-file`）：声明这些条目是逐命令的受信注入、在 daemon 进程环境中缺席属预期、值永不回显；当前键名搭载在每次 spawn 重建的 `DSH_ENVFILE_KEYS` 标记里。动机：2026-08-31 dida 群会话在首次使用前花了十条工具调用考古注入机制（「tool-shell 有、daemon 无」）——预先声明直接回答来源问题。已否决备选：`ShellExecutor` seam 方法 + tool-bash 描述行（为一句话跨三个包）；按会话键的首触结果注记（按需付费，但引入运行时状态、逐命令匹配与结果文本改写，而静态小节经前缀缓存摊薄后成本近零）。

## Alternatives considered

- **shellEnv 贡献者插件**：走受信 `DSH_*` 注册表，但键名强制前缀改写（存量脚本 `os.getenv("VOLCENGINE_ACCESS_KEY")` 全要改名）、键集注册时固定（新增键要 `/reload`）、还要新包全套仪式。UX 全面劣于 envFile。
- **BASH_ENV 逃生舱**：`bash -c` 会 source `$BASH_ENV`，零代码且原始名保留，但隐式绕过 scrub、无加载期校验、全量无白名单。

## Consequences

agent 的 bash 命令重新获得 cc-connect 的「人管值、agent 管名字」工作流且保留原始变量名，热加载粒度还细于 cc-connect（逐命令、含追加键，systemd 层则要 daemon 重启）。代价：条目对模型可见是构造性事实，白名单纪律落在部署侧的文件收编上；fork 在上游热文件 `bash-local` 上多了一小段增量改动，直到 envFile 提上游；三条注入路径仍然机制各异（本 note 的 Problem 段即路径地图）。

## Deferred

- 上游提案：envFile 稳定后按 fork 二开原则提 upstream（自然的 Config 字段）。
- 半凭据透传缺口（`*_SIG`/`*_WEBHOOK`/`*_ACCOUNT` 经 ambient 直达 agent 命令）与「agent 可直接读 secrets 文件（沙箱只管写效应）」是独立遗留问题，见部署侧记录。
