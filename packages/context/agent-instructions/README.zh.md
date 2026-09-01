---
description: "面向用户与维护者的工作区指令上下文说明，用于启用、设置预算或排查 AGENTS.md/CLAUDE.md 的加载与刷新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-instructions

[English](README.md) | 中文

## 概述

`dsh-agent-instructions` 将兼容 `AGENTS.md` 的工作区指令文件加载到模型上下文：用户全局文件与项目指令链作为一条持久基线进入第一次请求，成功的 `read`、`write` 或 `edit` 调用会把新出现的嵌套文件、变更与移除带入后续请求。它随默认 `dsh-agent-spine-demo` 组合包发布并默认启用，可通过组合包配置禁用。一切内容都受字节预算约束：较宽泛的文件先被省略，最具体的文件最后被截断，空指令链不产生任何内容。没有文件 watcher——外部编辑会在下一次成功的文件系统 touch 时，或恢复后的会话对账其基线时变得可见。指令文件内的 `@path/to/file` 引用会把该文件的内容导入指令，遵循 Claude Code 记忆文件 import 语义。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent（智能体）需要依据工作区自身的指令文件工作时，挂载此插件。默认 spine 组合包已包含它并给予 65,536 字节预算，因此大多数组合只需调整 `maxBytes`；没有文件系统提供方的树加载不到任何内容，直到提供方出现。

### agent 获得的内容

第一次请求包含一条持久基线消息：先是用户全局 `$DSH_HOME/AGENTS.md`，再按从宽泛到具体的顺序包含项目指令链——从项目根目录到会话工作目录的每个目录中所有现有候选文件。去除空白后内容一致的同级文件只渲染一次，因此复制了 `AGENTS.md` 的 `CLAUDE.md` 不会被重复加载。当成功的 `read`、`write` 或 `edit` 调用到达更深的目录后，下一次请求会包含新适用的指令文件；已改变的文件会替换其内容，消失或成为较早候选文件重复项的文件会产生移除通知。

### 用 `@path` 导入其他文件

任何候选文件都可以用 `@path/to/file` 引用其他文件；被引用的内容在引用处导入指令，包裹在 `Imported from:` 与 `End imported from:` 标记行之间。相对路径相对包含引用的文件所在目录解析，`~/` 前缀路径相对操作系统 home 目录解析，绝对路径加载已挂载文件系统提供方允许的任何文件。行内代码 span 与 fenced code block 内的引用保持字面，因此 `` `@README` `` 只提及路径而不导入。被导入文件可以继续导入其他文件，最多四跳；无法加载或超出深度的引用渲染为一行 `[instruction import unavailable: <path>]`。每个被导入文件在 `maxSourceBytes` 下读取，其内容与其他指令文本一样计入 `maxBytes`。用 `read`、`write` 或 `edit` touch 一个被导入文件，会在下一个请求刷新引用文件所属 scope，与直接编辑引用文件完全一致。

### 配置

默认设置适合典型检出：`.git` 标记项目根目录，`AGENTS.md` 与 `CLAUDE.md` 是基础候选，`AGENTS.local.md` 与 `CLAUDE.local.md` 是叠加的本地 overlay。只有 `maxBytes` 必填——它限制完整渲染后的基线，让每个部署显式选择自己的提示词预算。

```yaml
- name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
```

受支持的字段一览：

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  maxBytes: number
  maxSourceBytes?: number
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  candidateSelection?: 'all-existing' | 'first-existing'
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 完整渲染基线消息的上限，单位为字节 |
| `maxSourceBytes` | `1048576` | 渲染前单个源指令文件的上限 |
| `projectRootMarkers` | `['.git']` | 标记项目根目录的目录名 |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | 每个项目目录中加载的基础文件名 |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | 在基础文件之后加载的本地 overlay 文件名 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 存放用户全局 `AGENTS.md` 的目录 |

`candidateSelection` 为两个列表选择同一套每目录规则，默认 `'all-existing'`，即上文的全量加载行为。设为 `'first-existing'` 时，每个目录在一份列表中至多贡献一个文件：加载配置顺序中最早现存的候选文件，后续同级文件无论内容如何都保持压制——配置 `['CLAUDE.md', 'AGENTS.md']` 时，同时持有两个文件的目录只渲染 `CLAUDE.md`，只有 `AGENTS.md` 的目录仍渲染 `AGENTS.md`。协调遵循同一规则：删除首选候选会把下一个现存同级文件提升上来，新建首选候选会移除此前加载的同级文件。用户全局文件从不参与候选选择。

