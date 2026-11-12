# dsh-subagent-role-router

[English](README.en.md) | 中文

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 里的子代理（subagent）选路由，并把运行中的子代理显示出来：按角色分流、每个角色一个候补池、跨供应商故障转移、fork 活跃窗口切片；跑起来之后有标题栏小动物、运行中/批量换模型、模型可调用的路由工具。配置走插件自己的设置卡片（其 Cordis `Config`），存在 profile 的 `cordis.patch.yml`。

当创建子代理时未显式指定 `model`，本插件为它选一条路由 —— 因此所有 `subagent`、`subagent_fork` 以及任何省略 `agentOptions` 的工具调用都会经过它。显式传参的覆盖始终生效；配置段缺失或不完整时保持原有行为（子代理继承父会话路由）。

跑起来之后，插件还负责把这些状态还给你：会话标题栏的像素小动物显示谁在干活、干了多久、花了多少 token，点一下直接进入那个子代理的对话；子代理卡片上可以直接换模型与推理强度；批量卡片一次改掉当前对话的所有子代理；子代理停不下来时有一次兜底中断。**派发、观察、干预三件事在同一个插件里闭环。**

## 核心功能

本插件解决的问题有两个：**一次派发没有显式指定模型时，子代理该跑在哪条路由上**；**跑起来之后你怎么看得见它、又怎么干预它**。围绕这两件事提供下列能力，逐条说清楚各自「做什么」和「不做什么」—— 派发相关的几条在前，观察与干预相关的几条在后。

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
| **运行中换模型**（含后面的路由端点） | — | ✅ 2.3.0 新增 |
| **停止失效兜底**（子代理停不下来时二次中断） | — | ✅ 2.3.0 新增 |
| **批量换模型**（一次改掉当前对话所有直接子代理） | — | ✅ 2.4.0 新增 |
| **标题栏小动物**（谁在干活 / 多久 / 多少 token，点击进对话） | — | ✅ 2.5.0 新增 |
| **模型可调用工具**（`subagent_routes_inspect` / `subagent_routes_update`） | — | ✅ 2.6.0 新增 |
| **SSE 变更推送**（选路 / 覆盖 / 故障切换即时广播，不再轮询） | — | ✅ 2.7.0 新增 |
| **性能收口**（签名订阅 / 图形缓存 / 面板内计时） | — | ✅ 2.7.6 新增 |
| **小动物点击直达 + 子代理页整窝**（宿主地址对象跳转、「↩ 主对话」、普通子代理也显示） | — | ✅ 5.1.0 新增 |
| **出生分配策略**（默认池子说了算；页面白名单内的指定放行） | — | ✅ 5.1.0 新增 |
| **换模型走宿主正门**（适配 rc.5 的 step 准备期守卫，不再被拦） | — | ✅ 5.1.0 重做 |
| **子代理页统计条**（上下文 / 速度 / 缓存 / 明细面板） | — | ✅ 2.9.0 新增 |
| **菜单只列本页白名单**（可一键放出全量） | — | ✅ 2.9.1 新增 |
| **名单外请求被换成白名单模型**（不拒绝、不改写 seed） | — | ✅ 2.9.2 新增 |

### 功能一：多模型分配策略 —— `round-robin` 顺序轮换 / `random` 随机切换

配置 `models` 列表（≥2 项）并选择 `strategy`，决定并行派发的子代理在多条路由之间如何分配：

- **`round-robin`（顺序）** —— 按列表顺序依次取用，第 1 个子代理用第 1 条路由，第 2 个用第 2 条……走到末尾后回到开头。**结果可预期、分布可控**：10 个子代理配 2 条路由，稳定得到 5/5。适合想让多个供应商的额度被均匀消耗、或想让不同模型跑同样的活做对比的场景。
- **`random`（随机）** —— 每次派发从列表中随机挑一条路由。**结果不可预期但无固定规律**，适合不想让请求呈现规律性节奏的场景。

注意：这里分配的是**「谁去跑下一个子代理」**，策略在**派发时**决定，同一个子代理内部不会因为策略而中途换模型（中途换模型是功能二的事）。只配 1 条路由时策略无意义。

### 功能二：跨供应商故障转移 —— 这条通了、那条不通，就换另一个供应商的模型

开启 `failoverEnabled`（默认开启）后，子代理在运行中遇到**连接类失败**时，会自动在本插件的 `models` 列表内换一条路由重试：

