# Agent Note: feishu-bridge provider 卡热切换模式（#9）

Status: implemented

[English](2026-08-28-feishu-bridge-provider-card-hot-mode.md) | 中文

## Problem

provider 卡（[provider 卡](2026-08-28-feishu-bridge-provider-card.zh.md)）上线时只有普通切换：每行都会清空 agent session id，`-r` 热切换（保留对话记录、换路由）仍停留在纯文本命令。当时否决的理由——为低频变体把每条路由行翻倍——留下了真实需求没有回应：换模型同时保留对话上下文正是任务中途切换 provider 的常态，而重新手打 `/provider <name> -r` 抵消了点选切换的价值。

## Decision

卡片在当前行与路由行之间新增切换模式行：两枚等宽按钮——「热切换（保留上下文）」（`nav:/provider -r`，卡片默认、居左）与「切换（新会话）」（`nav:/provider`）——当前模式高亮 primary。按下的模式原地重渲染卡片（`nav:` 无副作用），每条路由行携带与模式匹配的动作：普通模式 `act:/provider <name>`，热模式 `act:/provider <name> -r`（行按钮文案为热切换）。卡动作 handler 用共享的 `-r` 语法（`parseProviderResumeFlag`）解析，一个值空间同时服务模式渲染（空路由名）与切换（具名路由）；热切换后的通知复用 `provider_hot_switched`，重渲染的卡保持被按动作的模式。帮助卡的 provider 行以热默认打开卡片（`nav:/provider -r`）。`applyProviderSwitch` 增加 resume 标志，成为三个入口——文本普通、文本 `--resume`、卡行——的唯一核心，逐路径保留副作用顺序（在 interactive-session 停止前捕获 agent session id、之后恢复）。

## Alternatives considered

**每路由双行（卡片落地时被否决的变体）。** 仍然否决：每路由两枚按钮让卡片翻倍，而这个选择是会话级的、不是路由级的——模式天然是卡片级状态。

**按下路由行后进入确认步骤。** 否决：给高频的普通切换增加一次点选；模式行让默认路径保持一次点选。

## Consequences

热切换在卡上成为一等能力：选一次模式，之后每行都保留上下文，🔄 通知与路由行原地重渲染。卡片默认以热切换打开——热切换按钮居左、每条路由行带 `-r`；普通模式在模式行一次点选可达，只带普通值的陈旧卡继续可用——`-r` 标志只可能来自本卡自产的动作值。切换语义有了唯一属主（`applyProviderSwitch`），普通/热切换的分叉是一个标志位而非两份发散的副本。提示文案改为描述随模式变化的行按钮。

## Testing

`tests/engine/provider-commands.spec.ts`：`nav:/provider -r` 渲染热模式（行值带 `-r`、热切换文案、热按钮 primary）且不切换；按下的热行保留 agent session id、显示 🔄 通知、保持热模式；裸卡断言热切换默认（热切换按钮居左且 primary、路由行值带 `-r`）。`tests/assembly-misc.spec.ts`：装配引擎上的热卡动作翻转 adapter 路由且 session id 保留。包全量套件绿；文本路径 `--resume` 用例不变且绿。
