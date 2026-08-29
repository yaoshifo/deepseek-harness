# Agent Note: feishu-bridge 以隔离 provider 自动挂载自带 skills

Status: implemented

[English](2026-08-24-feishu-bridge-bundled-skills-mount.md) | 中文

## Problem

包内自带 `skills/` 目录——桥接专属 skill（`feishu-bridge-subtask`、`feishu-bridge-chatroom-moderator`、`feishu-bridge-render`）加上部署的工作风格 skill（`tdd`、`skillify`）——但插件本身没有任何通路让它们可达。每个部署都必须在自己的 live profile 的 `skill-filesystem.customSkillDirs` 里手写包路径，而且遗漏是无声的：dev 服务器的 profile（连仓库自带的 `profile/cordis.patch.yml` 模板都）从未写过这一条，于是 9 个 dev bot 一直没有 subtask/chatroom skill，而 hint 按钮却仍然摆着 `/tdd` 和 `/skillify`。手写路径在结构上也很脆：绝对路径、机器相关，而且 patch 层配置按键整体替换，后续任何一次 `customSkillDirs` 编辑都可能再次无声丢掉它。

## Decision

`packages/acp/feishu-bridge/src/index.ts` 的 `apply()` 经 `mountBundledSkills()` 挂载第二个、隔离的 skill-filesystem 实例：

- `ctx.plugin(SkillFileSystem, { providerName: 'feishu-bridge-skills', includeDefaultRoots: false, customSkillDirs: [<包>/skills] })`。隔离 provider 只看自己的显式根——`includeDefaultRoots: false` 正是 skill-filesystem 为多 provider 部署既有的约定——因此绝不会重新发现项目根、用户根或环境变量 bundled 根。
- 目录从 `import.meta.url` 计算（`dirname() + '../skills'`），源码运行（`src/`）与 tsdown 打包的 `lib/index.js` 解析到同一个包根，零部署侧路径。`package.json` 的 `files` 带上 `skills/`，发布安装同样生效。
- bundled 根落在 custom rank（300）：项目 `.dsh/skills` 与 `.agents/skills` 条目保持更低的 rank 并覆盖同名 bundled skill，与注册表的优先级语义一致（[skill system](2026-07-05-skill-system.zh.md)）。
- 挂载是子 fiber：销毁 feishu-bridge fiber（HMR 重载）即注销 provider 并关闭其 watcher；skills 目录保持 chokidar 监视，编辑 bundled skill 文件即热刷新目录。

部署侧的 `customSkillDirs` 继续承担用户级 skill 根（`~/.claude/skills` 等）；Mac live profile 的手写包路径条目在本次改动中一并删除，避免两个 provider 之间的同名重复告警。

## Alternatives considered

**继续每个部署手写 `customSkillDirs`。** 即本笔记淘汰的现状：dev 服务器已经证明遗漏容易且无声，而且这条路径要在每个 live profile 里永远重复维护。

**复用 `DSH_BUNDLED_SKILL_DIR`。** 该环境变量是应用级 bundled 根通道（web app 在用）；一个进程只有一个 bundled 根，插件占住它会与宿主应用自己的 bundled skills 冲突，且只对抢到的一方生效。

**像 `dsh-skill-badge` 那样做专用打包 provider。** [badge 决策](2026-08-06-bundled-dsh-badge-skill.md)用一个专门构建的 provider 包注册单一不可变 skill。桥接的 skills 是一目录可编辑的 Markdown 文件，需要 frontmatter 解析、目录资源基址与热监视——正是 skill-filesystem 已有的能力——所以用独立 `providerName` 把它作为隔离实例组合进来，复用既有机制而不是复制一个解析器。

## Consequences

每个 feishu-bridge 部署零配置即得桥接 skills，失败形态从「无声遗漏」变成「不可能」。这些 skill 以 provider `feishu-bridge-skills`、source `custom` 出现；provider 标签只是目录元数据（目录型 skill 的资源提示从基址路径渲染，模型可见文本不变）。代价：插件新增对 `@deepseek-ai/dsh-skill-filesystem` 的运行时依赖（每个 base 组合里本就存在），仍手写包 skills 目录的部署会收到同名重复告警，直到删掉手写条目。

## Testing

`tests/bundled-skills.spec.ts` 起真实 Cordis context 与 skill 注册表，断言包内 skills 经隔离 provider 出现、销毁挂载 fiber 即注销（注册表贡献的 HMR 安全规则）、同名注册可以压过 bundled 条目。feishu-bridge 全套：2285 通过。
