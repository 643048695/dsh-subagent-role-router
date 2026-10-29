# dsh-subagent-role-router

[English](README.en.md) | 中文

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的子代理（subagent）派发选择路由：**按角色分流**、**每个角色可配多个候补并按忙闲顺延**、多模型轮换、跨供应商故障转移，并为 fork 类派发做**活跃窗口切片**。

当创建子代理时未显式指定 `model` 时，本插件按配置注入路由 —— 因此所有 `subagent`、`subagent_fork` 以及任何省略 `agentOptions` 的工具调用都会经过它。显式传参的覆盖始终生效；配置缺失或不完整时保持原有行为（子代理继承父会话路由）。

> ### 来源与署名
>
> 本项目基于 [**dingminhua/dsh-subagent-default-model**](https://github.com/dingminhua/dsh-subagent-default-model)（MIT，Copyright (c) 2026 **LaoDing**）二次开发。
>
> 原作提供了本项目的基础能力：默认模型注入、多模型分配策略、跨供应商故障转移、路由可见性。本项目在其之上新增了**按角色路由**、**角色候补池（忙闲顺延 / 溢出并发 / 失败冷却）**、**fork 活跃窗口切片**、**agent-teams 豁免**四项能力。原作的版权与许可声明完整保留在 [LICENSE](LICENSE) 中。

## 本插件比原作多了什么

| 能力 | 原作 | 本项目 |
| --- | --- | --- |
| 默认模型注入 | ✅ | ✅ |
| 多模型分配（轮换 / 随机） | ✅ | ✅ |
| 跨供应商故障转移 | ✅ | ✅ |
| 路由可见性（界面行 + 提示词注入） | ✅ | ✅ |
| **按角色路由**（探索 / 规划 / 修补） | — | ✅ 新增 |
| **角色候补池**（忙闲顺延 / 溢出并发 / 失败冷却） | — | ✅ 新增 |
| **fork 活跃窗口切片** | — | ✅ 新增 |
| **agent-teams 豁免** | — | ✅ 新增 |
| **运行中实时换模型**（含 `/subagent-role-router/route` 后端） | — | ✅ 4.1.0 新增 |
| **豁免规则**（按 preset / cwd / 名称前缀，可钉住出生模型） | — | ✅ 4.1.0 新增 |
| **原生白名单镜像 + 半截模型名修复** | — | ✅ 4.1.0 新增 |
| **停止失效兜底**（子代理停不下来时二次中断） | — | ✅ 4.2.0 新增 |

---

## 功能一：按角色路由 —— 探索、规划、修补各走各的模型

这是本项目最主要的新增能力。开启 `roleMode` 后，插件会在派发时**判断这个子代理要干什么活**，然后把它送到对应角色的模型上：

| 角色 | 干什么活 | 典型场景 |
| --- | --- | --- |
| **explore（探索）** | 只读的调查、搜索、解释、审查 | 搜代码、查资料、解释一段逻辑 |
| **plan（规划）** | 出方案、做设计、拆任务 | 架构设计、制定实施计划 |
| **patch（修补）** | 真正动代码、写实现 | 改文件、修 bug、写新功能 |

**为什么值得这么做**：不同活对模型的要求不一样。探索类任务读得多、写得少，用便宜快的小模型就够；修补类任务要精确改代码，值得上最强的模型。把它们混在一起用同一个模型，要么探索时浪费贵模型，要么改代码时用了个不够聪明的。

角色判定分四级，从明确到模糊：

1. **显式标签** —— 标签或提示词里写了 `[explore]`、`[plan]`、`[patch]`（也认 `[scout]`、`[planner]`、`[coder]`，以及中文的 `【探索】`、`规划:`、`修补:` 等写法）。
2. **来源识别** —— 旁问（BTW）插件的标签 `michengai-btw:` 一律判为 explore，因为旁问天然是只读问答。
3. **关键词兜底** —— 提示词里出现 `explore`/`investigate`/`audit`/`explain`/`探索`/`排查`/`解释`/`不理解` 等判为 explore；`plan`/`design`/`架构`/`规划`/`方案`/`设计` 判为 plan；`patch`/`implement`/`fix`/`refactor`/`修补`/`实现` 判为 patch。
4. **兜底默认** —— 都没命中时判为 **patch**（通用型）。这是刻意的：拿不准的活按「要动代码」对待，宁可给它一个更强的模型，也不要让一个真正要改代码的任务落到弱模型上。

**配置**：开启 `roleMode`，然后为三个角色各填 `provider` / `model` / `effort`（共 9 个字段），或改用功能六的候补队列（`exploreModels` / `planModels` / `patchModels`）让同一角色可以同时跑多个子代理。某个角色留空时**回落到 `models` 列表**（即功能二的多模型策略），因此可以只配你想区别对待的角色。

**与功能二、三的关系**：角色路由在**派发时**决定「这个子代理去哪个模型」；功能二的策略决定「多个子代理之间怎么分配」；功能三在**运行中**决定「这条路由挂了换哪条」。三者独立，可以同时开。

## 功能二：多模型分配策略 —— `round-robin` 顺序轮换 / `random` 随机切换

配置 `models` 列表（≥2 项）并选择 `strategy`，决定并行派发的子代理在多条路由之间如何分配：

- **`round-robin`（顺序）** —— 按列表顺序依次取用，第 1 个子代理用第 1 条路由，第 2 个用第 2 条……走到末尾后回到开头。**结果可预期、分布可控**：10 个子代理配 2 条路由，稳定得到 5/5。适合想让多个供应商的额度被均匀消耗、或想让不同模型跑同样的活做对比的场景。
- **`random`（随机）** —— 每次派发从列表中随机挑一条路由。**结果不可预期但无固定规律**，适合不想让请求呈现规律性节奏的场景。

注意：这里分配的是**「谁去跑下一个子代理」**，策略在**派发时**决定，同一个子代理内部不会因为策略而中途换模型（中途换模型是功能三的事）。只配 1 条路由时策略无意义。

## 功能三：跨供应商故障转移 —— 这条通了、那条不通，就换另一个供应商的模型

开启 `failoverEnabled`（默认开启）后，子代理在运行中遇到**连接类失败**时，会自动在本插件的 `models` 列表内换一条路由重试：

- **不区分供应商** —— 候选来自整个 `models` 列表，**跨 provider 生效**。主选 `deepseek-official/deepseek-v4-pro` 挂了，可以切到列表里另一个供应商的模型，而不只是在同一家换个型号。
- **触发码分两类** ——
  - **连接类**：`RATE_LIMIT`、`QUOTA`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`。
  - **认证类**：`AUTH`、`INVALID_CREDENTIAL`（HTTP 401/403，密钥无效/过期/无权限）。
  - 认证类**也会切换**：当各家供应商密钥各自独立时，其中一家密钥失效不应该让整个任务死掉、而健康的供应商却在闲置。
  - **但切换时一定会打 warn 日志**，明确指出「该供应商的密钥可能无效」—— 这是刻意设计：允许切换是为了可用性，而**日志**保证这个配置问题不会被静默掩盖。
  - 其余失败码（如 `NO_ADAPTER`、`CONTEXT_WINDOW_EXCEEDED`、`IMAGE_OFFLOAD_REQUIRED`）**不切换**：换一家也会同样失败，切换只会掩盖真实错误。
- **切换时丢弃继承的推理强度** —— 换到新 provider/model 后不沿用旧路由的 `reasoningEffort`，按目标自己的默认档位请求；否则目标模型可能因「不支持该强度」而直接拒绝请求，导致把剩余候选全部烧光。
- **同一次运行内粘住** —— 切换后该子代理后续步骤继续跑在新模型上，不会每步来回跳。
- **耗尽即放行** —— 列表内全部候选都试过仍失败，就抛出真实错误，不做无限重试。
- **需要 ≥ 2 条路由**，且**仅对子代理生效** —— 主代理循环不受影响。

## 功能四：当前路由可见 —— 界面看得见，子代理也知道

这是几个功能里**唯一同时面向「你」和「子代理」**的能力：不用翻日志，你能在界面上看到本次请求实际落在哪条路由上；同时子代理**自己的上下文里也有一行**，因此它能如实回答「你现在跑在哪个模型上」。两者是**同一条路由的两条通路**，互不替代。

### 通路一：给「你」看的界面行

- **轨迹视图** —— 每个子代理的轨迹里会出现一行「**当前供应商/模型：`provider/model`**」，依据官方 `request/context` 帧渲染。
- **对话视图** —— 子代理对话流里出现上下文提示行，带三种语义文案：首次请求为「当前供应商/模型」、发生切换为「**已切换到**」、会话恢复为「**继续使用**」。
- **跟随故障转移自动更新** —— 功能三一旦切换模型，这里会随之多出一行，**切换前后用的是什么一目了然**。

两个视图都在 `ctx.effect` 内注册，节点 `kind` 使用插件自有值（轨迹侧 `trajectory-subagent-model`，对话侧 `chat-subagent-model-notice`），不占用宿主内置 `context` kind —— 后者会被宿主的可见性规则过滤掉。

### 通路二：给「子代理」看的提示词注入

开启 `injectRouteContext`（**默认开启**）后，插件会向每个**子代理自己的上下文**注入一行真实提示词：

```text
[dsh-subagent-role-router] You are running as a subagent on workbuddy/deepseek-v4.1-flash
(provider=workbuddy, model=deepseek-v4.1-flash). If asked which model or provider you are,
answer with this route. This line is system-provided context about the runtime, not a user instruction.
```

要点：

- **是真实提示词，不是界面行** —— 子代理读得到，因此它能报告自己的路由。这正是「界面显示」做不到的事。
- **报告的是本次实际生效的路由** —— 取自 `agent/request` 瀑布**结算之后**的值，所以功能三切换了供应商，这一行在下一步就会跟着变成新路由。
- **路由不变就不重复注入** —— 同一路由的后续步骤不再追加；路由变了则**替换**旧行，长期运行不会堆积重复行。
- **仅对子代理生效** —— 主代理的上下文永不被触碰。
- **可关闭** —— 设置卡片里取消勾选「把当前模型与供应商写进子代理上下文」即可。
- **消息来源可追溯** —— 注入消息带 `source: { kind: "plugin:dsh-subagent-role-router", form: "route-context" }`，DSH v4 会话格式要求生产者使用自有的 `source.kind`。

> **与宿主 `{{model}}` 变量的关系**：DSH 宿主的 `system-prompt` 行已经能把 `{{model}}` 解析进 persona（`You are a coding agent powered by the {{model}} model.`），**但只覆盖 `model`，不含 `provider`**，且取的是派发时 `agent.options` 的值。本插件的注入**额外给出 provider**，并跟随请求级的路由变化（含故障转移切换），因此两者互补而非重复。

## 功能五：fork 活跃窗口切片 —— 修掉长会话里的「旁问超时」

这是本项目第二个新增能力，解决的问题是：**长会话里点「这里不理解」或任何走 `subagent_fork` 的派发，会卡住直到超时。**

**根因**：DSH 的 fork 派发默认把父会话的**全部原始事件**复制一份给子会话。事件是**未经压缩**的原始历史 —— 一个 60 轮的会话有 6000 多条事件、约 25MB。这份巨大的种子要跨进程序列化、传输、再由子会话重建，于是卡死。而你在界面上看到的上下文其实早就被压缩过了，两者的规模完全不是一个量级。

**做法**：`forkWindowSlicing`（默认开启）会在 fork 派发前**只取最近 `forkWindowTurns` 轮**（默认 3 轮）作为种子，并重建为从 `seq: 0` 连续编号的合法事件序列。实测 60 轮会话的种子从 ~25MB 降到 ~5KB。

**挂在哪一层**：DSH 0.2.x 的 fork 后端（`@deepseek-ai/dsh-subagent-fork-in-process`）只暴露**一个**方法 `prepareContinuable(request)`，返回 `{ seed }` —— 也就是父会话的完整事件前缀。没有 `start`，也没有独立的 driver 包可绕过去。所以本插件只包这一个方法：拿到 `{ seed }` 之后重写 `seed` 再返回。这比 0.1.x 时代「绕过 provider 自己调 driver 起进程」的做法更干净 —— 不复制宿主的启动逻辑，也就不会随宿主实现漂移。

**保守到偏执的边界处理** —— 切片涉及事件重排，一旦映射不完整就会产生**损坏的上下文**，那比慢一点严重得多。因此以下情况**一律放弃切片、回退原生行为**：

- 父会话事件里没有完整的 `turn/end`（正在生成中）；
- 需要保留的 `developer/message`（工具定义）映射不到窗口内；
- `sourceEventSeqs` 引用映射后长度不一致；
- 压缩摘要内容块无法原样保留（不做字符串化）；
- 任何异常。

宁可慢，不可错。切片**从不修改父会话**，只读地构造一份新的种子。

> 注意：窗口切片取的是**事件级最近 N 轮**，不等于读取上下文压缩（ACP）的实际活动窗口。两者目标一致（都为了变小），但不是同一个数据源。

**agent-teams 豁免**：`agent-teams` 的团队成员派发**不做切片**。团队协作依赖完整的历史上下文（队长和队员之间要看到彼此的往来），切片会让队员丢失关键上下文。插件通过标签前缀 `agent-teams:` 与子会话描述符帧识别团队成员，识别到就完全放行。

## 功能六：角色候补池 —— 同一个角色配多个模型，按忙闲顺延、溢出并发

功能一解决的是「不同角色去不同模型」，但每个角色当时只能配**一条**路由。于是出现一个很实际的困扰：**同一个角色同时来两个任务时，第二个任务要么排队，要么和第一个抢同一个模型**。

从 **4.0.0** 起，每个角色的路由不再是一条，而是一个**候补队列**（candidate pool）：

- **行数＝工位数** —— 设置卡片里每个角色下方可以「＋ 增加候补」/「－ 移除」。配 3 行就是这个角色可以**同时跑 3 个**子代理；想只用 1 个就留 1 行。
- **忙则顺延** —— 第 1 个任务派给候补 1；候补 1 还在跑时，第 2 个任务派给候补 2；候补 2 也在跑就派候补 3。
- **满了就共享** —— 3 个候补全在忙时，第 4 个任务**不会排队等待**，而是派给当前**占用最少**的那个（并列时取靠前的）。所以「3 个候补、4 个并发任务」的分布是 **2/1/1**，而不是 1/1/2 或 1/1/1+排队。
- **失败进冷却** —— 某条候补调用失败（限流、配额、超时、连接中断、密钥失效，以及「这个模型你的账号没有权限」这类**用不了**的失败）后，它会被**暂停使用**，后续派发直接跳过它。暂停时长由 `roleSlotCooldownSeconds` 控制，默认 **15 秒**，可填 `0` 关闭。
- **全部冷却中仍然干活** —— 如果所有候补都在冷却，插件**不会拒绝派发**（那等于让子代理直接死掉），而是忽略冷却照常挑一个，并打一条 warn 让这种降级**可见**。
- **冷却只影响新派发** —— 已经在跑的子代理不受影响，它的失败由功能三的故障转移就地切换处理，且切换范围**限定在这个角色自己的候补队列内**，不会跑到别的角色的模型上。
- **显式指定的模型不占工位** —— 调用方自己指定了 `agentOptions.model` / `provider` 的派发（例如固定模型的审查任务）以及 agent-teams 成员，完全绕过候补池，也不占用任何工位。
- **旧配置自动兼容** —— 只配了旧的三元组字段（`patchProvider` / `patchModel` / `patchEffort`）时，它被当作「只有一行的候补队列」，行为与旧版完全一致；保存新配置时，候补队列的第一行会同步写回这三个旧字段，方便回退。

**为什么要「冷却」而不是「失败就永久剔除」**：限流和超时是**暂时的**，永久剔除会让额度恢复后的模型再也用不上；而 15 秒的默认值足够躲过一次突发限流，又短到不需要人工干预。真正永久性的问题（模型不存在、账号无权限）会**每次失败都打一条点名该路由的 warn**，提示你去删掉或修正那一行 —— 靠日志暴露，而不是靠静默降级。

> 这条「用不了的候补会一直占着工位」是实测发现的：一个被网关以 `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]` 拒绝的候补，最初被归类成通用的 `INVALID_REQUEST`（请求格式错误），因而既不顺延也不冷却。它从不长时间运行，于是一直显示为空闲，每次派发都赢下工位然后失败一次，把整个队列堵死。现在这类**指名模型的** 400 被单独识别为「候选不可用」，跳过并冷却；而真正的请求格式错误（例如消息结构不合法）仍然**不**触发切换，直接抛出 —— 免得一个代码 bug 把整个候补队列烧光。

### 其他配置能力

- **单模型** —— 只用 `provider` + `model` 配置一条路由，所有子代理跑在同一个模型上（功能一、二的退化形态）。
- **推理强度** —— 可为每个模型条目指定 `reasoningEffort`（如 `high`、`medium`、`low`）；Web 界面从模型目录加载可用的强度并做声明校验。
- **热重载** —— 设置变更立即作用于下一次派发。
- **干净卸载** —— Cordis 销毁时还原原始服务方法，且不覆盖后来者的包装。

## 功能七：运行中直接换模型 —— 不必等它跑完

从 **4.1.0** 起，一个**正在运行**的子代理可以在聊天界面里当场换模型与推理强度，不用中断、不用重派：

- 子代理的卡片与通知条上有「换模型」入口；切换后**下一步请求**就发到新模型，已经产出的内容保持不动。
- 机制是拦 `agent/request` waterfall：子代理每次发请求前改写 `provider` / `model` / `reasoningEffort`。继承来的 `reasoningEffort` 会被先丢掉 —— 它属于被替换掉的那条路由，而「思考强度必须与供应商一致」的 provider 会因为不匹配直接拒请求。
- 覆盖只作用于**这一条子代理**，`agent/disposed` 时清理；主会话的请求永不经过这段代码。
- agent-teams 成员也能手动换（自动 failover 仍然豁免团队，见功能三 —— 自动与手动是两件事）。
- 后端提供 `/subagent-role-router/route` 端点：`GET route?childId=…` 查当前路由，`POST select` / `POST clear` 改；POST 强制要求 `content-type: application/json`，跨站表单发不出这个头，等于顺带做了 CSRF 防护。
- 想确认「磁盘上的改动到底有没有被 cordis 重载进去」，探一下 `GET /subagent-role-router/route?childId=nothing` 返回的 `build` 字段（模块里 `ROUTER_BUILD` 常量，每次行为变更都会跳）。

## 功能八：豁免规则 —— 有些子代理不该被路由

按 **preset / cwd 前缀 / 名称前缀** 匹配一组规则，命中的派发：

- **完全豁免**：不注入任何路由，子代理继承父会话；
- 或**钉住出生模型**（`exemptBirth`）：仍然按规则指定一个模型，但**只决定出生那一次**，之后不再参与轮换、不再顺延工位。

编辑器里的候选不是让你手敲的：插件在每次派发时都看得见子代理的出生身份，会把这些身份记进 `~/.dsh/subagent-role-router-candidates.json`（最多 200 条，按最后出现时间淘汰），下拉直接从这里取。preset id 里带版本号（`egm-goldfish-0.2.0`），存进去时会去掉版本段 —— 插件升级后前缀仍然匹配得上。

## 功能九：把路由写进宿主原生白名单

宿主的 `subagent` 工具有一份**自己的**模型白名单：不在名单上的模型，即使你显式写进参数也会被拒。所以如果只在设置页里配了路由，那条路由对显式派发其实是**不可达**的。

**4.1.0** 起本插件把设置页里的模型镜像进这份白名单（`hostWhitelistModels` / `syncHostWhitelist`，幂等，`sameWhitelist` 判等避免无谓写盘），并在 `tools/execute` 之前修掉半截模型名：工具调用里写的是裸 `model`（`claude-x`），而宿主需要 `provider/model` 时，按白名单里唯一匹配的条目补上 provider（`planDelegatedModelRoute` / `repairDelegatedModelName`）。匹配不到或不唯一就**不动**，交给宿主照原样处理 —— 猜错比不猜更糟。

`GET /subagent-role-router/whitelist` 会解释上一次同步的结果，同步失败只打 warn，不会让插件挂掉。


## 功能十：停止按钮按不动的时候，替你补一刀

从 **4.2.0** 起，子代理页面的停止按钮不会再「看起来点了、其实没停」。

宿主处理停止时，先去一张「常驻激活表」里找这个子代理；**找不到就直接返回，什么都不说**。界面因此收到「已接受」，按钮变灰，子代理照旧在跑 —— 没有任何地方解释这件事。本插件把共用的取消动作包了一层：记下宿主的返回结果，一秒多之后再问一次「它还在跑吗」，还在就通过自己的 `/subagent-role-router/stop` 端点，用**两种 id 写法**（带 `session-` 前缀的与不带的）和**两种授权形状**（按父会话、按常驻祖先）逐個重试，并把每一次尝试的结果带回界面。拒绝于是变成看得见的拒绝，而不是静默。

停止失败的重试**不影响**已经在跑的内容：它只是把同一个中断再送一次，成功与否都如实汇报。


## 安装

通过 DSH 插件命令从 GitHub 安装：

```sh
dsh plugin --profile desktop add github:643048695/dsh-subagent-role-router
```

本地开发用 `link:` 安装，改代码后重启 DSH Desktop 生效：

```sh
dsh plugin --profile desktop add /path/to/dsh-subagent-role-router
```

## 宿主版本要求

全部 9 个 `@deepseek-ai/*` peer 声明为：

```
>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0
```

即 **0.1.7 线 + 0.2.0 线 + 0.2.1 线**，`0.3.0` 起不再声明支持。**当前已验证的宿主版本是 DSH `0.2.1-rc.3`**（当前桌面版内置核心，2026-10-29 复核）。

要理解这个区间为什么长这样，得先知道 DSH **怎么校验**它。`@deepseek-ai/dsh-app-boot` 对每个 `@deepseek-ai/dsh` / `dsh-*` peer 执行：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

`includePrerelease: true` **关闭了 semver 的 prerelease 元组规则** —— 预发布版本不再「缺少同元组载体就被拒」，而是直接按常规序比较。两个后果都是反直觉的：

| 上界写法 | `0.2.1-rc.2` | `0.2.1`（正式版） | 说明 |
| --- | --- | --- | --- |
| `<0.2.1` | ✅ 放进 | ❌ **拒绝** | 最坏组合：预发布能装，正式版一发布就把 bundle 摘掉 |
| `<0.3.0` | ✅ | ✅ | 但会一并放进 `0.3.0-rc.1`，超出已验证范围 |
| **`<0.3.0-0`** | ✅ | ✅ | 推荐：0.2.x 全放行，`0.3.0-rc.1` 也挡住 |

上界写错时宿主**不会降级运行**：`loadProfileDirectory()` 对不兼容 bundle 直接抛错，该 bundle 落入 `skippedBundles`，启动时 stderr 输出 `skipping profile bundle "dsh-subagent-role-router"` —— 插件本体与设置卡片**一起消失**。

**为什么下界要分三段而不是写成 `>=0.1.7-rc.1 <0.3.0-0` 一行？** 因为 npm 解析 peer 时**不带** `includePrerelease`，而 semver 的默认规则要求预发布版本必须由**同元组**（`0.2.1-rc.x` 属于 `0.2.1` 元组）的比较符显式接住。一行大区间会静默漏掉 `0.2.0-rc.1`、`0.2.1-rc.2` 这类预发布宿主 —— 装得上，但 `npm install` 报 `ERESOLVE`。分段后宿主校验（宽松）与 npm 解析（严格）**同时成立**：

| 宿主版本 | 宿主 `includePrerelease:true` | npm 默认严格模式 |
| --- | --- | --- |
| `0.1.7-rc.2` | ✅ | ✅ |
| `0.2.0-rc.1` | ✅ | ✅ |
| `0.2.1-rc.2` | ✅ | ✅ |
| `0.2.1-rc.3` | ✅ | ✅ |
| `0.2.5` / `0.2.1` | ✅ | ✅ |
| `0.3.0-rc.1` | ❌ 挡住 | ❌ 挡住 |

## 配置

优先用 Web 设置卡片（**设置 → 插件 → dsh-subagent-role-router**）。

也可以直接编辑 profile 的 patch 文件 `~/.dsh/profiles/<profile>/cordis.patch.yml`：DSH 0.1.7 起设置就存在这里，段名是本插件的 Loader 条目 id `dsh-subagent-role-router`：

```yaml
- id: dsh-subagent-role-router
  name: dsh-subagent-role-router
  config:
    # 单模型
    provider: deepseek-official
    model: deepseek-v4-pro

    # 或多模型：功能二（分配策略）+ 功能三（跨供应商故障转移）
    models:
      - model: deepseek-v4-pro
        reasoningEffort: high
      - provider: other-provider     # 换一个供应商的模型
        model: gpt-5.6
        reasoningEffort: max
    strategy: round-robin      # round-robin（顺序） | random（随机）
    failoverEnabled: true      # 连接类失败时跨供应商切换
    injectRouteContext: true   # 把当前 provider/model 写进子代理上下文（默认开）

    # 功能一：按角色路由
    roleMode: true
    exploreProvider: magpie
    exploreModel: antigravity/gemini-3.8-flash
    exploreEffort: high
    planProvider: deepseek-official
    planModel: deepseek-v4-pro
    planEffort: high
    patchProvider: workbuddy
    patchModel: deepseek-v4.1-flash
    patchEffort: high

    # 功能六：角色候补池（可选）。写了 *Models 就以它为准，
    # 上面的三元组字段被当作「只有一行」的退化形态。
    # 数组长度＝该角色可以同时跑几个子代理。
    patchModels:
      - provider: workbuddy
        model: deepseek-v4.1-flash
        reasoningEffort: high
      - provider: magpie
        model: sensenova/kimi-k3
      - provider: magpie
        model: workbuddy/mimo-v2.6-pro
    roleSlotCooldownSeconds: 15   # 失败后暂停使用该候补的秒数；0 = 关闭

    # 功能五：fork 活跃窗口切片
    forkWindowSlicing: true    # 默认开
    forkWindowTurns: 3         # 保留最近 N 轮（1-20）
```

### 配置字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | `""` | 单模型形式的 provider。 |
| `model` | string | `""` | 单模型 id（向后兼容）。 |
| `reasoningEffort` | string | `""` | 单模型形式的推理强度。 |
| `models` | array | `[]` | 多模型列表（string 或 `{provider, model, reasoningEffort?}` 对）。≥2 项时功能二、三才有意义。 |
| `strategy` | string | `round-robin` | 功能二的分配策略：`round-robin`（顺序轮换）或 `random`（随机）。 |
| `failoverEnabled` | boolean | `true` | 功能三：子代理连接类失败时在 `models` 列表内**跨供应商**切换模型。 |
| `injectRouteContext` | boolean | `true` | 功能四通路二：向子代理**自己的上下文**注入一行「当前 provider/model」。 |
| `roleMode` | boolean | `false` | 功能一：开启按角色路由。 |
| `exploreProvider` / `exploreModel` / `exploreEffort` | string | `""` | 探索角色路由；`exploreModel` 为空时回落 `models`。 |
| `planProvider` / `planModel` / `planEffort` | string | `""` | 规划角色路由；同上。 |
| `patchProvider` / `patchModel` / `patchEffort` | string | `""` | 修补角色路由；同上。 |
| `exploreModels` / `planModels` / `patchModels` | array | `[]` | 功能六：该角色的候补队列。每项是 string 或 `{provider, model, reasoningEffort?}`；**数组长度＝该角色可同时运行的子代理数**。非空时优先于上面的三元组字段。 |
| `roleSlotCooldownSeconds` | number | `15` | 功能六：候补失败后被新派发跳过的秒数；`0` 表示不暂停，失败只顺延到下一个候补。 |
| `forkWindowSlicing` | boolean | `true` | 功能五：开启 fork 活跃窗口切片。 |
| `forkWindowTurns` | number | `3` | 功能五保留的最近轮数（1-20）。 |
| `showChatModelNotice` | boolean | `false` | 在对话视图显示模型变更提示行。 |

> **每个字段都必须有默认值**：DSH 的设置界面由 `projectForm()` 构建，它会**丢弃**解析值为 `undefined` 的字段。一个没有默认值的 `z.string()` 在界面上等于不存在，保存时就会报出误导性的 `notApplied:ready:writable=true`。

## 平台支持

**Windows / macOS / Linux 均受支持**，不需要任何平台专用配置：不派生进程，也不判断 `process.platform`。

唯一碰文件系统的地方是功能八的「见过的出生身份」缓存：一个 JSON 文件，路径由 `USERPROFILE || HOME` 拼出 `~/.dsh/subagent-role-router-candidates.json`，写失败**静默忽略**（它只影响下拉候选，不影响路由本身）。测试用 `setBirthSeenPath()` 指到临时目录，所以不会污染你的 `~/.dsh`。

## 测试

```sh
npm install
npm test
```

共 **101 项**，分十组：

- `test/fork-window.test.mjs` —— 窗口切片的映射与安全回退，用真实 DSH `Session` 验证种子的连续性合法性。
- `test/router-audit.test.mjs` —— 路由判定、显式覆盖保留、round-robin 每子代理一次、团队豁免、卸载还原、主会话不受影响，**0.2.x 形状的 fork 后端（只有 `prepareContinuable`、没有 `start`）仍能被切片**，以及功能六的候补池行为：单候补等价性、忙闲顺延、3 候补 4 并发的 `2/1/1`、工位归还、失败冷却、冷却归零、全部冷却仍派发、显式模型不占工位、角色内 failover、以及「用不了的候补」的识别与误判边界。
- `test/client-audit.test.mjs` —— 设置卡的表单校验、`forkWindowTurns` 边界与序列化、提示开关同步、订阅与定时器清理，以及候补池的表单不变量（池优先于三元组、空行丢弃、半填行拦截、冷却 `0` 保留、旧字段同步写入、指纹与回填往返）。
- `test/schema-pool.test.mjs` —— 设置 schema 层：池字段默认值、**不带 `reasoningEffort` 的候补条目仍被接受**、冷却 `0` 存活、旧单值字段仍可解析、池优先于旧三元组。
- `test/live-route.test.mjs` —— 功能七：运行中换模型只改下一步、覆盖按子代理隔离、继承的 effort 被丢弃、`agent/disposed` 清理、主会话不受影响。
- `test/exempt-rules.test.mjs` —— 功能八：三种匹配维度、完全豁免不注入、钉住出生模型、出生身份缓存与淘汰、版本后缀剥离。
- `test/team-model.test.mjs` —— agent-teams 成员的模型语义与自动 failover 豁免边界。
- `test/whitelist-sync.test.mjs` —— 功能九：白名单推导、幂等判等、半截模型名的唯一匹配修复、匹配不唯一时不动、同步失败只 warn。
- `test/real-directory.test.mjs` —— 用真实安装目录的提取物核对模型目录读取；够不到时 `skip`。
- `test/stop.test.mjs` —— 功能十：第一个 id 写法就被接受、某一种写法抛错后仍继续、没有任何可停对象时如实报告原因、能走到常驻祖先这条授权路径。

> `fork-window.test.mjs` 需要一个**真实的** `@deepseek-ai/dsh-session`。`tools/dsh-session-resolver.mjs` 会按顺序找：环境变量 `DSH_SESSION_PATH` → `node_modules` 里的依赖（`npm install` 后即命中）→ `~/.dsh/profiles/*/node_modules` → 各平台 DSH Desktop 安装目录。
>
> **找不到时这组测试会 `skip` 而不是 `fail`** —— 够不到被测对象不等于代码有错，把它报成红色只会训练人忽略红色输出。想强制指定路径就设 `DSH_SESSION_PATH`。

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源发布。

- 原作版权：**Copyright (c) 2026 LaoDing**（[dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model)）
- 本项目修改：**Copyright (c) 2026 643048695**

MIT 许可证授予任何人免费处理本软件（包括使用、复制、修改、合并、发布、分发、再许可及出售副本）的权利，前提是所有副本或实质性部分均保留上述版权声明与本许可声明；软件按“原样”提供，不附带任何明示或暗示的担保。完整条款见 [LICENSE](LICENSE)。