- **不区分供应商** —— 候选来自整个 `models` 列表，**跨 provider 生效**。主选 `deepseek-official/deepseek-v4-pro` 挂了，可以切到列表里另一个供应商的模型，而不只是在同一家换个型号。
- **触发码分两类** ——
  - **连接类**：`RATE_LIMIT`、`QUOTA`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`。
  - **认证类**：`AUTH`、`INVALID_CREDENTIAL`（HTTP 401/403，密钥无效/过期/无权限）。
  - 认证类**也会切换**：当各家供应商密钥各自独立时，其中一家密钥失效不应该让整个任务死掉、而健康的供应商却在闲置。
  - **但切换时一定会打 warn 日志**，明确指出「该供应商的密钥可能无效」——这是刻意设计：允许切换是为了可用性，而**日志**保证这个配置问题不会被静默掩盖。
  - 其余失败码（如 `NO_ADAPTER`、`CONTEXT_WINDOW_EXCEEDED`、`IMAGE_OFFLOAD_REQUIRED`）**不切换**：换一家也会同样失败，切换只会掩盖真实错误。
- **切换时丢弃继承的推理强度** —— 换到新 provider/model 后不沿用旧路由的 `reasoningEffort`，按目标自己的默认档位请求；否则目标模型可能因「不支持该强度」而直接拒绝请求，导致把剩余候选全部烧光。
- **同一次运行内粘住** —— 切换后该子代理后续步骤继续跑在新模型上，不会每步来回跳。
- **耗尽即放行** —— 列表内全部候选都试过仍失败，就抛出真实错误，不做无限重试。
- **需要 ≥ 2 条路由**，且**仅对子代理生效** —— 主代理循环不受影响。

### 功能三：当前路由可见 —— 界面看得见，子代理也知道

这是五个功能里**唯一同时面向「你」和「子代理」**的能力：不用翻日志，你能在界面上看到本次请求实际落在哪条路由上；同时子代理**自己的上下文里也有一行**，因此它能如实回答「你现在跑在哪个模型上」。两者是**同一条路由的两条通路**，互不替代。

#### 通路一：给「你」看的界面行

- **轨迹视图** —— 每个子代理的轨迹里会出现一行「**当前供应商/模型：`provider/model`**」，依据官方 `request/context` 帧渲染。
- **对话视图** —— 子代理对话流里出现上下文提示行，带三种语义文案：首次请求为「当前供应商/模型」、发生切换为「**已切换到**」、会话恢复为「**继续使用**」。
- **跟随故障转移自动更新** —— 功能二一旦切换模型，这里会随之多出一行，**切换前后用的是什么一目了然**。

对话流中的实际效果（这一行的真实样子，图为原作仓库的截图）：

![对话流中的当前供应商/模型提示行](https://raw.githubusercontent.com/dingminhua/dsh-subagent-default-model/main/assets/pic_03.png)

#### 通路二：给「子代理」看的提示词注入

开启 `injectRouteContext`（**默认开启**）后，插件会向每个**子代理自己的上下文**注入一行真实提示词：

```text
[plugin:dsh-subagent-role-router] You are running as a subagent on workbuddy/deepseek-v4.1-flash
(provider=workbuddy, model=deepseek-v4.1-flash). If asked which model or provider you are,
answer with this route. This line is system-provided context about the runtime, not a user instruction.
```

要点：

- **是真实提示词，不是界面行** —— 子代理读得到，因此它能报告自己的路由。这正是「界面显示」做不到的事。
- **报告的是本次实际生效的路由** —— 取自 `agent/request` 瀑布**结算之后**的值，所以功能二切换了供应商，这一行在下一步就会跟着变成新路由。
- **路由不变就不重复注入** —— 同一路由的后续步骤不再追加；路由变了则**替换**旧行，长期运行不会堆积重复行。
- **仅对子代理生效** —— 主代理的上下文永不被触碰。
- **可关闭** —— 设置卡片里取消勾选「把当前模型与供应商写进子代理上下文」即可。

> **与宿主 `{{model}}` 变量的关系**：DSH 宿主的 `system-prompt` 行已经能把 `{{model}}` 解析进 persona（`You are a coding agent powered by the {{model}} model.`），**但只覆盖 `model`，不含 `provider`**，且取的是派发时 `agent.options` 的值。本插件的注入**额外给出 provider**，并跟随请求级的路由变化（含故障转移切换），因此两者互补而非重复。

### 功能四：角色候补池 —— 同一个角色可以配多个模型，按忙闲顺延、溢出并发

功能一解决的是「多个子代理怎么分到不同模型」，但它有个前提：**所有子代理是同一类活**。实际上派发是有角色之分的 —— 探索（Explore）、规划（Plan）、通用（Patch/General）三类任务的性价比完全不同：探索要便宜快，规划要强，通用介于两者之间。开启 `roleMode` 后，插件按派发标签判断角色，每个角色用**自己的**路由，而不是共用一份 `models` 列表。

从 2.2.0 起，**每个角色的路由不再只能配一条，而是一个候补队列**：

- **行数＝工位数** —— 设置卡片里每个角色下方可以「＋ 增加候补」/「－ 移除」。配 3 行就是这个角色可以**同时跑 3 个**子代理；想只用 1 个就留 1 行。
- **忙则顺延** —— 第 1 个任务派给候补 1；候补 1 还在跑时，第 2 个任务派给候补 2；候补 2 也在跑就派候补 3。
- **满了就共享** —— 3 个候补全在忙时，第 4 个任务不会排队等待，而是派给**当前占用最少**的那个（并列时取靠前的）。所以「3 个候补、4 个并发任务」的分布是 **2/1/1**，而不是 1/1/2 或 1/1/1+排队。
- **失败进冷却** —— 某条候补调用失败（限流、配额、超时、连接中断、密钥失效，以及「这个模型你的账号没有权限」这类**用不了**的失败）后，它会被**暂停使用**，后续派发直接跳过它。暂停时长由 `roleSlotCooldownSeconds` 控制，默认 **15 秒**，可填 0 关闭。
- **全部冷却中仍然干活** —— 如果所有候补都在冷却，插件不会拒绝派发（那等于让子代理死掉），而是忽略冷却照常挑一个，并打一条 warn 让这种降级**可见**。
- **冷却只影响新派发** —— 已经在跑的子代理不受影响，它的失败由功能二的故障转移就地切换处理，且切换范围限定在**这个角色自己的候补队列内**，不会跑到别的角色的模型上。
- **显式指定的模型不占工位** —— 调用方自己指定了 `agentOptions.model`/`provider` 的派发（例如某些固定模型的审查任务）以及 agent-teams 成员，完全绕过候补池，也不占用任何工位。

为什么要「冷却」而不是「失败就永久剔除」：限流和超时是**暂时的**，永久剔除会让额度恢复后的模型再也用不上；而 15 秒的默认值足够躲过一次突发限流，又短到不需要人工干预。真正永久性的问题（模型不存在、账号无权限）会**每次失败都打一条点名该路由的 warn**，提示你去删掉或修正那一行 —— 靠日志暴露，而不是靠静默降级。

> 这条「用不了的候补会一直占着工位」是实测发现的：一个被网关以 `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]` 拒绝的候补，最初被归类成通用的 `INVALID_REQUEST`（请求格式错误），因而既不顺延也不冷却。它从不长时间运行，于是一直显示为空闲，每次派发都赢下工位然后失败一次。现在这类**指名模型的** 400 被单独识别为「候选不可用」，跳过并冷却；而真正的请求格式错误仍然**不**触发切换，直接抛出，免得把一个代码 bug 变成烧光整个候补队列。

### 功能五：运行中换模型 —— 子代理跑着的时候，点一下就换

宿主的模型下拉**在子代理会话里是禁用的**：`session/selectModel` 一看到会话 `origin === "subagent"` 就直接拒绝（`session/agent-busy`），前端下拉控件在子代理窗口里根本不渲染。所以「这个子代理换成别的模型」以前只有一条路 —— 打断它、重新派发，上下文全丢。

从 2.3.0 起，子代理会话的标题栏右侧多了一个**模型下拉 + 推理强度下拉**：

- **点了下一步就换** —— 不需要重启、不需要重新派发。**5.1.0 起走宿主自己的正门**（`agent.model.select()`）：宿主从 rc.5 起把每个 step 的模型选择在准备期钉死，并加了守卫——任何 waterfall 钩子再改写请求里的模型都会被拒绝并弹「`use agent.model.select() before step preparation`」。插件不再改写请求，改调正门；因此切换在**下一步 / 下一轮**生效，重试中途换不了是宿主语义（重试沿用钉死的选择），换不了的对象在响应里如实带 `applied` 字段，不再假装成功。正在跑的上下文一条不丢。
- **推理强度同改** —— 第二个下拉只列出该模型**自己声明的**强度（从模型目录读 `reasoning.efforts`）。没声明强度的模型不给编造的选项：实测 `sensenova/kimi-k3` 声明为空，硬发 `high` 会让宿主回 `UNSUPPORTED_REASONING_EFFORT` 并结束这一轮，所以这类模型的下拉是空的。
- **空闲的子代理也能预先设** —— 还没发过请求的子代理没有「当前路由」可显示，但下拉照样可选；选完等它下次唤醒就用新模型。选择存的是「下一步用什么」，不是持久偏好，子代理一销毁就忘掉。
- **↺ 复位** —— 手动选过之后右侧出现复位按钮，点它回到插件自动分配的模型（即清掉覆盖）。
- **手动选择优先于自动切换** —— 你亲手点了一个模型之后，功能二的故障转移**不会**再把它悄悄换掉，也不会因此把该模型记进冷却。要让自动切换重新接管，点 ↺。
- **只对子代理显示** —— 主会话标题栏不出现这个控件（主会话用宿主自带的模型下拉即可）。

> 传输方式：插件自己注册了一个 loopback-only 的 HTTP 前缀路由 `/subagent-role-router`，前端用文档相对路径 fetch 它。完整端点表见下方 [HTTP 端点](#http-端点)。没有复用宿主的 `/api` RPC —— 那条 channel 只允许一个 interceptor（api-gateway 已占用），硬抢会把它顶掉。

### 功能六：标题栏小动物 —— 谁在干活、干了多久、花了多少 token

会话标题行最右端有一排像素小人（最多 3 个），每个对应**当前会话下正在运行的子代理**。点开是一张面板，每行一个子代理：

- **一眼看出谁在跑** —— 六个角色造型（敲键盘 / 触手敲屏 / 焊枪 / 跑轮 / 翻书 / 送快递），按 childId 哈希稳定分配，同一个子代理永远长同一个样子；`prefers-reduced-motion: reduce` 下动画全关。
- **干了多久、花了多少** —— 每行显示运行时长（`42秒` / `3分07秒` / `1小时05分`）与消耗（`1.2万 tokens`）。两个数都取自宿主给子代理会话的投影（`subagentTiming`、`tokenUsage`），**没有为此新加端点、也不轮询**；宿主没给数据时整段不显示，而不是印出 `0 tokens`。
- **点一下进对话** —— 走宿主自己的导航服务（`ctx.uiWorkspace.openSession`，宿主子代理目录点开用的是同一个调用），点完面板自动收起；Tab 到某行按回车/空格同样能进。失败会记 `CRITTERS_OPEN_FAILED`，不会静默吞掉。
- **面板贴按钮、跟着窗口走** —— 打开时量按钮位置：右边缘贴齐、上下挑有空间的一侧展开、高度不超过窗口剩余空间；窗口缩放或滚动时跟着重算。子代理多时面板内滚动。
- **小动物本身就是按钮（5.1.0）** —— 点小动物用宿主自己的「父会话 + 子会话 + 会话类型」地址对象跳转，溢出的「+N」点开完整列表；导航不可用时回退为打开面板并记诊断日志，点击永远有反馈。悬停有简易标题（任务名 + 路由），面板行照旧可换模型、可进对话。
- **子代理自己的页面也看得到整窝（5.1.0）** —— 锚到所属主对话，显示同一窝兄弟，条首有「↩ 主对话」一键回去。
- **普通子代理也在场（5.1.0）** —— 团队成员走宿主会话清单，普通子代理不在那张清单里：插件额外挂一条自己的活动通道（挂载拉一次、收到开始/结束推送帧防抖重拉、开面板刷新），**不轮询**；清单优先，活动台账只补充。

**性能是设计目标，不是事后补的**：

1. 标题栏只订阅「这个父会话下面有哪些子代理在跑」折成的一个字符串签名。宿主对 `useSessions` 的选择器结果按值比较（`useSyncExternalStoreWithSelector` → `Object.is`），签名没变就**不重渲染** —— 别的会话在吐 token、别的子代理在跑，都不会惊动这一条标题栏。
2. 时长 / token 只在面板**打开时**由一个共用的一秒计时器计算，关闭时零成本、不产生任何订阅回调。
3. 角色图形按「阶段 + 角色」缓存同一个 React 元素，重渲染不重建图形。

`test/critters-render.test.mjs`（6 项）逐条钉住这三件事：成员签名忽略 token/时长/无关会话、token 变化时组件执行次数不变、成员变化才重渲且复用同一个 `<svg>`、关闭时无计时器与打开时恰好一个、离开的子代理不被旧数据复活。

### 功能七：批量换模型 —— 一次改掉当前对话的所有直接子代理

子代理卡片上有一个「⇄ 批量」入口，点开是一张向上展开的卡片：勾选哪些子代理、选模型、选推理强度，然后「应用」。也可以「只改推理强度，保留各自模型」，或者「清除」覆盖回到自动分配。

可写范围与单点换模型完全一致：只认当前对话的**直接**子代理、只认设置页配置的模型池、沿用强度能力校验与豁免规则；没有可写目标时卡片如实说明，而不是给一个点不动的按钮。

### 功能八：模型可以调用这条路由 —— `subagent_routes_inspect` / `subagent_routes_update`

两个工具让模型自己查、自己改子代理的路由，不用人点界面：

- **`subagent_routes_inspect`** —— 返回当前对话每个子代理的实际路由、是否可写，以及配置好的模型池与各模型**自己声明**支持的推理强度。
- **`subagent_routes_update`** —— 支持指定子代理、指定团队成员，或「当前对话全部可写子代理」批量换模型 / 强度；也支持只改强度（`keep_model`，沿用各自当前模型）与重置（`reset`）。
- **每次修改带修订号** —— 每个目标有独立 revision，整体有实例 epoch；工具改完界面不会被旧缓存拉回去。批量修改可传 `expected_revisions`，版本对不上就整批失败，而不是互相覆盖。
- **团队成员换模型** —— 通过 AgentTeams 的成员路由服务在同一个成员会话上改下一次请求用的模型：成员名、childId、任务、attempt_id、消息队列与历史全部保留。服务不存在时明确报 `teams-unavailable`，**绝不**退回「删成员重建」这种丢上下文的做法。

### 功能九：停止失效兜底 —— 子代理停不下来时再试一次

宿主处理停止时先在常驻激活表里找子代理，**找不到就静默返回** —— 界面报告「已接受」、按钮变灰，子代理照旧在跑，而且没有任何地方说明原因。

本插件现在包住共用的取消动作：测量宿主的返回值；一秒多后再确认一次运行状态；仍在运行就通过自己的 `/subagent-role-router/stop` 端点重试中断，覆盖两种 id 写法（带 / 不带 `session-` 前缀）与两种授权形状（父会话 / 常驻祖先），并把每次尝试的结果带回界面。**拒绝因此变成看得见的拒绝。**

### 功能十：出生分配策略 —— 默认「池子说了算」

**问题**：宿主会把主对话**正在用的**模型照抄进每个子代理的出生参数。旧逻辑看到「有人指定了模型」就让路——于是所有新子代理都继承主对话的模型，你配的池子形同虚设，得手动逐个切回来。

新增 `birthRoutePolicy` 设置，默认 `pool`：

- **`pool`（默认）**——出生参数里写的模型**不算数**：不在本页白名单里的显式模型会被替换成角色池 / 默认池的条目（其余参数如 token 上限照常保留，并占用一个池道）。**页面白名单内的模型视为有效指定**：精确 `(provider, model)` 对、不同供应商别名 + 同模型名、无斜杠短名（`dnq` → `group/dnq`）三种形状都认，原样放行且不占池道。
- **`explicit`**——恢复旧行为：出生参数里写了模型就放行。
- **优先级**：你在插件面板里亲手点的切换**永远最高**（它在出生之后发生）；AgentTeams 成员与豁免规则命中的孩子不受本策略影响。像 Mnemon 这类自己 spawn 子代理并自带模型的插件，在豁免清单里加一条名字前缀规则即可共存。

### 功能十一：子代理页的上下文 / 用量统计条

子代理对话页的输入框上方多一条紧凑统计（只在子代理页出现，主对话页不显示）：

- **一眼三个数** —— 上下文占用百分比与进度条、输出速度（`70 tok/s`）、缓存命中率与总 token（`缓存 94% 344K tokens`）。
- **点开看明细** —— 上下文已用量与窗口（`104K / 1M`）、系统提示词 / 工具定义 / 对话消息三块占比、总用时、首 token 平均耗时、输出速度、缓存命中、轮次与步数，以及未缓存输入 / 缓存读取 / 缓存写入 / 输出四个不重叠桶。占用 ≥70% 变黄、≥90% 变红。
- **数据全来自宿主已有投影** —— `contextPressure`、`contextBreakdown`、`tokenUsage`、`sessionStats`，**没有新端点、不轮询**；三块都为空时不渲染任何东西，不会留一条空条。

> 为什么 Claude 主题那类插件救不了这一页：它只是**装饰宿主已有的统计 DOM**。宿主那几块胶囊要求 `input` 已定义且 `activity` 为假，投影对子代理没落地时它们根本不渲染，插件就没有可装饰的对象。所以这条统计由本插件自己画。

### 功能十二：这一页允许什么模型，界面和入口都把关

**问题**：白名单此前只有后端在守，而且只守了 `/batch` 与出生分配两条路。子代理在一页只允许 5 个模型的地方真的跑起了名单外的 `codex/gpt-6.1-sol` 和 `gm4/gemini-4-carbon` —— 宿主的模型座位和直接 POST `/select` 都绕过了校验。

**现在三条路一起收口**：

- **菜单只列这一页的模型** —— 按 `GET /subagent-role-router/whitelist` 的 `desired` 裁剪：只留白名单行、保持目录原顺序、整组被裁空的分组不显示；正在跑的模型即便不在白名单里也补进去并打勾；目录里认不得名字的白名单路由按供应商追加到末尾（宁可名字对不上，也不丢可点项）。顶部小字「仅显示本页白名单（N）」，右侧按钮可切回全量。接口读失败或没配池子时保持全量——不因为一次失败把菜单清空。
- **名单外的请求被换掉，而不是被拒绝** —— `/select` 命中名单外时替换路由并在响应里带 `substituted: {from, to}`；`agent/request` 的 seed 不在白名单时通过 `setChildRoute` + `agent.model.select()` 换成白名单里的模型（**seed 原样返回**，不改写宿主已冻结的选择，从下一步起生效）。目标优先同一供应商（换网关内的模型保住凭据、协议与长项），否则取页面配置的第一条；页面没配池子则完全不介入。
- **界面如实告知** —— 替换发生时提示「不在本页白名单，已换成 {model}」，并记住实际生效的路由而不是你点的那一个。同一 (子代理, 请求路由, 目标路由) 只记一次日志。

替换决策本身是纯函数 `pickWhitelistRoute(section, pick)`：已获批返回 `null`、没配池子返回 `null`、否则返回该换成的路由——所以它可以单测，不必跑一个真实会话。

### 其他配置能力

- **单模型** —— 只用 `provider` + `model` 配置一条路由，所有子代理跑在同一个模型上（功能一、二的退化形态）。
- **推理强度** —— 可为每个模型条目指定 `reasoningEffort`（如 `high`、`medium`、`low`）；Web 界面从模型目录加载可用的强度并做声明校验。
- **热重载** —— 设置变更立即作用于下一次派发。
- **干净卸载** —— Cordis 销毁时还原原始服务方法。

## 截图

截图占位 —— 本仓库暂时没有随代码提交的界面图（截图目录在 `_work/` 里，属于易失件，不进仓库）。设置面板、标题栏小动物、批量换模型卡片、路由行都能在装好插件后直接看到。

## 市场

- **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**（DSH 官方市场）：条目 `data/plugins/643048695__dsh-subagent-role-router.yml`，分类 `model`。在 DSH 设置 → 插件 → 市场里可以直接搜到并安装。
- 市场按仓库 URL 抓取根 `package.json` 的 `version` 与 `description`，所以这里改了版本号，市场条目显示的版本随之更新。

## 安装

本插件**未发布到 npm registry**，从仓库安装：

```sh
dsh plugin add github:643048695/dsh-subagent-role-router
```

本地开发安装（`link:` 安装，改代码后重载客户端即可生效）：

```sh
# 检出后把目录本身装成插件（包内 node_modules 会是源码软链）
dsh plugin add link:/path/to/dsh-subagent-role-router
```

装好后在 `设置 → 插件配置 → 子代理路由` 里配置路由；不配置时行为与没装插件一致。

## 配置参数

插件配置即 `cordis.patch.yml` 里 `dsh-subagent-role-router` 条目的 `config` 段；设置面板会写出同一份配置。字段说明见下方「配置」一节。

### 调试开关

| 开关 | 作用 | 默认 |
| --- | --- | --- |
| `DSH_SUBAGENT_ROLE_ROUTER_LOG` | 设成一个**文件路径**后，停止兜底、`REJECT_NOT_LIVE`、`SET_OVERRIDE`、`SUBSTITUTE_WHITELIST`、`SUBSTITUTE_WHITELIST_REQUEST` 五处会把一行带时间戳的记录追加到该文件。不设则不落盘，任何路径都不写。 | 不设 |
| 页面地址带 `?srrLog=1`，或 `localStorage["dsh-subagent-role-router:log"]="1"` | 打开客户端选择器与小动物的调试通道（记录选路/覆盖/故障切换/导航回退）。 | 关闭 |
| `POST /subagent-role-router/debug` | 后端调试端点，返回最近一次记录的载荷；只有 `DSH_SUBAGENT_ROLE_ROUTER_LOG` 设了才会落盘（响应里 `logged` 字段如实说明）。 | — |

调试通道默认关闭的理由：它此前在**每次选择器渲染**时都发一次 POST —— 追 bug 的人照样能开，其他人不该为此付网络开销。

## HTTP 端点

插件在 `http://127.0.0.1` 的 DSH 服务上注册了前缀路由 `/subagent-role-router`（loopback-only，前端用文档相对路径访问）：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /subagent-role-router/route?childId=` | 查一个子代理当前生效的路由（也用来确认后端跑的是哪个构建：`?childId=nothing`） |
| `POST /subagent-role-router/select` | 给一个子代理设置模型/强度覆盖（运行中换模型走的也是这条） |
| `POST /subagent-role-router/clear` | 清除某个子代理的覆盖 |
| `POST /subagent-role-router/stop` | 停止兜底：按两种 id 写法、两种授权形状重试中断子代理 |
| `GET /subagent-role-router/events` | SSE 变更流（选路、覆盖、故障切换、成员路由），25 秒心跳 |
| `GET /subagent-role-router/activity` | 当前对话下子代理的活跃快照 |
| `GET /subagent-role-router/batch` | 批量换模型卡片的数据（可写的直接子代理 + 模型池） |
| `POST /subagent-role-router/batch/select` | 批量设置覆盖 |
| `POST /subagent-role-router/batch/clear` | 批量清除覆盖 |
| `GET /subagent-role-router/whitelist` | 原生白名单镜像的当前状态 |
| `GET /subagent-role-router/exempt-candidates` | 豁免规则的候选值（preset / cwd / 名称前缀） |
| `POST /subagent-role-router/debug` | 调试记录端点（见上方调试开关） |