用户全局文件始终是 `$DSH_HOME/AGENTS.md`，没有本地 overlay；两个候选列表只控制项目 scope。`$DSH_HOME` 默认为 `~/.dsh`，已配置的 `~`、`~/...` 与 Windows 风格 `~\...` 前缀会基于操作系统 home 目录展开。非正数或非有限渲染预算会同时禁用基线与动态加载；已配置 `maxSourceBytes` 必须是正整数。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-instructions)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 观察预算

渲染会优先保留最具体的文件：先丢弃完整的较宽泛文件，再截断最具体的文件，并发出可见的 `Workspace instruction budget ...` 通知，指名被省略与被截断的路径。渲染后的字节数绝不超过 `maxBytes`。超出预算的宽泛文件会被忽略；刷新期间它被视为暂时不可用，而非被移除。

## 状态与刷新

模型可见文本不含隐藏状态标记。每个基线或动态上下文事件改为携带带类型的 `agent-instructions` 来源，其中包含 `{ action, scope, path, digest? }` 变更列表；完整基线还会携带 `baseline: true`，以及从规范化的发现、优先级、选择规则和预算配置派生的 `baselineIdentity`。匹配的持久 `user/message` 会确认已排队基线及其候选版本。进入步骤的 pre-step 会等待所有已排队投影完成，再把新组合的上下文折入最终批次，位置紧随已领取的消息，并移除 inbox 中仍待处理的副本；若被拒绝，当前上下文则继续排队。若监听器改写掉已领取的 workspace 消息，又没有让替代消息进入，后续边界会重新组合当前上下文。即使后续复合结果被拦截，成功的嵌套文件 touch 也会聚合到父级执行 token 下；顶层结果会将这些 touch 交给当前打开的会话步骤，或直接交给逐 agent 投影队列。`step/end` 只会在自身边界进入持久历史后释放其暂存的 touch；串行投影会根据可见会话事件和当前 inbox 协调状态，再替换唯一一条待处理工作区上下文。

路径与 SHA-1 内容 digest 都未变时，不会重复注入。digest 覆盖实际渲染的 import 展开后内容。每会话、每 scope 提供方 cache 只存储 `{ path, version, digest, trimmedDigest, imports? }`：当提供方的不透明 `FsVersion` 与有效可见状态都匹配时，对账会跳过内容读取；版本改变会在任何模型可见更新之前触发有界读取与 SHA-1 确认。展开过 import 的 scope 会在 `imports` 中记录被导入文件的绝对路径；touch 其中任何一个被导入文件都会跳过该快速路径——即使引用文件自身的版本未变——因此变更的 import 会替换渲染内容，未变的 import 不注入任何内容。`trimmedDigest` 是针对去除空白后内容的 SHA-1，也是每目录重复 key，因此较早候选文件与某个未更改文件的内容收敛后，后者仍可被移除。恢复可行，因为 SHA-1 状态持久化在带类型的来源中，而空的内存版本 cache 只会导致一次确认读取。压缩（compaction）会在 scope 的上下文事件离开可见表层后重新启用它，即使缓存版本未变。移除是 tombstone，因此候选文件之后重新出现时会重新加载。模型可见变更只有在对应文件专属段落保留至少一个内容字节，或原始内容确实为空时，才会进入来源、pending 状态和版本 cache。只要任一内容字节保留下来，部分截断就会记录完整内容的 digest；截断到零字节则仍可在后续 touch 处理，而相同 digest 的版本刷新只更新提供方 cache。基线即使带空变更列表，仍可发布字节预算诊断。动态批次若没有可提交变更，则完全不注入，并在后续 touch 时重试。

