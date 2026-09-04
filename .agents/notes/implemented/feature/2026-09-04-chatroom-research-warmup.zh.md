# Agent Note：研究助手从预热的环境起步，不再从零开始

Status: implemented

[English](2026-09-04-chatroom-research-warmup.md) | 中文

## Problem

每次 `/chatroom --research` 启动都只给共享 uv venv 装硬编码的四包清单，其余全靠助手现场重学。三个具体断点均已实证：(1) `uvHooks.pipInstall` 装不钉版本的 `pandas`，而 akshare 的依赖声明只写 `pandas>=2.0.0`——PyPI 最新已是 pandas 3.0.5 且会破坏 akshare，下一次工作区重建（`小米` 工作区归档时被整删，venv 一并消失）会在第一天就默默坏掉；(2) `uv venv` 默认不带 pip，而助手 preamble 教的是 `-m pip install`——新 venv 首日该命令直接失败，要靠模型自己 ensurepip 自救（生产 venv 里的 pip 26.0.1 就是助手补装的）；(3) 已验证的机器经验——本机东财端点被墙所以 akshare 走新浪源、FRED 无 key CSV、披露易/EDGAR/DI 端点、公告 PDF 用 pdfplumber——只散落在各工作区的 `DATA_LEDGER.md` 里，归档时随工作区一起删除。

## Decision

三个接缝，全部配置驱动（部署差异不进插件源码）：

- `researchVenvPackages`（chatroom 配置）：共享 venv 的基础包清单。代码默认值钉 `pandas<3`——akshare 缺上限是生态事实，不是机器偏好。`ensureResearchPythonEnv` 改用 `uv venv --seed` 建 venv（首日即有 pip），并对已存在的 venv 按配置清单对账：marker（`.dsh-base-packages.txt`，放在 venv 内——删 venv 即删 marker）里缺的包增量补装，助手自装的包不动。后续扩充配置清单，下一次研究启动自动热升级现网 venv。
- `researchPlaybook`（chatroom 配置）：稳定 playbook 路径，位于可归档的研究工作区之外。`decorateSessionStartOptions` 沿 venv 先例把它放上 `SessionStartOptions.playbook`（仅研究助手会话）；研究助手 preamble 新增「先读、只追加」条目——与台账同款尾追加纪律——外加 uv 优先装包指引（`uv pip install --python <venv> …`）与学术检索走 scholar skill 的路由。preamble 里硬编码的四包措辞删除。
- 研究角色 persona 的共享环境句同步改为 `uv pip install` 措辞。

## Alternatives considered

- **把机器打法硬编码进 preamble 文本。** 否决：主机特有事实（被墙端点）不属 fork 插件源码，且每次修改都要发版；playbook 是用户可直接编辑的文件。
- **把 playbook 种子拷进每个研究工作区。** 否决：`小米` 先例——归档整删工作区、venv、台账与种子一起消失。playbook 放稳定路径才能幸存。
- **启动时预拉常用数据集。** 否决：台账新鲜度纪律要求当天抓取才算可复用；按议题的管家预取已覆盖需求。playbook 的端点速查让这些抓取又快又准，这才是正解。

## Testing

`engine-chatroom-venv.spec.ts`：经 exec 缝观察真实 createVenv/pipInstall 参数表（`--seed`、配置的包、marker 写入）、增量对账（marker 缺项恰好只装差量并吸收、最新 venv 零安装），既有幂等/失败套件不变。`adapter-persona.spec.ts`：playbook 条目随配置出现/消失、uv 优先措辞、硬编码包清单消失、scholar 引导。`engine-chatroom-venv.spec.ts` 的 `buildSessionStartOptions`：playbook 只装饰研究助手会话。`chatroom-config.spec.ts`：两字段的默认值、覆盖与 `~` 展开。`chatroom-persona.spec.ts`：研究角色契约里的 uv 措辞。

## Consequences

venv 对账在每次 `/chatroom --research` 启动时跑，仍在既有 `researchVenvChain` 串行内——并行场可能排在一次性的差量补装后面（受 300s 安装超时约束），而不是直接失败。playbook 文件缺失/不可读不致命：装饰省略该条目、会话照常（配置指向的是用户维护的文件，晚出现是合法的）。preamble 的 playbook 条目为每个助手会话的稳定前缀加一行；playbook 正文按需 Read，不注入。两个新字段默认关闭/不变，未扫过的配置行为与从前逐字节一致。