## 模型可调用的工具

开启后模型可以自己查、自己改子代理路由（实现见 `lib/router-tools.js`）：

| 工具 | 作用 |
| --- | --- |
| `subagent_routes_inspect` | 查当前对话每个子代理的实际路由、是否可写、模型池与各模型支持的推理强度 |
| `subagent_routes_update` | 改一个/一批子代理或团队成员的模型与强度；支持只改强度（`keep_model`）与重置（`reset`），可带 `expected_revisions` 做乐观并发 |

## 发布（Release / Publish）

本仓库**不发布到 npm**。发布 = 打一个 tag 的 commit 推上去：

```sh
npm test                                  # 全绿再发
# 改 package.json 的 version 与 CHANGELOG.md
git add -A && git commit -m "chore: X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话>"
git push origin main && git push origin vX.Y.Z
```

市场条目按仓库 URL 读根 `package.json` 的 `version`，所以版本号就是市场显示的版本；市场描述文案在 `data/plugins/643048695__dsh-subagent-role-router.yml` 里，改 Description 要向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR。完整流程见 [`RELEASING.md`](RELEASING.md)。

## 宿主版本要求

全部 8 个 `@deepseek-ai/*` peer 声明为 **`>=0.1.7-rc.1 <0.3.0-0`**：支持 0.1.7 线及其后的**整个 0.2.x 线**（prerelease 与正式版都放行），0.3.0 起不再声明支持。