初始基线事件自身不会被改写。其带类型的变更仅在该事件仍位于可见会话表层时才是权威状态。当压缩遮蔽该事件时，下一次进入步骤的 pre-step 会组合当前基线，并在同一请求中记录它；也可以改由一次成功的文件系统 touch 重新添加未变的基线 scope，或追加其替换或移除。内存中的 scope 标记和提供方版本 cache 只负责选择探测对象并加速探测。恢复或插件热重挂后的第一次 pre-step 会保留兼容的可见基线，并将它与当前完整渲染所保留的文件进行比较。未变化和被预算省略的文件不追加任何内容；agent 离线期间新增、编辑、移除或不再属于预算保留集的文件会追加 `set`、`replace` 或 `remove` 转换。不兼容的可见基线会被一条完整的当前基线取代；如果没有候选文件，这条当前基线会是显式空基线。没有文件 watcher，因此磁盘变更会在下一次成功 `read`、`write` 或 `edit` touch 时可见，也会在恢复后的会话对账其基线时，或进入步骤的 pre-step 恢复被遮蔽的基线时可见。

## 作用域抑制

插件挂载 `agentInstructions` 服务；在 agent 的 setup 作用域里调用 `ctx.agentInstructions.suppress()`，会为该 agent 静默整条注入通道：不再组合基线、文件系统 touch 不注入任何内容、inbox 中待处理的工作区上下文也会被移除。它服务于整体替换 persona 的组装场景——这类会话不该让 cwd 祖先目录的指令文件随 user 消息搭车进入。注册可叠加；全部 disposer 执行后恢复注入。在无作用域上下文上注册的标记会抑制所有 agent；由外层作用域注册的标记会抑制其全部后代 agent。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件背后的设计决策；可观察行为见[使用本包](#use-this-package)。

### 设计理念

该插件建立在一个原则上：工作区指令是持久的对话内容，按 agent 与会话分别归属。基线消息与刷新消息都是普通的带来源 `user/message` 事件，因此与其他历史一样可回放、可压缩、可恢复，模型可见状态总能从会话日志重建。插件拥有完整的 `<system-reminder>` 框架，每条注入消息都原样到达模型。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器、`tools/result` touch 跟踪、inbox 组合 |
| [`src/config.ts`](src/config.ts) | `Config` schema、预算解析、基线标识 |
| [`src/files.ts`](src/files.ts) | 候选发现、项目根搜索、有界流式读取 |
| [`src/imports.ts`](src/imports.ts) | `@path` 引用解析与递归 import 展开 |
| [`src/render.ts`](src/render.ts) | 指令渲染、预算截断、变更记录 |
| [`src/state.ts`](src/state.ts) | 持久消息来源、版本／digest 缓存、对账 |
| [`src/digest.ts`](src/digest.ts) | SHA-1 内容标识与每目录重复键 |
| [`src/invariant.ts`](src/invariant.ts) | 持久上下文约定的不变式伴生插件 |

### 主要流程

在会话第一次符合条件的 `agent/pre-step`，插件组合基线并把它折入进入步骤的批次、紧随已领取的消息之后。成功的第一方 `read`、`write`、`edit` 调用贡献的 touch 会沿父级执行 token 逐层上浮；当外层步骤进入持久历史后，一次投影会把可见会话状态与 inbox 对账，并排入新增、替换或移除。路径与 digest 都未变的内容绝不重复注入。`@path` import 在每次指令读取时展开，因此发现、去重与 digest 都作用于展开后内容。发现跟随结构化文件系统活动，而非 shell 导航，因为每次本地 shell 调用都启动新进程，解析任意 shell 语法不是可靠的文件系统 seam。

### 不变式

每条注入消息都携带带类型的来源及其变更列表；完整基线还携带从规范化发现、优先级、项目根与预算配置派生的标识，匹配的持久消息会确认已排队的基线。模型可见文本不含隐藏状态标记，指令内容或模型可见元数据中的字面 `</system-reminder>` 文本都会被转义，因此仓库控制的文本无法关闭插件控制的框架。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从指令文件格式逐步进入设计决策与穷尽式配置。

- [文档标准](../../../docs/AGENTS.md)——`AGENTS.md` 指令文件包含什么、如何维护。
- [工作区上下文决策记录](../../../.agents/notes/implemented/feature/2026-06-24-workspace-context.zh.md)——按 agent／会话隔离与生命周期理由。
- [context 组地图](../README.zh.md)——相邻的请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-instructions)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a> <a id="prompt-shape"></a>
## 模型体验

### 基线上下文

#### 模型看到的内容

第一次请求的派生历史中包含一条持久 user 角色消息，其中按从宽泛到具体的顺序包含有界用户全局指令与项目指令链。可见基线兼容时，恢复会复用该消息。被导入文件内联出现在引用文件段落中，包裹在 `Imported from: <path>` / `End imported from: <path>` 标记行之间。