要理解这个区间为什么长这样，得先知道 DSH **怎么校验**它。`@deepseek-ai/dsh-app-boot` 对每个 `@deepseek-ai/dsh` / `dsh-*` peer 执行：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

`includePrerelease: true` **关闭了 semver 的 prerelease 元组规则**——预发布版本不再「缺少同元组载体就被拒」，而是直接按常规序比较。两个后果都是反直觉的：

| 上界写法 | `0.2.0-rc.1` | `0.2.0`（正式版） | 说明 |
| --- | --- | --- | --- |
| `<0.2.0` | ✅ 放进 | ❌ **拒绝** | 最坏组合：预发布能装，正式版一发布就把 bundle 摘掉 |
| `<0.3.0` | ✅ | ✅ | 但会一并放进 `0.3.0-rc.1`，超出已验证范围 |
| **`<0.3.0-0`** | ✅ | ✅ | 推荐：0.2.x 全放行，`0.3.0-rc.1` 也挡住 |

上界写错时宿主**不会降级运行**：`loadProfileDirectory()` 对不兼容 bundle 直接抛错，该 bundle 落入 `skippedBundles`，启动时 stderr 输出 `skipping profile bundle "dsh-subagent-role-router"`——插件本体与设置卡片**一起消失**。

`plugin/test/peer-range.test.mjs` 是这条契约的回归护栏：它调用宿主同款的 `semver.satisfies(..., { includePrerelease: true })`，并逐条断言上表的结果。

## 配置

优先用 Web 设置卡片（**设置 → 插件 → 子代理默认模型（dsh-subagent-role-router）**）。

也可以直接编辑 profile 的 patch 文件 `~/.dsh/profiles/<profile>/cordis.patch.yml`：DSH 0.1.7 起设置就存在这里，段名是本插件的 Loader 条目 id `dsh-subagent-role-router`：

```yaml
- id: dsh-subagent-role-router
  name: dsh-subagent-role-router
  config:
    # 单模型
    provider: deepseek-official
    model: deepseek-v4-pro

    # 或多模型：功能一（分配策略）+ 功能二（跨供应商故障转移）
    provider: deepseek-official
    models:
      - model: deepseek-v4-pro
        reasoningEffort: high
      - provider: other-provider     # 换一个供应商的模型
        model: gpt-5.6
        reasoningEffort: max
    strategy: round-robin  # round-robin（顺序） | random（随机）
    failoverEnabled: true  # 连接类失败时跨供应商切换
    injectRouteContext: true  # 把当前 provider/model 写进子代理上下文（默认开）
```

角色候补池（功能四）的写法 —— 每个角色一个数组，**数组长度就是该角色的并发工位数**：

```yaml
    roleMode: true
    # 探索角色：2 个工位
    exploreModels:
      - provider: magpie
        model: antigravity/gemini-3.8-flash
        reasoningEffort: high
      - provider: magpie
        model: workbuddy/mimo-v2.6-pro
    # 规划角色：1 个工位
    planModels:
      - provider: magpie
        model: workbuddy-ai/deepseek-v4.1-flash
        reasoningEffort: max
    # 通用角色：3 个工位
    patchModels:
      - provider: magpie
        model: antigravity/gemini-3.8-flash
        reasoningEffort: high
      - provider: magpie
        model: workbuddy/mimo-v2.6-pro
      - provider: magpie
        model: sensenova/kimi-k3
    roleSlotCooldownSeconds: 15  # 失败后暂停该候选的秒数；0 = 关闭
```