##### 基线指令模板

```markdown
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

<user-global-instructions>

Instructions from: AGENTS.md

<project-instructions>
</system-reminder>
```

#### Token 影响

渲染后基线只追加一次，并保留在派生历史中直到压缩。`maxBytes` 限制完整消息，较宽泛文件在最具体文件截断之前被省略，空指令链不产生 token。

#### KV Cache 影响

仅追加，位于现有可复用前缀之后。可见基线标识兼容时，恢复会保持复用；不兼容的标识会追加一条完整替代基线，因此发现、优先级、项目根或预算变更只会从该历史位置起影响复用。

### 新发现的 scope 上下文

#### 模型看到的内容

成功的第一方文件系统调用到达更深目录后，下一次请求会包含一条保留的带来源 `user/message`，其中包含新适用的指令文件。

##### 附加指令模板

```markdown
<system-reminder>
Additional instructions from: packages/app/AGENTS.md

These instructions apply to work under `packages/app`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

<nested-instructions>
</system-reminder>
```

#### Token 影响

每个已发现 scope 都会添加有界历史 token，直到压缩。可见会话状态与版本／digest 比较会抑制未更改内容，PTC mode 将同一消息延迟至外层 `run_code` 结果及其所属持久步骤之后。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 已改变或移除的指令上下文

#### 模型看到的内容

已改变的文件会产生 `Updated instructions from: <path>` 加替换内容。消失或成为同一目录中较早候选文件重复项的候选文件会产生下方移除通知。

##### 移除通知

```markdown
<system-reminder>
Instructions removed: packages/app/AGENTS.md

The previously loaded instructions from this file no longer apply.
</system-reminder>
```

#### Token 影响

每项已确认变更或移除都是一条受 `maxBytes` 限制的保留历史消息。提供方失败不添加消息，预算省略的更新仍可在后续文件系统 touch 中处理。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明指令加载何时不合适或需要运维注意。它们是当前包约束，不是任务积压。

- **发现跟随结构化 fs 工具，而非 shell 导航**：更改目录的 `bash` 命令不会触发嵌套指令发现，因为 shell 语法与每次调用的 shell 状态不是可靠的文件系统 seam。
- **刷新由 touch 驱动**：没有 watcher；外部编辑会在下一次成功的第一方 `read`、`write` 或 `edit` 时、恢复对账可见基线时，或进入步骤的 pre-step 恢复被遮蔽基线时可见。
- **候选语义有意保持简单**：不解释小写名称与 `.claude/rules/`；项目 scope 默认加载 `AGENTS.local.md`／`CLAUDE.local.md` overlay，但用户全局 `$DSH_HOME` scope 没有本地 overlay，其他自定义名称需要显式候选配置。
- **Import 保持与 Claude Code 对齐的固定上限**：递归最多四跳，对同一文件的重复引用在出现处各自展开，只支持以 `/` 分隔的路径，解析到工作目录之外的 import 没有交互式审批；约束来自文件系统提供方策略。
- **每目录去重基于内容**：同级候选只有在去除首尾空白后字节完全一致时才折叠。`CLAUDE.md` 若 symlink 到同级 `AGENTS.md`，会解析为相同内容并像任何重复项一样折叠；从 `AGENTS.md` 漂移的独立副本则会与它一起完整加载。
- **Symlink 指令文件与绝对路径 import 会跨越信任边界**：最终组件是 symlink 的候选文件会被解析并加载其目标，绝对或 `~/` 前缀的 `@path` import 会读取已挂载文件系统提供方允许的任何文件，因此克隆仓库可以将树外文件内容呈现为较低优先级的工作区指引（它绝不覆盖 system、developer 或用户直接下达的指令）。加载不受信任仓库时，请用文件系统策略门禁或 OS 沙箱限制 `ctx.fs`。
- **指令内容受限但不会被摘要**：超出预算的宽泛文件会被省略，最具体文件可能被截断；该插件绝不请求模型压缩指令文本。
- **作用域抑制不会在进程内热重载后存活**：标记只存在于已挂载的服务实例中；remount 会丢弃所有活 agent 的标记（其 disposer 变为 no-op），注入在会话中途恢复。重启并重跑 agent setup（关闭配置 HMR，feishu-bridge 的默认值）则自然恢复。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