条目可以写成 `provider/model` 字符串，也可以写成上面的对象；`reasoningEffort` 可省略（省略即按目标模型自己的默认档位）。数组为空或缺省时**回落到旧的单值字段**（`exploreProvider`/`exploreModel`/`exploreEffort` 等），所以从旧版本升级不需要改配置。

> **从 0.1.6 及更早版本升级**：旧版把配置写在 `~/.dsh/settings.yaml` 的 `subagent-default-model` 段。0.1.7 会在启动时把该文件**一次性导入并改名**为 `settings.yaml.imported`，改名后不再回读。导入按段名直接当条目 id 用，而本插件的条目 id 是 `dsh-subagent-role-router`，因此旧段**不会被导入**（宿主日志留一条 `section subagent-default-model … was not imported into entry dsh-subagent-role-router`），旧值只留在改名后的文件里——需要手工搬到上面的 `config:` 里。

## 平台支持

**Windows / macOS / Linux 均受支持**，且不需要任何平台专用配置。本插件的运行时代码是**纯 JavaScript**：`lib/index.js`（宿主半边）与 `lib/client.js`（客户端半边）不读取文件系统、不拼接路径、不派生进程、也不判断 `process.platform`——它只消费 DSH 宿主暴露的服务与事件，因此平台差异完全由 DSH 宿主承担。

已被检查并纳入持续验证的平台相关面：

- **配置路径**：profile patch 位于用户主目录下的 `.dsh/profiles/<profile>/cordis.patch.yml`。Windows 上是 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`（通常是 `C:\Users\<你>\.dsh\...`），与 macOS/Linux 的 `~/.dsh/...` 指向同一处约定。
- **依赖树**：`package-lock.json` 同时锁定 Windows 三套可选原生构建（`win32-x64-msvc`、`win32-arm64-msvc`、`win32-ia32-msvc`），npm 只安装与当前平台匹配的那一个；本插件的直接依赖 `@deepseek-ai/schemastery` 是纯 JS。
- **换行符**：仓库未固定 `core.autocrlf`，Windows 检出可能得到 CRLF 源码。全部测试已在该形态下验证通过——解析源码的断言都基于子串而非行尾，因此 CRLF/LF 不影响结果。
- **路径解析**：仓库脚本统一用 `fileURLToPath` 而非 `URL.pathname`。后者在 Windows 上会得到 `/C:/...` 并被 `path.join` 折成不存在的 `\C:\...`，属于只会在 Windows 上暴露的硬故障。
- **测试发现**：`npm test` 直接调用 `node --test`（不带 glob），由 Node 测试运行器自行发现用例，不依赖 shell 展开——`test/*.test.mjs` 这类 glob 在 POSIX sh 下会展开、在 cmd/PowerShell 下会原样传入，行为不一致。

CI 在 `ubuntu-latest`、`windows-latest`、`macos-latest` 三个平台上同时运行同一套测试，因此上述约定有持续验证而非一次性声明。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | — | 字符串类型模型条目的 provider。 |
| `model` | string | — | 单模型 id（向后兼容）。 |
| `models` | array | `[]` | 模型条目列表（string 或 `{provider, model, reasoningEffort?}` 对）。≥2 项时功能一、二才有意义。 |
| `strategy` | string | `round-robin` | 功能一的分配策略：`round-robin`（顺序轮换）或 `random`（随机）。 |
| `failoverEnabled` | boolean | `true` | 功能二：子代理连接类失败时在 `models` 列表内**跨供应商**切换模型（仅 subagent）。 |
| `injectRouteContext` | boolean | `true` | 功能三通路二：向子代理**自己的上下文**注入一行「当前 provider/model」的真实提示词（仅 subagent）。 |
| `reasoningEffort` | string | — | 可选推理强度（如 `high`、`max`）。 |
| `roleMode` | boolean | `false` | 功能四：按派发角色（探索 / 规划 / 通用）分别选路由，而不是共用一份 `models` 列表。 |
| `exploreModels` / `planModels` / `patchModels` | array | `[]` | 功能四：每个角色的候补队列。**数组长度＝该角色可同时跑的子代理个数**；条目为 string 或 `{provider, model, reasoningEffort?}`。为空时回落到旧的三元组字段。 |
| `roleSlotCooldownSeconds` | number | `15` | 功能四：候选失败后暂停多少秒不再用于新派发。`0` 表示关闭冷却。 |

## 子代理连接失败自动切换

开启 `failoverEnabled`（默认开启）后，子代理自身的循环遇到连接类失败时，插件会在 `models` 列表内按 `strategy` 自动切换模型并重试。完整说明见上文「[功能二：跨供应商故障转移](#功能二跨供应商故障转移--这条通了那条不通就换另一个供应商的模型)」，要点复述：

- **跨供应商** —— 候选是整个 `models` 列表，可以切到另一个 provider 的模型，不限于同一家换型号。
- **触发码** —— 连接类：`RATE_LIMIT`、`QUOTA`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`；认证类：`AUTH`、`INVALID_CREDENTIAL`（密钥无效/过期，会切换并打 warn 日志）。其余码不切换。
- `round-robin`：按列表顺序切到下一个模型（队列）。
- `random`：随机挑一个模型（不判断之前是否用过）。
- **需要 ≥ 2 个模型** —— 当 `models` 少于 2 项时本功能不生效。
- **耗尽即放行** —— 列表内全部模型轮试失败后，放行真实错误，不做无限重试。
- **切换时丢弃继承的 `reasoningEffort`** —— 换到新 provider/model 后按默认推理强度请求，避免把主模型的强度强加给不支持它的 provider。
- **Run 内粘性** —— 同一子代理 run 的后续 step 保持在切换后的模型上。

该机制基于官方 `agent/request-error` + `agent/request` 瀑布，且**仅对 subagent 生效**——主代理循环不会被切换。

## 当前路由的可见性

功能三有**两条独立通路**，完整说明见上文「[功能三](#功能三当前路由可见--界面看得见子代理也知道)」：

### 通路一：界面行（给用户）

| 视图 | 呈现内容 | 依据帧 |
| --- | --- | --- |
| 轨迹视图 | 一行「当前供应商/模型：`provider/model`」 | 官方 `request/context` |
| 对话视图 | 「当前供应商/模型」/「已切换到」/「继续使用」三类文案行 | 官方 `request/header`（按 `reason` 区分 `initial` / `change` / `resume`） |

两个视图都在 `ctx.effect` 内注册，且节点 `kind` 使用插件自有值（轨迹侧 `trajectory-subagent-model`，对话侧 `chat-subagent-model-notice`），不占用宿主内置 `context` kind —— 后者会被宿主的可见性规则过滤掉。

### 通路二：提示词注入（给子代理）

见上文的完整说明与样例文本。实现要点：

| 方面 | 做法 |
| --- | --- |
| 取值来源 | `agent/request` 瀑布**结算后**返回的 `{provider, model}`（含故障转移切换结果） |
| 注入时机 | 下一步的 `agent/pre-step`，此时该步消息列表仍可修改 |
| 去重 | 路由不变则不重复注入；路由变化则替换旧行 |
| 作用域 | 仅 `origin === "subagent"`；主代理不碰 |
| 开关 | `injectRouteContext`，默认开启 |
| 消息来源 | `plugin:dsh-subagent-role-router` + `form: "route-context"`（v4 会话格式要求生产者自有 `source.kind`） |

> **两条通路互不替代**：界面行不会进入模型上下文；提示词注入也不会显示在你的界面上。

## 工作原理

```text
请求携带显式 agentOptions
  → subagent-default-model 设置
  → 继承父会话路由
```

插件包装宿主 `ctx.subagents` 服务（`start` / `startContinuable`），覆盖所有派发路径 —— 内置的 `subagent` / `subagent_fork` 工具，以及任何调用该服务但未提供 `agentOptions` 的自定义工具。

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源发布，版权归属：**Copyright (c) 2026 LaoDing**。

MIT 许可证授予任何人免费处理本软件（包括使用、复制、修改、合并、发布、分发、再许可及出售副本）的权利，前提是所有副本或实质性部分均保留上述版权声明与本许可声明；软件按“原样”提供，不附带任何明示或暗示的担保。完整条款见 [LICENSE](LICENSE)。
