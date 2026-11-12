# Changelog

本文件记录本项目的版本历史。

**本项目是 [dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model)（MIT，Copyright (c) 2026 LaoDing）的衍生作品。** 3.0.0 之前的条目由原作撰写，其中的功能、修复与测试记录均属原作工作；本项目的改动从 **3.0.0** 起记录。

## 5.2.0 (2026-11-13)

把桌面线 2.9.0 → 2.9.2 的全部改动并入本仓库。这三版解决的是同一个问题：**这一页允许什么模型，只有后端在把关，界面和别的入口都没有**。

### Added

- **子代理页的上下文 / 用量统计条（桌面 2.9.0）。** 子代理对话页的输入框上方多一条紧凑统计：上下文占用百分比与进度条、输出速度（tok/s）、缓存命中率与总 token 数；点一下展开明细面板——上下文已用量与窗口、系统提示词 / 工具定义 / 对话消息三块占比、总用时、首 token 平均耗时、输出速度、缓存命中、轮次与步数，以及未缓存输入 / 缓存读取 / 缓存写入 / 输出四个不重叠桶。数据全部取自宿主已有的会话投影（`contextPressure`、`contextBreakdown`、`tokenUsage`、`sessionStats`），**没有新端点、不轮询**；主对话页不显示，只有子代理页才有。挂在 `conversation.composer.dock` 槽，三块投影都为空时不渲染任何东西。
- **子代理页的模型菜单只列这一页允许的模型（桌面 2.9.1）。** 菜单此前摊开宿主全量目录，选一个页面白名单外的模型照样能点。现在按 `GET /subagent-role-router/whitelist` 的 `desired` 裁剪：只留白名单里的行、保持目录原顺序、整组都被裁空的分组直接不显示；当前正在跑的模型即便不在白名单里也补进去并打勾（否则菜单里看不出现在是谁在跑）；目录里认不得名字的白名单路由按供应商追加到末尾，宁可名字对不上也不丢可点项。列表顶部一行小字说明「仅显示本页白名单（N）」，右侧按钮可切回全量。接口读失败或这一页根本没配池子时保持全量——不因为一次失败把菜单清空。
- **名单外的选择被换成白名单内的模型，而不是被拒绝（桌面 2.9.2）。** 这条修复的是一次真实事故：子代理在只允许 5 个模型的一页上真的跑起了 `codex/gpt-6.1-sol`，随后又跑起 `gm4/gemini-4-carbon`——两个都不在名单里。原因有两个入口绕过了所有校验：宿主自己的模型座位，以及直接 POST `/select` 的客户端。现在两条路都收口——`/select` 命中名单外时替换路由并在响应里带 `substituted: {from, to}`；`agent/request` 的 seed 不在白名单时通过 `setChildRoute` + `agent.model.select()` 换成白名单里的模型（seed 本身原样返回，不改写宿主已冻结的选择，从下一步起生效）。替换目标优先同一供应商（换网关内的模型保住凭据、协议与长项），否则取页面配置的第一条。界面在替换发生时提示「不在本页白名单，已换成 {model}」，并记住实际生效的路由而不是用户点的那一个。

### Changed

- **白名单口径统一到一处。** `hostWhitelistModels(section)` 之外新增 `pickWhitelistRoute(section, pick)`：已获批返回 `null`（不介入）、页面没配池子返回 `null`（无路可换）、否则返回该换成的路由。替换逻辑因此可单测，不必跑一个真实会话。同一 (子代理, 请求路由, 目标路由) 只记一次日志，避免每一步刷一行。
- **开关文案改成说它做的事。** 「只看白名单」改为「显示白名单模型」/ "Whitelist models"——默认已经是只列白名单，这个按钮是把全量放出来。

### Notes

- 构建标记：`ROUTER_BUILD` = `2026-11-12.1`，`DSM_CLIENT_BUILD` = `2026-11-12.2`。
- 测试 **269 项：267 通过 / 0 失败 / 2 跳过**（两项跳过是 `real-directory` 的环境相关用例，不设环境变量时如实跳过）。新增 `test/stats-render.test.mjs`（5 例）、`test/picker-whitelist.test.mjs`（5 例）、`test/whitelist-enforce.test.mjs`（8 例）。
- 三处 `fs.appendFileSync("C:/Users/<name>/…")` 在合并时已按本仓库规矩改成 `trace()`（由 `DSH_SUBAGENT_ROLE_ROUTER_LOG` 开启，不设则完全不落盘），`no-hardcoded-paths` 门保持全绿。

## 5.1.0 (2026-11-09)

把桌面线 2.7.7 → 2.8.2 的全部改动并入本仓库（与 5.0.0 合并的桌面版本线相接）。

### Added

- **小动物点击直达（桌面 2.7.8）。** 点小动物用宿主自己的「父会话 + 子会话 + 会话类型」地址对象跳转，不再依赖裸字符串调用；导航不可用时回退为打开面板并记诊断日志。悬停有简易标题（任务名 + 路由）。
- **子代理页面显示整窝（桌面 2.7.9）。** 在子代理自己的会话页锚到所属主对话，显示同一窝正在跑的兄弟，条首有「↩ 主对话」。
- **普通子代理数据腿（桌面 2.8.0）。** 团队成员走宿主会话清单，普通子代理不在其中：插件额外挂一条活动通道——挂载拉一次台账、收到开始/结束推送帧防抖重拉、打开面板时刷新——不轮询；清单优先，台账只补充。
- **出生分配策略（桌面 2.8.1 / 2.8.2）。** 新增 `birthRoutePolicy`（默认 `pool`）：宿主照抄父对话模型的出生参数不再让池子失效——白名单外的显式模型被替换成角色池/默认池条目（并占一个池道）；页面白名单内的指定（精确路由、供应商别名 + 同模型名、无斜杠短名）原样放行且不占池道。面板手动切换永远最高优先；`explicit` 恢复旧行为。

### Fixed

- **换模型改走宿主正门（桌面 2.8.0）。** 宿主 rc.5 起把每个 step 的模型选择在准备期钉死并加守卫，旧的 waterfall 改写会被拒绝并弹「`use agent.model.select() before step preparation`」。现在面板切换与故障转移都调 `agent.model.select()`，报错消失；切换在下一步/下一轮生效（重试中途换不了是宿主语义，如实记录），换不了的对象在响应里如实带 `applied` 字段。故障转移不再在当步重试里生效，而是下一步起生效。
- **小动物消失（React #310，桌面 2.7.10）。** 重挂效果被排在空态早退门之后，首帧少 hook、子代理出现后多 hook，槽位边界因此永久让位。效果已移回 hooks 区。
- **HTTP 端点前缀统一为 `/subagent-role-router`**（5.0.0 合并时保留了桌面线的 `/subagent-router`，与仓库名不一致；文档与代码现在一致）。
- **`scripts.test` 恢复显式枚举**（5.0.0 合并时退回了裸 `node --test`，本仓库的测试纪律要求逐个登记）。

### Notes

- 构建标记：`ROUTER_BUILD` = `2026-11-09.1`，`DSM_CLIENT_BUILD` = `2026-11-09.1`。
- 测试 **251 项：249 通过 / 0 失败 / 2 跳过**（两项跳过是 `real-directory` 的环境相关用例，不设环境变量时如实跳过）。

## 5.0.0 (2026-11-02)

这一版把两条开发线合成了一条。

仓库此前一直在 4.x 上维护「派发」这一半：角色路由、候补池、故障转移、fork 切片、实时换模型、豁免规则、原生白名单镜像、停止兜底。桌面上实际在跑的插件版本另外长出了「观察与干预」这一半：批量换模型、标题栏小动物、模型可调用工具、SSE 推送，以及一轮订阅与渲染的性能收口。两条线的代码此前**没有一处共享** —— 装了市场版就没有小动物，用桌面版就没有 4.x 的停止兜底与实时换模型。5.0.0 之后它们是一份代码。

### Added

- **标题栏小动物（2.5.0）。** 会话标题行右端最多三只像素小人，一只对应一个正在运行的子代理，六个角色造型按 childId 哈希稳定分配。点开面板每行给出运行时长（`42秒` / `3分07秒` / `1小时05分`）与消耗（`1.2万 tokens`），两个数都取自宿主给子代理会话的投影（`subagentTiming`、`tokenUsage`）——没有为此新加端点、也不轮询。点一行用宿主自己的 `ctx.uiWorkspace.openSession` 进入那个子代理的对话（宿主子代理目录点开用的是同一个调用），点完面板自动收起；Tab 到某行按回车/空格同样能进。
- **面板跟随与自适应（2.7.2 – 2.7.5）。** 面板按窗口定位：右边缘贴按钮、上下挑有空间的一侧展开、高度不超过窗口剩余空间，窗口缩放与滚动时跟着重算；高度上限约六成屏幕、超出在面板内滚动；宽度按内容收（`max-content` + `max-width`）；行文本是好读的预设短语，真实标签留在悬停提示里；路由未知时不印 `?/?`，开工时间未知时不印 `—`。
- **批量换模型（2.4.0）。** 子代理卡片上的「⇄ 批量」：勾选目标、选模型与推理强度、应用。也可以只改强度保留各自模型，或者清除覆盖回到自动分配。可写范围与单点换模型一致：当前对话的直接子代理、设置页里的模型池、同一套强度校验与豁免规则。
- **模型可调用工具（2.6.0）。** `subagent_routes_inspect` / `subagent_routes_update`：查每个子代理的实际路由、是否可写、模型池与各模型**自己声明**的强度；改单个、批量或团队成员，支持只改强度（`keep_model`）与重置（`reset`）。每个目标带独立 revision、整体带 epoch，批量可传 `expected_revisions` 做乐观并发；团队成员走 AgentTeams 的成员路由服务，保留成员名、childId、任务、attempt_id、消息队列与历史，服务不存在时明确报 `teams-unavailable`，绝不退回复制一份新成员。
- **SSE 变更推送（2.7.0 – 2.7.1）。** `GET /subagent-role-router/events`：选路与清除立即广播，覆盖与故障切换按「提供方|模型|强度」签名去重后广播，25 秒心跳、hello 帧、仅回环可连。子代理卡片与批量入口因此**不再轮询**：改订宿主 sessions store（按运行中/来源/父会话/更新时间签名比对）加这路 SSE；窗口重新聚焦时核对一次；SSE 连续断 3 次自动降级为纯 store 信号并限速重试，恢复后自动升级回来。

### Changed

- **订阅收窄（2.7.6）。** 标题栏此前订阅整张会话表，任何会话的投影刷新都会重跑组件；子代理每多花一个 token 还会让整行重建（离线回放实测比无关刷新多一倍组件执行）。现在只订阅「这个父会话下面有哪些子代理在跑」折成的一个字符串签名，宿主对选择器结果按值比较（`useSyncExternalStoreWithSelector` → `Object.is`），签名没变就不重渲染；行数据在真正需要时从会话 store 现读。
- **数字只在面板打开时算（2.7.6）。** 时长与 token 从行里移出，改成面板自己的状态，由一个共用的一秒计时器刷新（此前每行各挂一个 interval，40 行就是 40 个计时器）；面板关着时零成本，行顺序固定按 spawn 时间。
- **SVG 缓存（2.7.6）。** 角色图形是静态的，按「阶段 + 角色」缓存同一个 React 元素，重渲染不再重建每只约 54 个 `<rect>` 的图形。
- **小动物不再漂移（2.7.1）。** 此前写死 `top:47px/right:28px`，宿主界面加标签栏后正好压在标题栏空档；现在运行时测量标题行位置贴上去，窗口缩放、滚动、布局变化都跟随，量不到就留在按钮行原位。
- **文档重写。** 中英文 README 补齐观察与干预四条能力、HTTP 端点表、工具表、调试开关，以及新的安装与发布说明（本仓库不发布到 npm，市场条目按仓库 URL 读根 `package.json`）。截图不再从上游仓库热链。

### Fixed

- **调试日志不再写死路径。** 停止兜底、`REJECT_NOT_LIVE`、`SET_OVERRIDE` 三处此前直接 `appendFileSync("C:/Users/<name>/.dsh/…")` —— 在任何别人的机器上必然失败且被静默吞掉。现在统一走可选的 `DSH_SUBAGENT_ROLE_ROUTER_LOG` 环境变量，不设就完全不落盘。
- **测试夹具里的本机绝对路径。** `test/fork-window.test.mjs` 改走 `tools/dsh-session-resolver.mjs`；`test/real-directory.test.mjs` 只在设了环境变量时才跑，否则如实 skip。
- **行数据首次出现时不再少一轮时长与 token**（此前新行先以空指标入列，要等下一次事件才补齐）。

### Notes

- 构建标记：`ROUTER_BUILD` = `2026-11-02.6`（后端本轮未改），`DSM_CLIENT_BUILD` = `2026-11-02.7`。用 `GET /subagent-role-router/route?childId=nothing` 可以确认实际加载的是哪一版后端。
- 测试 **232 项：230 通过 / 0 失败 / 2 跳过**。两项跳过是 `real-directory` 的环境相关用例，不设环境变量时如实跳过。

## 4.2.1 (2026-10-30)

### Fixed

- **测试夹具里的本机绝对路径。** 4.2.0 清掉了运行时代码的写死路径，但测试没清：`test/fork-window.test.mjs` 里还列着作者的检出目录与两处 DSH Desktop 安装目录，`test/real-directory.test.mjs` 也把一个提取路径当默认值。仓库是公开的，这些字符串会连同本机用户名一起发出去，在别人机器上又指向不存在的位置。现在 `fork-window` 统一走 `tools/dsh-session-resolver.mjs`（跨平台、只认环境变量与平台默认位置），`real-directory` 改成只有设了 `DSH_MODEL_SELECTION_SRC` 才跑、否则如实 `skip`。

### Added

- **`test/no-hardcoded-paths.test.mjs`（3 项）**：扫描 `lib/`、`test/`、`tools/` 与根清单文件，出现用户主目录、Windows 用户目录、DSH Desktop 安装目录即失败；另有一项反向自检（扫到的文件数不足就判红），避免守卫因为「什么都没扫到」而永远通过，还有一项确认 `TRACE_PATH` 仍是环境变量门控、默认分支在任何 I/O 之前返回。

### Changed

- 测试 101 → 102 项（`real-directory` 的环境相关用例在不设环境变量时计为 skip），十组 → 十一组。
- 文档补上 `DSH_SUBAGENT_ROLE_ROUTER_LOG` 与客户端 `?srrLog=1` 两个调试开关的说明——4.2.0 引入了它们却没写进 README。

## 4.2.0 (2026-10-30)

### Added

- **停止失效兜底（功能十）**：宿主处理停止时先在常驻激活表里找子代理，找不到就**静默返回** —— 界面报告「已接受」，按钮变灰，子代理照旧在跑，且没有任何地方说明原因。本插件现在包住共用的取消动作，测量宿主返回值，一秒多后再确认一次；仍在运行就通过自己的 `/subagent-role-router/stop` 端点重试，覆盖两种 id 写法（带/不带 `session-` 前缀）与两种授权形状（父会话 / 常驻祖先），并把每次尝试的结果带回界面。拒绝因此变成看得见的拒绝。
- **`/subagent-role-router/stop` 端点**，以及导出给测试的 `interruptChildNow`：这是唯一知道宿主中断接口形状的地方，而形状错了在生产里完全不可见（宿主自己会吞掉未命中），所以必须被直接验证。
- **`test/stop.test.mjs`（4 项）**：第一个 id 写法即被接受、某一写法抛错后仍继续、无可停对象时说明原因、以及常驻祖先这条授权路径。

### Fixed

- **调试日志不再写死路径。** 4.1.0 里有两处直接写 `C:/Users/A6430/.dsh/live-route-access.log`（本机绝对路径），另有一处调试路由每次被调用都往 `~/.dsh/live-route-debug.log` 追加 —— 前者在任何别人的机器上必然失败且被静默吞掉，后者会让文件无上限增长。现在统一走可选的 `DSH_SUBAGENT_ROLE_ROUTER_LOG` 环境变量：不设就完全不落盘，调试端点返回 `logged: false` 如实说明。
- **客户端调试通道默认关闭。** 它此前在**每次选择器渲染**时都发一次 POST；现在只有页面地址带 `?srrLog=1`、或本地存了开关时才启用。追 bug 的人照样能开，其他人不再为此付网络开销。

### Changed

- 后端构建标记 `ROUTER_BUILD` 与前端构建标记同步到 `2026-10-30.1`，便于用 `GET /subagent-role-router/route?childId=nothing` 确认实际加载的是哪一版。
- 测试 95 → 101 项，九组 → 十组。

## 4.1.0 (2026-10-29)

这一版把「配好就不管」推进到「跑起来也能改」，并补上了一个此前**静默不可达**的坑。

### Added

- **运行中实时换模型（功能七）**：拦 `agent/request` waterfall，让一个正在跑的子代理在下一步请求就换到另一个模型/推理强度，不必中断或重派。覆盖按子代理 id 隔离、`agent/disposed` 时清理、主会话请求永不经过；agent-teams 成员可手动换（自动 failover 仍豁免团队）。继承来的 `reasoningEffort` 会被丢弃，避免「思考强度必须与供应商一致」的 provider 直接拒请求。
- **`/subagent-role-router/route` 端点**：`GET route?childId=…` 查当前路由，`POST select` / `POST clear` 修改；POST 强制 `content-type: application/json`，等于顺带做 CSRF 防护。响应里带 `build`（`ROUTER_BUILD`），用来回答「磁盘上的改动到底有没有被 cordis 重载进去」。
- **豁免规则（功能八）**：按 preset / cwd 前缀 / 名称前缀匹配，命中后可**完全豁免**（不注入路由）或**钉住出生模型**（只决定出生，不占候补工位、不参与轮换）。编辑器候选来自插件实际观察到的出生身份，持久化在 `~/.dsh/subagent-role-router-candidates.json`（≤200 条，按最后出现时间淘汰；preset id 的版本段入库前剥离）。
- **原生白名单镜像（功能九）**：宿主 `subagent` 工具自带一份模型白名单，不在名单上的模型即使显式传参也会被拒 —— 也就是说，只在设置页配了路由，那条路由对显式派发其实是**不可达**的。现在把设置页的模型幂等镜像进去（`hostWhitelistModels` / `syncHostWhitelist` / `sameWhitelist`），并在 `tools/execute` 之前用白名单唯一匹配补全裸模型名的 provider（`planDelegatedModelRoute` / `repairDelegatedModelName`）；匹配不到或不唯一则不动。
- **`GET /subagent-role-router/whitelist`**：解释上一次白名单同步的结果（同步失败只 warn，不拖垮插件）。

### Changed

- **已验证宿主版本 0.2.1-rc.2 → 0.2.1-rc.3**（当前桌面版内置核心）：`peerDependencies` 的三段区间本来就接住了 0.2.1 线，所以宿主侧无需改声明。`devDependencies` 仍锁 `0.2.1-rc.2` —— 试过抬到 rc.3，但 rc.3 的 `dsh-session` 带来 `dsh-scope@0.2.1-rc.3` peer，与其余仍解析在 rc.2 的 peer 树冲突（`npm install` 直接 `ERESOLVE`）。测试的约束是「能装能跑」，不是「跟宿主的补丁号一模一样」。
- **测试 48 → 95 项，四组 → 九组**：新增 `live-route`、`exempt-rules`、`team-model`、`whitelist-sync`、`real-directory` 五组。
- 文档更正：平台支持一节原先写「运行时代码不读文件系统」，功能八的出生身份缓存使其不再成立，已改为如实说明那一处 JSON 读写及其失败静默策略。

## 4.0.0 (2026-10-21)

每个角色的路由从**一条**变成**一个候补队列**：同一个角色可以配多个模型，按忙闲顺延，全忙时溢出共享，失败进冷却。

### Added

- **角色候补池（`exploreModels` / `planModels` / `patchModels`）**：每个角色的路由不再只能配一条，而是一个有序的候补队列，**数组长度＝该角色可同时运行的子代理数**。派发时按「占用最少、并列取靠前」挑一条：第 1 个任务给候补 1，候补 1 在跑时第 2 个给候补 2，三个候补全忙时第 4 个任务**不排队**，而是溢给当前占用最少的那个 —— 「3 候补 + 4 并发」的分布是 **2/1/1**。工位在子代理结算（`receipt.result` settle）时归还；`startActivation` 抛错时立即归还。
- **失败冷却（`roleSlotCooldownSeconds`，默认 15 秒）**：某条候补调用失败后暂停使用，后续派发直接跳过它；填 `0` 关闭。冷却只影响**新派发**，已在跑的子代理由故障转移就地处理。全部候补都在冷却时**仍然照常派发**（忽略冷却挑一个）并打 warn，而不是拒绝派发把子代理弄死。
- **角色内 failover**：候补池 ≥2 条时，子代理运行中的失败切换**限定在该角色自己的候补队列内**，不会跳到别的角色的模型上。单候补角色仍回落到 `models` 基础池，行为与 3.1.0 一致。
- **候选不可用识别（`isUnusableCandidate`）**：新增 `CANDIDATE_UNUSABLE_CODES`（`UNKNOWN_MODEL` / `NO_ADAPTER` / `UNSUPPORTED_REASONING_EFFORT` / `INVALID_CONFIG`）与 `MODEL_UNAVAILABLE_PATTERN`。网关用 400 明确告知「这个模型你的账号用不了」时（如 `model [x] is not allowed for user type [...]`、`no such model`、`knows no model`），该候补被识别为不可用 → 跳过并冷却，并打一条点名该路由的 warn。**边界刻意保留**：真正的请求格式错误（如消息结构不合法）仍是 `INVALID_REQUEST` 但**不**触发切换，直接抛出 —— 否则一个代码 bug 会把整个候补队列烧光。
- **设置卡片支持多行候补**：三个角色卡下方可「＋ 增加候补」/「－ 移除」（只剩 1 行时禁用移除），每行复用原有的 provider / model / effort 三级联动与 effort 声明校验；新增冷却秒数数字输入（0-3600，默认 15，`0` 保留为有效值）。
- **新测试文件 `test/schema-pool.test.mjs`**（5 项），以及 `router-audit` 新增 12 项、`client-audit` 新增 6 项。总数 24 → **48 项**。

### Fixed

- **「用不了的候补」会一直赢下工位、把队列堵死**。实测发现：一个被网关以 `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]` 拒绝的候补，被适配器归类成通用的 `INVALID_REQUEST`（请求格式错误），而这一类既不在 `FAILOVER_TRIGGER_CODES` 也不在 `FAILOVER_ELIGIBLE_CODES` 里 —— 于是它既不顺延也不冷却。它跑不到一秒就失败，因此**永远显示为空闲**，每次派发都赢下工位然后失败一次。现在这类「指名模型」的 400 被单独识别为候选不可用（见上），跳过并冷却。
- **候补条目不带 `reasoningEffort` 会被 schema 挡掉**：设置界面的序列化不会为未填写的推理强度产出该键，而原 `MODEL_ENTRY` 的对象分支把它声明为必填，导致保存被拒。候补池改用独立的 `POOL_ENTRY`，其对象分支 `reasoningEffort` 带 `.default("")`。

### Changed

- **`applyDefaultModel` 拆成 `routeDelegation` + 薄封装**：`routeDelegation(state, request, label, reserve)` 返回 `{ request, lease }`，`lease.release()` 负责归还工位；`applyDefaultModel` 保留为 `.request` 的兼容封装。
- **`installFailover` 的闸门顺序重排**：先判 `signal?.aborted` / 是否子代理 / 是否可切换失败 → **再写冷却** → 最后取 failover 视图。这样单候补角色也能进冷却（原来取不到视图就直接 `next()`，冷却永远写不进去）。
- **fork 分支不占工位**：`hookForkProvider` 的 `fork.start` 包装走 `routeDelegation(..., reserve=false)`，因为 fork 分支拿不到 receipt，占了工位就永远还不了。
- **旧配置自动兼容**：只配了旧三元组（`patchProvider` / `patchModel` / `patchEffort`）时按「一行候补」处理；保存候补池时把**第一行同步写回**这三个旧字段，便于回退。
- 设置指纹（`savedFormFingerprint`）纳入三个角色池与冷却秒数，避免 describe mirror 滞后时把旧候补列表复活。
- 版本号 3.1.0 → **4.0.0**。新增能力 + 两处行为变更（failover 闸门顺序、fork 不占工位），按 semver 走 major。

### Tests

- **48 项全通过**（fork-window 8 + router-audit 21 + client-audit 14 + schema-pool 5）。
- 新增的候补池测试覆盖：单候补等价性、忙则顺延、3 候补 4 并发的 `2/1/1`、结算后工位归还、失败冷却、冷却归零、全部冷却仍派发并 warn、显式模型不占工位、角色内 failover、候选不可用识别与误判边界。
- **`test/fork-window.test.mjs` 继续走 `tools/dsh-session-resolver.mjs`**（找不到真实 `Session` 时 skip 而非 fail），本次未改其解析逻辑。

## 3.1.0 (2026-10-17)

适配 **DSH 0.2.1-rc.2**。这一版的核心是：0.2.x 把 fork 后端的内部实现整体重写了，3.0.0 依赖的两个宿主接口都没了。**功能没有减少，但实现路径换了一条更稳的。**

### Fixed

- **fork 窗口切片在 0.2.x 上静默失效**。3.0.0 通过 `@deepseek-ai/dsh-subagent-in-process-driver` 的 `startInProcessRun` 自己起进程，再挂 `fork.start`。0.2.x 里**这个 driver 包已被删除**，`fork.start` 也不存在了 —— 加载失败后只打一行 `console.warn` 就回退原生，用户看到的现象就是「切片没生效，旁问照样超时」，而日志里没有任何报错。

  **改法**：不再碰 driver，也不再碰 `start`。0.2.x 的 fork 后端只暴露**一个**方法 `prepareContinuable(request)`，返回 `{ seed }`；插件包住它，拿到返回值后重写 `seed` 再交回。这比原来「绕过 provider 自己启动」干净得多 —— 不复制宿主的启动逻辑，宿主怎么改都不会跟着漂移。`nativeForkDriver()` 与 `createRequire` / `path` 的导入一并删除。

- **`IconChevronDownOutline14` 在 0.2.x 的 primitives 里已被删除**。原代码按 `Regular || Medium || 14` 三级探测，虽然能降级不崩，但第三级已是死代码，留着会误导下一个读者以为还有兼容价值。现只探测仍在导出的两个名字。

### Changed

- **peer 范围从一行改成三段**：`>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`。原因不是想支持更多版本，而是原来那行 `>=0.1.7-rc.1 <0.3.0-0` **在 npm 侧是漏的**：宿主校验用 `includePrerelease: true`（宽松，0.2.1-rc.2 能过），但 npm 解析 peer 时**不带**这个开关，而 semver 默认要求预发布版本必须由**同元组**的比较符接住。结果就是 `0.2.0-rc.1`、`0.2.1-rc.2` 这类预发布宿主「装得上、但 `npm install` 报 ERESOLVE」。分段后两侧同时成立。
- **devDependencies 升到与验证环境一致**：`dsh-session` / `dsh-settings` `0.2.1-rc.2`、`schemastery` `3.18.5`、`cordis` `~4.0.5`。锁定精确版本而非 `^`，因为这一族包的 peer 之间**互相钉死同号**（`dsh-agent@0.2.1-rc.2` 硬要求 `dsh-session@0.2.1-rc.2`），浮动区间会立刻 ERESOLVE。
- 版本号 3.0.0 → **3.1.0**。新增能力为零、修复两项、破坏性变更为零，按 semver 走 minor。

### Added

- **新测试：`0.2.x fork backend without start is still sliced through prepareContinuable`**。手工构造一个只有 `prepareContinuable`、没有 `start` 的 provider（即 0.2.x 的真实形状），断言 seed 被切到 2 轮 = 6 条事件、卸载后 provider 方法被还原。原测试套件里的 mock 带 `start`，**抓不到这个回归** —— 这正是 3.0.0 在 0.2.x 上静默失效却没被测试拦住的原因。

### Tests

- 24 项全通过（原 23 项 + 新增 1 项），三组测试均无需 DSH Electron 即可在普通 Node 下运行：`npm install` 后 `@deepseek-ai/dsh-session` 作为依赖落到 `node_modules`，`tools/dsh-session-resolver.mjs` 的第 2 条解析路径直接命中。
- `test/fork-window.test.mjs` 在找不到真实 `Session` 时**跳过而非失败** —— 够不到被测对象不等于代码有错。

## 3.0.0 (2026-10-16)

本项目作为原作的下游分叉首次发布，在原作 2.1.4 的基础上新增三项能力，并完成一轮完整自审。

### Added

- **按角色路由（roleMode）**：派发时按「这个子代理要干什么活」把它送到对应角色的模型上，支持 explore（探索）/ plan（规划）/ patch（修补）三个角色，每个角色可独立配置 `provider` / `model` / `reasoningEffort`（9 个字段）。角色留空时回落到 `models` 列表。角色判定分四级：显式标签（`[explore]`、`【探索】`、`[scout]`、`[coder]` 等中英写法）→ 来源识别（BTW 旁问标签 `michengai-btw:` 一律判 explore）→ 关键词兜底 → 兜底默认 patch（拿不准的活按「要动代码」对待，宁可给强模型）。
- **fork 活跃窗口切片（forkWindowSlicing / forkWindowTurns）**：长会话里走 `subagent_fork` 的派发（如旁问「这里不理解」）会卡到超时。根因是 fork 默认把父会话**全部原始事件**复制给子会话——60 轮会话 6000+ 事件、约 25MB，跨进程序列化即卡死。现只取最近 N 轮（默认 3）并重建为从 `seq: 0` 连续编号的合法事件序列，实测种子从 ~25MB 降到 ~5KB。新增 `lib/fork-window.js`（`buildWindowSlicedSeed(parent, maxTurns, completedSeed)` / `isSurfaceEligibleType(type)`）。
- **agent-teams 豁免**：`agent-teams` 团队成员的派发不做切片、不做故障转移、不做提示词注入——团队协作依赖完整历史，切片会让队员丢上下文。识别依据为标签前缀 `agent-teams:` 与子会话描述符帧 `subagent/descriptor`（标签实际存在子会话自己的描述符里，不在 `SessionHeader`），扫描下界用 `inheritedEventCount`。
- **`injectRouteContext` 开关**（默认开）：可选择是否把当前 provider/model 写进子代理上下文。
- **`showChatModelNotice` 开关**（默认关）：对话视图中的模型变更提示行可关闭。

### Changed

- 包名 `dsh-subagent-default-model` → `dsh-subagent-role-router`，作者与仓库地址改为本分叉维护者；版本从 2.1.4 起算为 3.0.0（下游分叉自有版本线）。
- 自建 `createUserMessage`（`node:crypto` 的 `randomUUID`）替代从 `@deepseek-ai/dsh-llm` 导入，减少对宿主包内部实现的依赖。
- 插件图标换为自有设计（一入三出的路由示意图），不再沿用原作品牌图标。

### Fixed

- **切片绝不静默产出损坏上下文**：`lib/fork-window.js` 在映射不完整时一律返回 `null` 回退原生行为，包括——窗口内无完整 `turn/end`、`developer/message` 的 `headerSeq` 映射不到窗口内、`sourceEventSeqs` 映射后长度不一致、压缩摘要内容块无法原样保留（不再字符串化内容块）。切片全程只读，从不修改父会话。
- **压缩摘要的来源不再伪造**：prior-summary 分支的消息来源由 `{kind:"compaction"}` 改为插件自有 `{kind:"plugin:dsh-subagent-role-router", form:"prior-compaction-summary"}`——DSH v4 会话格式要求生产者使用自有的 `source.kind`。
- **显式模型选择不再被覆盖**：判定「显式指定」只看 `agentOptions.model` / `agentOptions.provider`；仅给 `maxTokens` / `toolFilter` 不再算显式模型，从而保留调用方的 token 与工具控制。
- **round-robin 改为每子代理一次**：原先每请求都推进游标，导致同一子代理内部反复轮换；现只在派发时取一次。
- **卸载不覆盖后来者**：还原服务方法前按 `raw[key] === wrapped` 判定，避免把在本插件之后安装的包装一起拆掉。
- **每个配置字段都带默认值**：DSH 的设置界面由 `projectForm()` 构建，会**丢弃**解析值为 `undefined` 的字段；一个无默认值的 `z.string()` 在界面上等于不存在，保存时会报出误导性的 `notApplied:ready:writable=true`。
- **前端 `forkWindowTurns` 校验与后端一致**：强制 `[1,20]` 正整数、默认 3，表单 diff、保存与 `discard()` 三处统一（原先 `discard()` 的判据与校验不一致）。

### Tests

- 测试套件 23 项全通过，分三组：`test/fork-window.test.mjs`（切片映射与安全回退，用**真实** `@deepseek-ai/dsh-session` 的 `Session.create` / `deriveMessages` 验证种子连续性合法性）、`test/router-audit.test.mjs`（路由判定、显式覆盖保留、round-robin 每子代理一次、并发团队 fork 不改动而普通 fork 切片、团队描述符豁免、卸载还原、主会话不受影响）、`test/client-audit.test.mjs`（Cordis `apply.inject`、`forkWindowTurns` 校验与边界、提示开关同步、订阅与定时器清理）。
- 新增用例：`summary content blocks are preserved without string coercion`、`cross-window header, replacement and source references safely fall back`。

### Note

- 2.1.4 之前的条目（含 2.1.4）为原作历史，完整保留以存档。其中提到的 `scripts/mock-llm-server.mjs`、`scripts/simulate-retry.mjs` 等脚本随原作 `plugin/` 目录发布，本分叉不再包含。
- 已知边界：窗口切片取的是**事件级最近 N 轮**，不等于读取上下文压缩（ACP）的实际活动窗口；两者目标一致但不是同一数据源。

## 桌面版 2.x 线（2.2.0 – 2.7.6）

以下是桌面上实际在跑的那条线的历史，与上面的 4.x 条目是**并行开发的两个分支**（2.2.0 与 4.0.0 同为 2026-10-21）。5.0.0 把两条线合成了一份代码，条目保留原样以便对上当时的版本号。

## 2.7.6 (2026-11-02)

### Changed

- **小动物不再跟着别人的 token 一起重画。** 以前标题栏订阅整张会话表，任何会话的投影刷新都会重跑组件；子代理每多花一个 token 还会让整行重建（实测比无关刷新多一倍组件执行）。现在只订阅「这个父会话下面有哪些子代理在跑」这一条折成字符串的签名，宿主按值比较，签名没变就不重渲染；行数据在真正需要时从会话 store 现读。
- **时长和 token 只在面板打开时算，其余时间零成本。** 数字从行里移出，改成面板自己的状态，由一个共用的一秒计时器刷新（以前每行各挂一个 interval，40 行就是 40 个计时器）；面板关着时不会派生任何数字，行顺序也固定按 spawn 时间，不会因为新一轮 `since` 变化而重排。

### Fixed

- **同一只小动物的 SVG 只建一次。** 角色图形是静态的，按「阶段 + 角色」缓存同一个 React 元素，重渲染不再重建每只约 54 个 `<rect>` 的图形。
- **行数据首次出现时不再少一轮时长/token**（此前新行先以空指标入列，要等下一次事件才补齐）。

## 2.7.5 (2026-11-02)

### Added

- **点面板里的一行，直接跳到那个子代理的对话。** 用的是宿主自己的导航服务（`ctx.uiWorkspace.openSession`，宿主子代理目录点开用的是同一个调用），点完面板自动收起；键盘 Tab 到某行按回车/空格同样能进，鼠标悬停会说明这一点。

### Fixed

- **面板宽度按内容收，不再固定 320 像素留一片空白。** 改 `width:max-content` + `max-width:min(320px,86vw)`，行内间距 10 像素、短语不再抢剩余宽度、时长右对齐；内容短时面板就是那么窄，长 token 数也不会撑出屏幕。

## 2.7.4 (2026-11-02)

### Changed

- **面板每行改成报数字：干了多久、花了多少 token。** 上一版每行只剩一句「正在认真打磨」，占着地儿却不说明状态；现在短语缩成 4 个字，后面紧跟运行时长（`42秒` / `3分07秒` / `1小时05分`，含已完成轮次的累计）和消耗（`1.2万 tokens`，按万/亿缩写）。两个数都直接取宿主给子代理会话的投影（`subagentTiming`、`tokenUsage`），没有新端点、不轮询；宿主没给数据时整列不显示，不会印出 `0 tokens`。

## 2.7.3 (2026-11-02)

### Fixed

- **面板还是被裁。** 2.7.2 只给面板加了高度上限，但面板是挂在标题行按钮里的绝对定位元素，而宿主给那一行动作区设了固定高度加裁剪，结果面板左边一列和下面的行都被切掉。现在面板改成按窗口定位：每次打开都重新量按钮位置，右边缘贴按钮、上方或下方挑有空间的一侧展开，高度不超过窗口剩余空间；窗口缩放或滚动时跟着重算。量不到坐标时用样式表里的兜底位置，不会乱猜。

## 2.7.2 (2026-11-02)

### Changed

- **子代理面板的行文本改成预设短语。** 以前把宿主给的原始标签直接印上去（`[agent:delegated review] Bounded…`），长标签被省略号切成看不懂的碎片。现在每个子代理按编号稳定挑一条短短语（正在努力工作 / 认真思考 / 埋头干活 …共 12 条，同一子代理始终同一条，不会乱跳），真实标签留在鼠标悬停提示里。
- **面板不再跑出屏幕。** 子代理多的时候面板能长到几十行、越出窗口底部且无法滚动；现在高度上限约六成屏幕（最多 420px），超出部分在面板内滚动。
- **未知字段不再占位。** 路由还没查到时不显示 `?/?`，开工时间未知时不显示 `—`，行里只留有意义的信息。

## 2.7.1 (2026-11-02)

### Changed

- **LiveRoutePicker 不再每 5 秒轮询路由状态。** 子代理卡片改订两路事件信号：宿主 sessions store 的变化（按「运行中/来源/父会话/更新时间」签名比对，签名没变就不发请求）和插件自有的 `/subagent-role-router/events` SSE 通道（选路写入、覆盖生效、故障切换时后端主动广播，客户端按 childId 对号核对）。窗口聚焦或从后台回来时强制核对一次；路由实例 epoch 变化（插件重载）时全量补全。SSE 连续断 3 次自动降级为纯 store 信号，之后每 30 秒最多重试 3 次，恢复成功自动升级回来；全程不复活定时器，空闲会话周期请求为 0。
- **标题栏小动物回归「锚在会话标题行右端」的本意。** 以前写死 `top:47px/right:28px`，宿主界面加标签栏后正好压在标题栏空档；现在运行时测量标题行的实际位置贴上去，窗口缩放、滚动、布局变化都会跟随，量不到就留在按钮行原位（绝不悬空盖东西）。

### Added

- **后端 SSE 广播端点 `GET /subagent-role-router/events`。** 选路/清除立即广播，覆盖与故障切换在真正改变生效路由时按「提供方|模型|强度」签名去重广播（同一子代理同一路由绝不刷屏），带 25 秒心跳与 hello 帧；仅回环地址可连。

## 2.7.0 (2026-11-02)

### Changed

- **头部小动物与批量入口彻底不再轮询。** 头部「正在干活的子代理」以前每 1.8～5 秒问一次后端、批量入口每 5～15 秒探一次在场，多开会话时这些周期请求叠加造成卡顿。现在两者都改订阅宿主自己的会话状态（和原生目录下拉同一个数据源）：子代理出生/结束/运行状态由宿主推送，插件只在 store 变化时重算一次显示；批量入口只在「可选子代理集合的签名」变化时核验一次，窗口重新聚焦或打开卡片时才再核验。稳定挂机时周期请求为 0（白名单诊断端点新增 counters 计数器可自证）。
- **子代理元数据只取一次种子。** 每个会话头挂载时向后端取一次「哪个模型、跑了多久」的种子数据，之后不再请求；没有种子也照常显示（商店优先，字段留空不编造）。
- **秒数计时与动画拆开。** 面板里的运行秒数由每个单元格自己走 1 秒的表，不再让整个头部每秒重绘；窗口隐藏时动画整体暂停（data-anim-paused），诊断性的 DOM 普查只在调试日志开启时才跑。

### Fixed

- **没有父会话记录的活动条目不再泄漏给每个会话。** 以前 parentSessionId 为 null 的历史记录会出现在任何一个会话的头部/批量列表里，现在严格归属：只有明确属于当前会话的才显示，无主记录只出现在不过滤的全量清单里。


## 2.6.0 (2026-11-01)

### Added

- **模型可以直接换子代理的模型了（不用一个个点界面）。** 新增两个工具：`subagent_routes_inspect` 查当前对话的子代理实际在跑什么模型、可写不可写、有哪些配置好的模型与强度；`subagent_routes_update` 支持指定子代理、指定团队成员，或「当前对话全部可写子代理」批量换模型/强度，也支持只改强度（keep_model）和重置（reset）。工具与界面共用同一套校验：只认当前对话的直接子代理、只认设置页配置的模型池、沿用强度能力校验与豁免规则，不会跨对话乱写。
- **每次修改带修订号，避免互相覆盖。** 每个目标有独立 revision，整体有实例 epoch；轮询与界面按版本采纳，工具改完界面不会再被旧缓存拉回去，重置后也会清掉旧手选值。
- **团队成员换模型（需要 AgentTeams 提供成员路由服务）。** 通过受控服务在同一个成员会话上改下一次请求的模型，保留成员名、childId、任务、attempt_id、消息队列与历史；服务不存在时工具明确报 `teams-unavailable`，绝不退回「删成员重建」。

### Changed

- 子代理页模型控件改为以服务端路由快照为准：有覆盖记进缓存、无覆盖清缓存、目录重建时按实际路由显示，修复了工具或另一个窗口改完之后界面仍显示旧模型的问题。

## 2.6.1 (2026-11-01)

### Fixed

- **工具在真实宿主里注册不上（诊断端点显示两个工具都没装上）。** 原因是运行期动态 import 宿主的 `@deepseek-ai/dsh-tools` 在只发布 `lib/` 的插件里解析不到，失败又被静默吞掉。现在改成插件自带的编译层（`lib/tool-schema.js`），按宿主同一套 schema 子集把参数和输出编译成注册所需形状，不再依赖任何宿主包导入。
- **「已安装」标记不再提前置真。** 以前先置 `true` 再等注册回调，导致白名单诊断端点报告了两个其实没注册的工具；现在只有注册成功才置真，注册被拒会把错误留在 `toolsError` 里，一眼能看出失败原因。

## 2.5.4 (2026-11-01)

### Fixed

- **标题栏小动物不再每秒问一次后端，也不再每次回答都重画。** 原来固定 1.2s 轮询一次运行中子代理清单，不管有没有人在跑；现在有子代理在跑时 1.8s 一次，空着时 5s 一次，窗口在后台时 30s 一次。轮询回来的画面和上一帧完全相同时直接沿用旧数组，React 不再重渲染 —— 一个安静的会话，标题栏从每秒重画变成零重画。
- **长时间会话里「正在运行 N 个子代理」不再越积越多。** 已结束但没被清理的活动记录现在会被真正删除（原来只是从返回结果里过滤掉，每条仍然陪着每次轮询走一遍），活动记录表另有 64 条上限。189 / 262 这种数字就是这些没被删掉的旧记录。
- **展开面板最多列 40 行**，超出时标题里注明「只显示前 40 个」，不再一次渲染几百行。
- **调试日志不再无限增长。** 浏览器端诊断上报改成默认关闭（需要时在控制台执行 localStorage["dsh-subagent-role-router:debug"]="1" 再刷新），服务端同一类诊断 30 秒最多写一行。原来每 1.2s / 5s 各写一行，日志已经涨到 7MB。
- **子代理页的模型控件和批量入口也改成按需轮询**：控件只在路由真的变了才重画；窗口在后台时不轮询；当前对话没有可写子代理时，批量入口的探测间隔从 5s 放宽到 15s。

## 2.5.1 (2026-10-31)

### Changed

- **动作幅度加大一档，节奏也加快。** 上一版整体位移只有 1–2px，在 24px 高的标题栏里几乎看不出来。这一版把整体位移提到 3–5px（打字手臂 5px、焊接横向抖动 4px、跑轮弹跳 3px、快递员 5px），周期同时压短（打字 0.34s、跑轮 0.2s、焊接抖动 0.16s、快递 0.34s），眼睛扫视和书页翻动也跟着放大。

- **地面家具不再跟着角色一起飞。** 键盘、章鱼的小屏、仓鼠的跑轮、快递员的传送带原来是画在同一个图形组里，角色一弹跳桌子就离地。现在每个角色拆成两层：`-rig`（会动的身体）和 `-ground`（钉在地上的道具，先绘制、在角色后面）。仓鼠的轮子连辐条一起算地面件，所以是仓鼠在轮子里跳、轮子自己转，不再整只轮子跟着弹。

## 2.5.0 (2026-10-31)

### Added

- **六种工作动画角色，每个子代理随机分到一个。** 标题栏原来只有一个小工匠，所有子代理长得一样。现在六个：**maker** 敲键盘（键盘按键逐个闪、手臂交替、头顶飘碎屑）、**octo** 五条触手轮流敲屏幕（屏幕光带闪）、**weld** 举焊枪打火花（身体微抖、护目镜反光、火花逐粒亮灭）、**hamster** 在八角轮里跑（轮子带辐条整体旋转、四腿交替）、**owl** 戴眼镜翻书（眼珠左右扫、书页翻动）、**courier** 抱着木箱走传送带（上下颠、两腿交替）。

  分配规则：`pickCritterKind(childId, takenKinds)` 用 childId 的 FNV-1a 哈希取模，同一屏内已出现的角色不再重复（子代理多到超过六个时才会回收），所以同一个子代理每次刷新都长得一样、不同子代理基本不撞脸。

  造型是纯 `rect` 拼的像素画（32×24，2px 一格，`shape-rendering: crispEdges`），全部动画用 CSS `steps()` 做逐帧感、不用缓动曲线；`prefers-reduced-motion: reduce` 下所有循环动画关闭。源码上是**一份数据表**（`CRITTER_ART`：每角色的部件坐标 + 主色/暗部色）加一个渲染器 `critterArt()`，CSS 由 `critterKindsCss()` 从同一张表生成，加第七个角色只需要往表里加一条。

## 2.4.0 (2026-10-31)

### Added

- **批量换模型：一次把当前对话的所有直接子代理改成同一个模型与推理强度。** 输入框左侧行（`conversation.input.left`，order 5，排在 EGM 宠物左边）多了一个「⇄ 批量」入口，点开是一张向上展开的卡片：勾选哪些子代理、选哪个模型、选哪档推理强度，然后「应用」。卡片里也能「只改推理强度，保留各自模型」，以及「清除」这些子代理的覆盖，回到自动分配。

  归属判定全在宿主侧，不在界面侧：前端只发 `parentSessionId` 与勾选的 `childId`，后端用**父会话自己的** `subagents.listChildren(parentSessionId)` 目录判定成员资格 —— `SessionHeader.parentSession` 是 fork 血缘、不是委派父，所以不能拿子会话的 header 反查父。写入前还会**再查一次**目录：列表是几秒前取的，期间子代理可能已结束。

  - 只有 `mode === "continuable"` 的子代理可写；`one-shot`（已结束）、`external`（别的宿主拥有）、未知模式一律不可选，界面上标「已结束 / 外部会话 / 未知模式」。
  - 被 `exemptRules` 命中的子代理不可写（团队插件成员照旧豁免）。
  - 伪造的 `childId`、别的对话的子代理、主代理自身 → `not-owned`；`session-` 前缀与裸 id 归一后再比较。
  - 父会话 ID 双拼写规范化：`strictChildrenOf` 调用 `subagents.listChildren(parentSessionId)` 时，若遇到找不到会话，仅尝试规范的候选双拼写（原样优先、备选重试，即裸 UUID 与 `session-` 前缀），两拼写均失败才报 `catalog-unavailable`，消除宿主 sessionQuery 对裸 ID 报 not found 的兼容问题。构建号升级至 `2026-10-31.2`。

- **新增 `/subagent-role-router/batch` 三个端点**（同一 handler，自动继承 loopback-only / `application/json` / 8 KB body 这些既有闸门）：

  - `GET /subagent-role-router/batch?parentSessionId=` → 直接子代理行（含 `selectable` / `reason` / 当前路由 / `pending`）与本页模型池（含每个模型可用的推理强度、配置来源）。
  - `POST /subagent-role-router/batch/select` → `{ parentSessionId, selections: [{ childId, provider, model, reasoningEffort }] }`，或 `{ childId, keepModel: true, reasoningEffort }` 只改强度、保留该子代理当前（或已挂起覆盖里的）模型。
  - `POST /subagent-role-router/batch/clear` → `{ parentSessionId, childIds }`。

  应用是**逐个子代理**的：一个失败不中断其它，返回每一项的 `ok` 与错误码（`not-owned` / `ended` / `exempt` / `external` / `unknown-mode` / `model-not-allowed` / `effort-unknown` / `model-unknown`），外加 `summary.ok/failed`。

- 模型池唯一来源仍是本页已保存的配置（基础池 + 单模型 + 三个角色池 + 团队模型按 provider/model 去重），每项带来源标签与配置里出现过的强度。

  推理档位只能来自模型的真实能力：`llm.listModels(provider)` 只给名字，档位要逐个模型问 `llm.resolveModelInfo(provider, model).reasoning.efforts`（显示名用 `effort.name`）。结果按 provider 缓存 60 秒；问不出来时标 `capabilityKnown: false`，卡片只列配置里出现过的强度并注明「本页配置过的值」。

  写入时的校验是**双轨**的：能力已知 → 强度必须在该模型目录声明的档位里（配置残留不再放行，`effort-unknown`）；能力未知 → 只接受配置里出现过的强度，其它一律 `effort-unverified`。两种情况下都不会给子代理塞一个它发不出请求的档位。

- 界面层的口径：真实 HTTP 成功只表示「已设置，等待下次请求生效」；`pending` 由实际 `requestHeader().config` 与覆盖比对得出，不靠乐观猜测。`/route` 与批量行把**实际生效的路由**与**挂起的覆盖**分成两部分返回（`actual` / `override` / `pendingRoute`），没有 live 信息时 `actual` 就是 `null`，不拿覆盖值冒充现状。

- 活跃判定纠正：宿主投影里的「inactive」只是空闲，不是结束。可写的条件是「在父会话目录里 + `continuable` + 仍注册在 agents 注册表里 + 没有正在关闭/已释放」，所以空闲的子代理照样能改，只有 `disposed` / `closing` 之类才报 `ending`，目录里已查不到活体则报 `unverified`。

- 「保持不变」是第三种选择：卡片把推理强度分成「保持不变（`keepEffort`）/ 模型默认（清掉旧强度）/ 具体档位」三态；`keepEffort` 与 `keepModel` 同时出现是 `bad-request`，跨模型沿用旧档位若新模型不支持则如实报 `effort-unknown`，不静默降级。

- 应用成功后会记住这次选择（`rememberPicked`），清除成功则忘掉（`forgetPicked`）；卡片刷新列表时保留用户原有勾选、不自动全选新行，部分失败时把失败项保留为勾选方便重试，结果逐项列在卡片底部。

- 新增渲染级测试：一个只实现 `useState` / `useRef` / `useEffect` 的迷你渲染器驱动**真实卡片组件**，覆盖开合与几何（向上/翻下）、勾选与 `应用 (N)`、提交 payload 形状、部分失败后的勾选、清除失败的展示、目录不可用时的拒绝、切会话丢草稿。

- 随后（同版本内迭代）按需求精简为**快捷开关模式**：卡片只剩「模型 / 推理强度 / 应用到当前对话」两个下拉、一个按钮与状态行，移除了子代理勾选名单、只改强度、清除覆盖与逐项结果列表。打开卡片读一次目录做预览，点击应用时**再读一次最新目录**并以该次结果为写入集合，自动作用于其中全部可写的直接子代理（可写数为 0 时拒绝写入并提示）；成功项照旧 `rememberPicked`，失败如实上报且可重试。入口仍按需显示，presence 探测保留 inFlight 合并、单 timer 链、乱序丢弃与卸载清理。上文「勾选 / 只改强度 / 清除 / 逐项结果」的描述仅适用于本版本早期构建，最终交付以本条为准；客户端构建号 `2026-10-31.4`。

## 2.3.0 (2026-10-23)

### Added

- **运行中换模型：子代理跑着的时候，在标题栏点一下就换模型和推理强度。** 此前宿主的模型下拉在子代理会话里**不可用** —— `session/selectModel` 遇到 `origin === "subagent"` 直接回 `session/agent-busy`（`use subagent delivery for this child session`），前端 `conversation.input.model` 槽位在子代理窗口里也根本不渲染。于是「换掉这个正在跑的子代理的模型」唯一可行的办法是打断它再重新派发，上下文全部丢失。

  现在子代理会话的 `conversation.session.header.actions` 槽位里多了一组控件：

  - **模型下拉** —— 按 provider 分组的 `optgroup`，选项来自 `remote.session.modelCatalog()`（与设置卡片同一份目录）。
  - **推理强度下拉** —— 只列出**该模型自己声明的** `reasoning.efforts`。
  - **↺ 复位按钮** —— 仅在有手动覆盖时出现，点它清掉覆盖、回到自动分配。

  生效机制：新增 `installChildRouteOverride()`，在 `agent/request` waterfall 上把该 child 的 provider/model/effort 改写。`agent/request` 是**每个 step 都会重走**的接缝（`prepareRequest` 在 `step()` 的循环里），因此下一个请求立即落在新模型上，无需重启、无需重新派发、上下文不丢。

  **注册顺序是有意的**：cordis waterfall 按注册顺序执行、post-`next()` 代码按**逆序**回卷，所以**先注册者有最终发言权**。`installChildRouteOverride` 注册在 `installFailover` **之前**，保证用户亲手点的模型不会被自动故障转移悄悄换掉。同时 `failoverView()` 在覆盖存在时返回 `undefined`，因此也不会在用户背后写冷却计数。

- **新增 loopback-only HTTP 端点 `/subagent-role-router`**（`GET route` / `POST select` / `POST clear`），用 `ctx.webServer.register({ kind: "prefix", ... })` 自建，`webCtx.effect` 负责释放。

  为什么不复用宿主的 `/api` RPC：`connection.registerInterceptor` 对同一 channel **只允许一个** interceptor（`connection: shared RPC channel "/api" already has an interceptor`），而 api-gateway 已经占住了 `/api`，硬抢会把它顶掉；自己开一条前缀路由既不冲突，也不需要引入 `@deepseek-ai/dsh-typert-protocol`（插件 `dependencies` 里没有它，且 profile 的 `node_modules/@deepseek-ai` 只有 `cosmokit` 与 `schemastery`）。

  安全约束照抄既有插件（git-graph）的做法：只允许 loopback（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`，否则 403），非 POST 405，`content-type` 非 `application/json` 415（这条同时是 CSRF 硬化 —— 跨站表单发不出 `application/json`），body 上限 8 KB。

### Fixed

- **推理强度下拉会给「未声明强度」的模型编造 low/medium/high**，选中后宿主回 `UNSUPPORTED_REASONING_EFFORT` 并**直接结束该子代理的这一轮**。活体实测 `sensenova/kimi-k3` 的 `reasoning.efforts` 是空数组，而 `effortChoicesFor()` 当时回落到三档硬编码；子代理会话里可见 `turn/end reason: provider "magpie" model "sensenova/kimi-k3" does not support reasoning effort "high"`。现在 `effortChoicesFor()` **只返回模型自己声明的强度**，未声明就是空列表（该下拉为空），并把 `effortChoicesFor` 导出为 test seam。

- **`liveSubagent()` 在 webServer 子 context 上查 `agents` 永远查不到**。`agents` 与 `webServer` 位于 fiber 树的不同层级，在 `ctx.inject(["webServer"], (webCtx) => ...)` 的回调里 `webCtx.get("agents")` 恒为 `undefined`，于是所有请求都返回 `not-live`。现在改为在**插件自己的 ctx** 上取一次 `agents`，再闭包进 handler（`const resolve = (childId) => liveSubagent(agents, childId)`）。

- **未知路径报 `not-live` 而不是 404**。原实现先解析 child 再判断路径，路径拼错时会让人去查「子代理为什么不在线」。现在先判 `action`（`select` / `clear` / `undefined`），`undefined` 立即 404，再解析 child。

### Tests

- `node --test` → **57 tests / 57 pass / 0 fail**。
- 新增 `test/live-route.test.mjs`（9 项）：覆盖压过 failover 且保留 `maxTokens`；覆盖只作用于自己那个 child；无 effort 的覆盖**丢弃**继承的 effort（`'reasoningEffort' in after === false`）；覆盖存活时 `agent/request-error` 返回原值不重试、无 cooling warn；`clear` 与 `agent/disposed` 都忘记覆盖；`GET route` 分别报告 live pair 与 pending override；未知 childId 与**主代理 session** 都回 `not-live`；loopback 403 / 非 JSON 415 / 空 provider 400 / 未知路径 404；卸载释放 HTTP 路由。
- `test/client-audit.test.mjs` 新增 `12b`：`effortChoicesFor` 对未声明强度的模型返回空数组，只回显已声明的项。

### Note

- 前端构建标识 `SRR_CLIENT_BUILD` 递增为 `2026-10-23.02`。
- **HMR 的重要限制（排查时必看）**：`@deepseek-ai/dsh-hmr` 的 `analyzeChanges()` 里 `const isExcluded = (url) => url.startsWith("node:") || url.includes("/node_modules/")` —— 本插件是通过 profile `node_modules` 的 junction 加载的，模块 URL 含 `/node_modules/`，因此**改 `lib/*.js` 不会触发热重载**。之前「等 3 分钟就生效」的观察其实是假象：那次生效的是 settings schema 字段，走的是 `cordis.patch.yml` 内容变化触发的 `reconcileProfile()` 配置路径，而不是模块重载。
- 想让新代码生效：**动一下 profile 的 `cordis.patch.yml`**（哪怕只追加一行注释）触发 `reconcileProfile()`，实测约 20 秒后新模块加载完成；或者直接重启 DSH。
- 版本序列：2.1.2 修「每步重复注入」→ 2.1.3 认证类失败也切换 → 2.1.4 修「注入内容滞后一步」→ 2.2.0 角色候补池 → 2.3.0 运行中换模型。

## 2.2.0 (2026-10-21)

### Added

- **角色候补池：每个角色可配多条路由，按忙闲顺延、溢出并发、失败冷却。** 此前 `roleMode` 下每个角色（Explore / Plan / Patch）只有**一条**路由，同一角色派发两个子代理时两个都跑在同一个模型上，额度与延迟都无法分摊；而「多模型」能力（功能一）只作用于**共用**的 `models` 列表，与角色选择互斥。现在角色路由变成一个**候补队列**，队列长度即并发工位数：

  - **行数＝工位数** —— 设置卡片里每个角色卡下方可「＋ 增加候补」/「－ 移除」，配 3 行就是该角色可同时跑 3 个。
  - **忙则顺延** —— 第 1 个任务派候补 1；候补 1 仍在跑时第 2 个派候补 2，再候补 3。
  - **满了共享** —— 全部在忙时**不排队**，派给当前占用最少者（并列取靠前），因此「3 候补 + 4 并发」得到 **2/1/1**。
  - **失败进冷却** —— 失败的路由被暂停使用，后续派发直接跳过；时长由新增字段 `roleSlotCooldownSeconds` 控制，**默认 15 秒**，填 `0` 关闭。
  - **全部冷却中仍派活** —— 不因冷却拒绝派发（那等于让子代理死掉），而是忽略冷却挑一个并打 warn，让降级可见。
  - **冷却只影响新派发** —— 在跑的子代理由功能二就地切换，且切换范围限定在**该角色自己的候补队列内**，不会串到别的角色的模型上。
  - **显式模型不占工位** —— 调用方自带 `agentOptions.model`/`provider` 的派发与 agent-teams 成员完全绕过候补池。

  新增配置字段：`exploreModels` / `planModels` / `patchModels`（数组，`z.array(POOL_ENTRY)`，默认空 → 回落旧单值字段，因此**旧配置无需迁移**）、`roleSlotCooldownSeconds`（数字，默认 15）。旧单值字段 `exploreProvider/exploreModel/exploreEffort` 等**保留并继续被写入**（取队列首项），保证降级安装旧版本时配置不丢。

- **候补队列的工位归还**：`acquireLane()` 在派发时占位，并挂到 `receipt.result` 上在子代理结算时归还；`original.apply` 同步抛错时立即归还。**活体验证**：连续两轮各 4 个并发子代理，两轮分布均为 2/1/1 —— 若工位不归还，第二轮会退化成 0/2/2。

### Fixed

- **「用不了的候补」会一直赢下工位然后失败**。实测发现：一个被网关以 `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]` 拒绝的候补，被适配器 `classifyPiAiError` 归为通用的 `INVALID_REQUEST`，而该码不在 `FAILOVER_TRIGGER_CODES` 内 —— 于是它**既不顺延也不冷却**。它从不长时间运行，因此永远显示为空闲，每次派发都赢下工位再失败一次，把队列堵死。

  修复：新增 `isUnusableCandidate(failure)`，把 `CANDIDATE_UNUSABLE_CODES`（`UNKNOWN_MODEL`/`NO_ADAPTER`/`UNSUPPORTED_REASONING_EFFORT`/`INVALID_CONFIG`）与**指名模型的 400**（`MODEL_UNAVAILABLE_PATTERN`：`model [x] is not allowed/available/permitted/...`、`no such model`、`knows no model`、`does not exist`、`is not allowed for user type`）识别为「候选不可用」，跳过并冷却，同时打一条**点名该路由**的 warn，提示删除或修正那一行。

  **刻意保留的边界**：真正的请求格式错误（如 `messages[3].content: expected string`）仍是 `INVALID_REQUEST`，但**不**触发切换，直接抛出 —— 否则一个代码 bug 会把整个候补队列烧光，还会被伪装成「模型坏了」。

### Tests

- `node --test` → **47 tests / 47 pass / 0 fail**（原 16 项 + 新增 31 项）。
- 新增 `test/schema-pool.test.mjs`（5 项）：池字段默认值；**无 `reasoningEffort` 的 entry 被接受**（`POOL_ENTRY` 存在的理由 —— `MODEL_ENTRY` 的对象分支把 effort 声明为必填，而 UI 序列化不带该键，复用会直接挡掉界面写入）；冷却 `0` 存活；旧单值字段仍可解析；`resolveRolePool` 池优先于单值。
- `test/client-audit.test.mjs` 新增 6 项：`normalizeRoleRoutes`（池优先/回落单值/裸字符串/空值仍返回一行）、`serializeRolePool`（丢空行、空 effort 不写键）、`roleRouteIncomplete`（全空行 false、半填 true）、`normalizeRoleCooldownSeconds`（默认 15、**0 必须保留**、越界回落）、`serializeDefaultModels`（同时写池与旧三元组）、`savedFormFingerprint` + `seedFromSavedForm` 往返一致。
- `test/router-audit.test.mjs` 新增 9 + 4 项：单候补等价性、顺延、溢出并发 `[2,1,1]`、工位归还、失败冷却、冷却到期、全部冷却仍派活并 warn、显式模型不受影响、角色内 failover；以及不可用候补的 4 项（见上）。
- **修好长期失败的 `test/fork-window.test.mjs`**：它 `require` 了 asar 内的 `@deepseek-ai/dsh-session`，而普通 Node **无法 require asar 路径**（只有 Electron 打过补丁的 loader 可以）。改为候选列表（`DSH_SESSION_MODULE` 环境变量 → 裸包名 → 工作区 `_vendor` 闭包 → asar.unpacked → asar），全部不可用则 `t.skip()` 而非红。配套写了 `_diag/vendor-asar-closure.cjs`：解析 asar 头 → 从 entry 包递归扫描所有 import/require 说明符 → 抽出传递闭包并扁平化到 `<out>/node_modules/`（15 个包 / 1238 文件 / 10.05 MB），因为只抽单个包会 `ERR_MODULE_NOT_FOUND`。

### Note

- 前端 bundle 的构建标识 `SRR_CLIENT_BUILD` 递增为 `2026-10-21.01`；客户端与服务端新字段必须**同时**上线，否则设置卡片会写到服务端 schema 不认识的键上（被 `settings/mutate` 的 volatile 路径校验拒绝）。
- 版本序列：2.1.2 修「每步重复注入」→ 2.1.3 认证类失败也切换 → 2.1.4 修「注入内容滞后一步」→ 2.2.0 角色候补池。

## 2.1.4 (2026-10-02)

### Fixed

- **P0：注入的路由滞后一步，导致模型上下文里出现互相矛盾的两行**。2.1.2 修掉「每步重复注入」之后，实测发现注入的**内容**仍可能错：真实日志显示，一个子代理实际在 `ds41` 上运行，却收到一行写着 `glm` 的注入，随后又收到一行 `ds41` —— 模型同时看到两行、彼此矛盾。

  **根因**：取值优先级里有「派发时种子」这一档。宿主的循环顺序是 `preStep()` → `buildRequest()`，于是**第一步的 preStep 执行时，`request/context` 帧尚未产生**，插件只能回落到 `agent.options` —— 而那是**派发时的意图值**，一旦路由在派发后被切换（故障转移 / 配置变更 / 父会话选择），它就永远不再更新。第一步注入的这个「猜测值」会排队进 inbox，在**第二步**才被领取，此时真实路由早已不同。

  **修复**：只报告**已知为真**的路由，优先级为
  1. `session.requestContext()` —— 宿主自己对最新 `request/context` 帧的折叠，文档原文即「the latest resolved route metadata」，也是宿主 `nextFailoverIndex` 读同一处的用法；
  2. 本插件在 `agent/request` 瀑布里捕获的**结算后**种子（对该次请求权威）；
  3. **不回落**到 `agent.options`。

  第 3 条是关键取舍：注入行只是**对现实的陈述**，一个立刻被推翻的猜测比不说更糟。因此路由已知前**保持沉默**，下一步（首次请求提交后）再注入。副作用是单步子代理不再收到该行 —— 这是**刻意的**，因为那时确实无从得知真实路由；把它当作「信息缺失」而非「错误信息」更诚实。

- **同步移除死代码 `routeOfAgent()`**：修复后它不再被任何路径调用，留着会误导下一个读者以为 `agent.options` 仍是有效来源。

### Tests

- 新增回归用例 **「路由在下一步之前被切换时，必须报告新路由、绝不陈旧」**：把 `agent.options` 故意留在派发种子（`glm`），而会话折叠推进到 `ds41`，断言**恰好一行**且内容为 `ds41`、且**绝不含 `glm`**。变异验证：把优先级改回「种子优先」，该用例连同另 2 项立即失败。
- 重写首步用例为**「未提交路由时保持沉默」**：断言首步不注入任何猜测行，并在路由已知后的下一注入一次。旧用例断言的是本次刻意反转的行为，故按新契约重写而非删除。
- **夹具修正（本轮缺陷得以漏过的原因）**：`makeAgent()` 原先把 `session.requestContext()` 固化为一个**常量**，而宿主语义是「折叠最新 `request/context` 的可变值」。夹具不模拟路由变化，注入器读到什么都会被当成「正确」。现改为可变状态，并由 `dispatchRequest()` 在瀑布结算后 `commitRoute()`，与宿主一致。

### Note

- 当前版本序列：2.1.2 修「每步重复注入」（1228 步注入 1227 次 → 11 步注入 2 次），2.1.4 修「内容滞后一步」。两者是**独立缺陷**，均已由真实运行验证。

## 2.1.3 (2026-10-02)

### Changed

- **认证类失败（密钥无效）现在也触发跨供应商切换，并附带明确的 warn 日志**。此前 `AUTH` 被刻意排除在切换范围外，理由是「不要把密钥配错误当成换一家就好而掩盖真实问题」。该顾虑本身成立，但它有一个代价被忽略了：当 `models` 列表里各家供应商**密钥各自独立**时，只要其中一家的密钥失效，整个子代理就会直接失败，而**健康的其它供应商完全闲置**——实测中确实遇到了这种情况（任务因一家配额/密钥问题终止，而列表里还有可用路由）。

  现改为：
  - **触发码分两类**：连接类（`RATE_LIMIT`/`QUOTA`/`SERVER`/`TIMEOUT`/`TRANSPORT`/`EMPTY_RESPONSE`）与**认证类**（`AUTH`、`INVALID_CREDENTIAL`，即宿主对 HTTP 401/403 的映射）。
  - **认证类切换时必打一条 warn**，点名「失败的供应商凭据被拒绝、该供应商 API key 可能无效/过期/无权限，故障转移正在切到 X/Y，请核实该密钥，否则问题会持续复现」。
  - 设计意图：**用可观测性替代抑制**。原先靠「不切换」来暴露密钥问题，现在改为「切换 + 日志」，两者兼得——任务能继续，问题也不会被静默掩盖。
  - **不改变**：池耗尽仍放行真实错误（不做无限重试）；每个候选每个 run 最多试一次；非上述类别的错误码（`NO_ADAPTER`、`CONTEXT_WINDOW_EXCEEDED`、`IMAGE_OFFLOAD_REQUIRED` 等）仍不切换——换一家会同样失败，切换只会掩盖真实错误。

  测试：`failover.test.mjs` 的触发码用例重写，断言 AUTH / INVALID_CREDENTIAL **会**切换、AUTH 必须产出含 `API key is likely invalid` 且点名失败供应商的 warn、且三类非路由型错误码仍**不**切换。夹具新增 `warnings` 捕获（否则「日志必须存在」这条契约无法断言）。变异验证：把 AUTH 退回排除状态，该用例立即失败。

### Note

- 本次改动源于一次真实排障：日志显示某供应商返回 `429 soft_rate`（配额打满，供应商自身建议切换模型）后任务终止。注意**该 429 属于连接类、原本就在切换范围内**，因此上述 AUTH 改动与它无因果关系；配额场景另行调查（见下一条）。
- 同期确认了一个易混淆现象：宿主 LLM 层有自己的 `llm/retry` 策略，配额类错误会**先被它重试若干次**，之后才交由 `agent/request-error` 瀑布（即本插件的介入点）。因此插件观察到切换请求的时机晚于错误首次发生。这属于宿主分层行为，不是本插件的重试循环。

## 2.1.2 (2026-10-02)

### Fixed

- **P0：每个 step 都重复注入一次路由行（实测 387 步注入 479 次）**。用 8 个真实子代理实测时，探针报告「同一行反复出现，且 provider 会在轮次之间变来变去」。核对会话日志（`session.v4.jsonl.zstd`）确认：

  | 探针 | step 数 | 注入次数 |
  | --- | --- | --- |
  | d43cab8a | 81 | 80 |
  | 62ef8523 | 78 | 77 |
  | 13952b6f | 24 | 23 |
  | 6fb5b5d4 | 20 | 19 |
  | d9474a33 | 84 | 83 |
  | 31bfeacc | 79 | 78 |
  | ceacf07f | 20 | 19 |

  **根因**：2.1.1 的去重写成「`agent.inbox.nextStep` 里是否已有一条同样的路由行」。但宿主在每个 `preStep()` 的**开头**先调用 `inbox.claim()`，而 `claim()` 会把 `next-step` **整表抽干**（`mutate("next-step", 0, this.nextStep.length, [], false)`）——且这一步发生在 `agent/pre-step` 瀑布**之前**。于是轮到我这个监听器时，待处理列表**必然是空的**，那个判断**结构上恒为 false**，等于没有去重，每步都重新注入。
  **为什么之前的两轮修复都没碰到它**：2.1.0 的问题在「首步读不到缓存」（已修），本问题是「去重依据失效」——两者独立。
  **修复**：去重改为**带外状态**（`injectedRoute` 按 `agent.id` 记录上次注入的文本），不再依赖 inbox 内容。路由未变 ⇒ 不注入；路由变化 ⇒ 先清掉未认领的旧行再写新行。
  **回归护栏**：新增 3 项用例——① 同路由连续 30 步必须只注入 1 次；② 中途切换 provider 时「每条路由各 1 次」而非「每步 1 次」；③ 同路由相邻两步不重复。**测试夹具同步修正**：`makeInbox()` 增加 `claim()` 并让 `dispatchPreStep()` 在瀑布前先抽干 inbox——正是这个夹具缺失让缺陷逃过了 2.1.0/2.1.1 两轮共 142 项测试。变异验证：把去重退回 inbox 方案，这 3 项立即全部失败。

- **测试记录方式修正：改为在「注入发生时」记录，而非事后读 inbox**。事后读 `inbox.nextStep` 只能看到当前这一步的那一条，因此「28 条重复」与「正好 1 条」在断言上长得一模一样——这是缺陷能藏住的第二个原因。现由 `recordInjections()` 在 `prepend` 时记录全部历史。

### Changed

- 上述修正同时解释了实测中观察到的「provider 在轮次间跳变」现象：稳定路由被反复重新注入时，日志里会呈现为路由在变。

## 2.1.1 (2026-10-01)

### Fixed

- **P0：首步不注入，导致 2.1.0 的注入对单步子代理完全不生效**。真实宿主实测发现：重启后派出的探针子代理报告上下文里**没有**那一行。

  根因（逐行核对 `dsh-agent-loop` 后确认）：每轮迭代的顺序是 `preStep()`（`lib/index.js:954`）**先于** `buildRequest()`／`agent/request`（`:1063`）。而 2.1.0 的实现只在 `agent/request` 瀑布里缓存路由、再到 `agent/pre-step` 读取它——于是**首步永远读不到缓存**（此刻第一个请求尚未构建）。单步子代理只有首步，因此注入**恒不触发**；多步子代理从第二步起才生效，这一点掩盖了缺陷（本地测试夹具同时驱动了两条瀑布，但与宿主的真实顺序相反，故未能暴露）。
  **修复**：pre-step 侧改为「**结算后请求路由 ?? agent 自身实时路由**」。`agent.options.provider` / `.model` 正是宿主 `prepareRequest()` 复制到即将发出的请求上的那一对（`const route = { provider: this.options.provider, model: this.options.model }`），因此**首步即权威可得**；`agent/request` 缓存保留，用于让**故障转移切换后**的路由覆盖它（切换只体现在请求级结算值上）。
  **回归护栏**：新增用例特意**不调用 `dispatchRequest`**，直接以首步 pre-step 断言必须注入——变异验证：把来源退回纯缓存方案，该用例立即失败。原「无路由不注入」用例的前提随修复改变（其 agent 本就带 `options`），已拆分为「首步必须注入」与「路由真为空时不写占位行」两项。

### Changed

- **本地夹具的瀑布顺序与宿主不一致，是上述缺陷得以漏过测试的原因**。新用例改为模拟宿主的真实顺序（单个 pre-step、无前置 request），并保留原有用例继续覆盖多步与故障转移场景。

## 2.1.0 (2026-10-01)

### Added

- **子代理现在知道自己跑在哪个供应商/模型上（真实提示词注入，功能三通路二）**。此前功能三只有**界面行**——轨迹视图与对话视图会渲染「当前供应商/模型」，但那只是**画给用户看的**，**不进入模型上下文**，因此子代理**无法回答**「你现在用的什么模型」。本版新增一条**真正的提示词注入**：向子代理**自己的上下文**写入一行，内容形如
  `[dsh-subagent-role-router] You are running as a subagent on workbuddy/deepseek-v4.1-flash (provider=workbuddy, model=deepseek-v4.1-flash). If asked which model or provider you are, answer with this route.`
  实现要点：
  - **取值来源是「结算后的真实路由」**：注入内容取自 `agent/request` 瀑布 **`await next()` 之后**返回的 `{provider, model}`，即**包含本插件自身故障转移改写结果在内**的最终值。这一点是可验证的关键差异——用「插件打算切到哪个模型」当来源会在切换后写出与实际不符的一行，回归用例（把来源替换成硬编码路由）当场失败 3 项。
  - **注入时机是下一步的 `agent/pre-step`**：这是仍能修改「即将执行的那一步」消息列表的接缝（宿主自带的 `dsh-agent-instructions` 用的同一接缝）。`agent/request` 阶段消息已冻结，故采用「请求阶段缓存 → 下一步注入」两步式。
  - **去重与替换**：路由未变则不重复注入；路由变化（故障转移切换 / 配置变更）则**移除旧行再写新行**，长时间运行不会堆积重复行。
  - **仅对子代理生效**：与故障转移同一道 `agent.session.header.origin === "subagent"` 门禁，**主代理上下文永不被触碰**。该门禁在 `agent/request` 与 `agent/pre-step` **两条瀑布上都必须存在**，并新增静态护栏用例钉住（变异验证：仅删 pre-step 侧门禁会因缓存未被写入而「静默不注入」，单靠行为用例抓不到，故补静态断言）。
  - **消息来源合规**：`source.kind` 使用生产者自有标识 `plugin:dsh-subagent-role-router` 并带 `form: "route-context"` 标记。会话格式 v4 通过 `assertV4MessageSources` 硬校验，裸 `{kind:"plugin"}` 包装会导致**整个会话拒绝加载**，故有专项用例断言该形状。
  - **可关闭**：新增配置项 `injectRouteContext`（boolean，**默认 `true`**），设置卡片新增「把当前模型与供应商写进子代理上下文」勾选项及中英文案。默认开启的理由：不开则子代理仍无法回答自身路由，而这正是本功能的目的。
  - **新增依赖声明**：注入需要 `createUserMessage`，故新增 peer `@deepseek-ai/dsh-llm`（`>=0.1.7-rc.1 <0.3.0-0`，与其余 8 个 peer 同区间）。已验证宿主侧（profile 目录）与该包一致解析同一实例。

- **`plugin/test/route-context.test.mjs`：注入行为的 12 项回归用例**。以 `dsh-agent-loop` 的真实 `Inbox` 语义驱动（`prepend(target,message)` / `remove(messageId)` / `nextStep` 为 getter），覆盖：注入到达子代理上下文、报告**结算后**的路由（被后续 listener 改写仍以最终值为准）、主代理不被注入（含多步）、路由变化**替换**而非堆积、路由不变不重复、开关关闭即停止注入、缺省即为开启、`source` 形状合规（生产者自有 + form 标记）、不干扰循环自身消息、未解析出路由时不写占位行、销毁后不再注入。

- **真实宿主对象的一次性集成验证**：以 `@deepseek-ai/cordis` 真实 `Context` + 真实 `createUserMessage` + 真实两条瀑布跑通，打印出子代理实际收到的那一行与 `source`，确认 `role: "user"`、`source.kind` 与 `form` 均符合预期。（该验证同时纠正了一处测试夹具错误：`inbox.nextStep` 在宿主中是 **getter**，早期夹具用普通属性写，导致夹具与真实契约不符。）

### Changed

- **文档口径修正（中/英、README 四处 + 市场描述）**：功能三由「界面行，**不**注入提示词」改为**两条独立通路的准确描述**——通路一（界面行，给用户）与通路二（提示词注入，给子代理），并明确**两者互不替代**。此前的措辞会让读者（以及模型自己）误以为子代理知道自己的模型，与实际行为不符。
- **写明与宿主 `{{model}}` 变量的关系**：DSH 宿主 `system-prompt` 行的 persona 已能把 `{{model}}` 解析进提示词（`You are a coding agent powered by the {{model}} model.`，变量由 `dsh-agent-loop` 按 `context.agent.options` 注册），但**只覆盖 `model`、不含 `provider`**，且取派发时 `options` 的值。本插件注入**额外给出 provider**，并以请求级结算值为准（含故障转移），故两者互补而非重复。该结论已逐行核对宿主源码后写入文档。
- **`settings-install` / `settings-write-gate` 两处契约同步扩充**：字段数由六增至七（`injectRouteContext`），原子保存用例与描述符可见性断言同步更新——这两处是**刻意的契约钉子**，新增字段必须显式改它们，避免字段被静默丢弃。

### Fixed

- **CHANGELOG 2.0.8 条目中的锁文件同步说明**，本版同步 `package-lock.json` 根条目版本至 2.1.0 并纳入新增 peer `@deepseek-ai/dsh-llm`。

## 2.0.8 (2026-09-29)

### Fixed

- **P0：peer 上界 `<0.2.0` 会在 DSH 0.2.0 正式版发布时把整个 bundle 摘掉**。宿主校验 peer **不用默认 semver 选项**：`@deepseek-ai/dsh-app-boot` 执行的是
  `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。该选项**关闭 prerelease 元组规则**，于是 `<0.2.0` 的实际行为与直觉相反——它**放进** `0.2.0-rc.1`，却**拒绝**正式的 `0.2.0`。后果不是降级运行：`loadProfileDirectory()` 对不兼容 bundle 直接抛错，bundle 落入 `skippedBundles`，启动时 stderr 打印 `skipping profile bundle "dsh-subagent-role-router"`，**插件本体与设置卡片一起消失**。
  修复：8 个 `@deepseek-ai/*` peer 统一改为 **`>=0.1.7-rc.1 <0.3.0-0`**——放行 0.1.7 线及其后的整个 0.2.x 线（prerelease 与正式版都收），并用 `-0` 后缀挡住 `0.3.0-rc.1`（否则裸 `<0.3.0` 会在 `includePrerelease` 下放它进来，把支持面悄悄扩到未经验证的一行）。
  用上游**真实门禁函数** `evaluatePluginCompatibility` 验收：改前 `0.1.7-rc.1/rc.2/0.2.0-rc.1` 通过而 `0.2.0`/`0.2.1` 被拒（8 个 peer 全不满足）；改后 `0.1.7-rc.1 … 0.2.1` 全部通过，`0.3.0-rc.1`/`0.3.0` 被拒。

- **回归护栏本身有缺陷：`peer-range.test.mjs` 以裸 semver 语义断言，因此给的是假安全感**。旧测试手写模拟了 prerelease 元组规则并**恒开**，即**恰好漏掉了宿主真实使用的 `includePrerelease` 选项**，于是它断言「`0.2.0-rc.1` 必须被拒绝」——与宿主实际行为**完全相反**，且在该断言下全绿，掩盖了上面那条 P0。
  修复：护栏改为**调用真实 `semver` 包**（`{ includePrerelease: true }`——宿主同款选项），并显式保留两条反向断言（旧 `<0.2.0` 上界放进 `0.2.0-rc.1`、拒绝 `0.2.0`），任何人重新引入裸 `<0.2.0` 都会立刻变红（已实测：把旧区间写回去，该文件 10 项中 2 项失败）。
  手写回退实现（`semver` 解析不到时的降级路径）同步修正，并新增与真实 semver 的**交叉验证**——该验证当场抓出回退实现自身的两个真缺陷：`^`/`~` 运算符被正则漏掉而恒判 `false`。现回退只实现声明的 `>= > < <= =` 语法（136 项对照零不一致），遇到 `^` / `~` / x-range **抛错而非静默返回 `false`**——"自信地答错"正是旧护栏的病根。
  **关于 `semver` 的定位（一处刻意设计）**：`semver` **不是**本插件的声明依赖，它只经由 npm 的 peer 自动安装链进入依赖树（root devDep `dsh-settings` → `dsh-config-editor` → peer `dsh-app-boot` → dep `semver`）。把 CI 判定挂在未声明的传递依赖上，会在 npm 改变 peer 解析的那天连带弄坏构建，而本仓的既有约定（`dependency-integrity.test.mjs`）是测试必须自洽。因此 `semver` 只作**可选的高保真交叉验证**：在场时用它校验回退实现，缺席时打印一行 `# note:` 跳过，断言本身仍由回退实现承担——而回退实现的可信度来自它自己的语义钉子（`HOST's includePrerelease semantics` 一条，直接钉住两条反向判定，不依赖 `semver`）。两条路径都已实测：有 `semver` 时 10/10 通过；隐藏 `node_modules/semver` 后同样 10/10 通过且打印跳过说明；在**无 semver** 状态下把旧区间写回，仍有 2 项失败。

- **lockfile 与 `package.json` 漂移**：`package-lock.json` 根条目仍停在 `version: 2.0.3`（`package.json` 已 2.0.7），`@deepseek-ai/schemastery` 下限也仍是旧的 `>=3.18.4`（`package.json` 已放宽为 `>=3.18.1`）。已同步根条目的 version / dependencies / devDependencies / peerDependencies / engines，并加校验确认逐字段一致。

### Changed

- **文档补齐宿主版本契约**：根 `README`（中/英）、`plugin/README`（中/英）新增「宿主版本要求」一节，用表格说明三种上界写法在 `0.2.0-rc.1` / `0.2.0` 上的实际判定，并写明写错时宿主是「跳过整个 bundle」而非降级。`DEVELOPMENT.md` 新增「宿主版本契约（改 `peerDependencies` 前必读）」，含「想表达仅 0.1.7 线时应写 `<0.2.0-0` 而非 `<0.2.0`」这一纠正，并把裸 `<0.2.0` 列入「不要做的事」。

### Added

- **`plugin/test/settings-write-gate.test.mjs`：用真实宿主写入门做的端到端保存回归（8 项）**。此前**所有**设置类测试都驱动宿主控制器的**替身**——这正是 2.0.4–2.0.7 那串保存故障能藏住的原因：插件自己的卡片、自己的 scope、自己对写契约的理解三者相互一致，而真实的 `@deepseek-ai/dsh-settings` 门禁并不一致。新测试直接 **import 真实的 `SettingsForms`**，把插件真实的 `Config` 灌进去，覆盖历史上每一处真实故障：
  ① **2.0.4 回归**——命名空间仍出现在真实 `describe()` 目录里（`volatileForm()` 返回 `undefined` 时 `describe()` 会 `return []` 丢弃该条目，正是「宿主不为本插件提供设置存储」那句报错的成因）；
  ② **2.0.5 回归**——六个卡片字段在真实描述符里**全部存在且可见**（`projectForm()` 丢弃解析为 `undefined` 的字段，被丢的字段卡片读不回、验不了，即 `notApplied:ready:writable=true`）；
  ③ 真实门禁**接受卡片的单次原子六字段保存**（含曾让每次保存都失败的 `reasoningEffort`）；
  ④ 保存值经真实 `describe()` **回读一致**；⑤ `unset` 数组下标**真的删除元素**（「删掉的路由又回来」的宿主语义面）；⑥ 旧 revision 被拒且错误类型/机器码为 `SettingsConflictError` / `SETTINGS_CONFLICT`（2.0.5 的「重试一次」正是按这两个标识判定，换个类型就不会重试）；⑦ 携带新 revision 的重试**落盘成功**。
  夹具只替身 Service 解析的协作者（`configEditor` / `profileContext` / loader await），并**严格保留宿主的两段式模型**：`entry.options.config` 存**原始**值、`fiber.config` 存**已解析**值（volatile 字段是 `{ get() }` 引用）——把两者合并会把 `{ get() }` 交给期待纯数据的门禁，被 `cloneJsonShaped` 以「contains a function」拒绝（该失败在本轮实测中确实发生过，已修）。
  有效性已用**变异验证**：抹掉 `volatileField()` 的标记后 8 项中 7 项失败；抹掉 `provider` 的 `.default("")` 后 ② 失败。`dsh-settings` 的 `src/` 在 `dsh-v0.1.7-rc.2` 与 `dsh-v0.2.0-rc.1` 之间**逐字节相同**，故该门禁在两个宿主上行为一致。

### Docs

- **`docs/client-inspect-hang-rootcause.md` 更新影响版本**：补记该文档的结论已对 `0.2.0-rc.1` 复核——`resolveClientQuery()` 的 `if (!resolution.ok) return { accepted: false }`（丢弃页面拒绝）与 `dsh-tool-cordis` 缺少 `timeoutMs` **两处缺陷均未修复**，故「避免 `platform: "client"`」的 workaround 继续有效；文档状态由「0.1.7-rc.2 上定位」改为「截至 0.2.0-rc.1 仍未修复」。

- **修正失效的文档引用与陈旧用例数**：`settings-install.test.mjs` 曾指向仓库中并不存在的 `docs/dsh-0.1.5-rc2-to-0.1.7-rc1-research.md`，已改为描述真实证据（`dsh-settings` 的 `describe()`）；`RELEASING.md` / `DEVELOPMENT.md` 里写死的用例数（92）早已过期，改为「看 `fail 0` 且 `pass` == `tests`」——该数字已漂移四次（92 → 112 → 116 → 120 → 128），写死必然再次过期。

## 2.0.7 (2026-09-26)

### Fixed

- **真机报告：「切换出去之后还是之前的状态」——保存保持随卡片卸载丢失**。2.0.6 的「保存保持」放在组件 ref 里，用户离开 Plugins 页即卸载、保持随之死亡；回来重挂的卡片从**仍滞后的 mirror** 播种，删除的路由又回来了。
  修复：**保持提升到 scope 层**（插件生命周期，不随卡片卸载）。scope 新增 `savedForm()/setSavedForm()/clearSavedForm()`；重挂的卡片**播种优先用保存的表单**（从 held 路由重建完整分节，含 effort 折叠规则），mirror 与保存一致前 re-seed 一律拒绝；收敛轮询改为读 scope 上的 held，**跨卸载存活**，收敛即释放。
  测试基建同步修复一个真缺陷：测试沙箱里 bundle 在 factory 时一次性捕获 `React`，第二次挂载的 hooks 全写进首个 double 的 cells——用 Proxy 转发到当前挂载的 double 后，删除/保存类交互测试才真正驱动了被测组件。

## 2.0.6 (2026-09-26)

### Fixed

- **真机报告：「删掉一个路由，保存，删掉的那个又出现了」**。保存不再报错了（2.0.5 的滞后接受生效），但删除的路由会复活。机制已用沙箱复现钉死：写入**确实落盘**（patch 与草稿一致），但 describe mirror 在保存后仍返回旧文档，**re-seed 效应用旧值覆盖了刚保存的表单**——被删除的路由此复活。沙箱对照证明：宿主行为正常时路由不复活，复活只发生在 mirror 滞后时。
  修复（两条互补）：
  1. **保存后设「保持」**：re-seed 效应从此只接受与刚保存的表单**一致**的 mirror 值；不一致（滞后）时拒绝用它覆盖表单，杜绝复活。
  2. **后台收敛轮询**：滞后接受后有界地持续重读 mirror（20 次 × 500ms），一旦它与保存值一致即释放保持、恢复正常同步；始终不一致则表单保持已保存的真值（patch 即真值），并在 console 留 warn。
  回归测试两个：mirror 永不收敛时删除不复活；mirror 有限次重读后收敛时，全程不复活且最终同步。

## 2.0.5 (2026-09-26)

### Fixed

- **真机实锤的最终根因：写入成功了，是回读校验把它误报成失败**。带着 2.0.5 的取证报错在真机复现，三条铁证拼出完整图景：
  ① `write=atomic` 且无 `:refused=` —— 原子写入**被宿主接受**；
  ② profile patch 的 mtime 正是点击保存的那一秒，内容与草稿**逐字段一致** —— **写入已落盘**；
  ③ 报错里 `rev=2`（revision 已前进）但 `got=` 仍是旧值 —— describe **mirror 在整个重试窗口内一直返回旧文档**。
  即「已接受的写入 ⟹ 必然落盘」（`configEditor.edit()` 只有在 patch 写盘且 Loader 完成调和后才 resolve；任何失败都会抛错并让 `mutate()` 返回 `false` 走 `:refused=` 路径），而严格六字段回读等值校验把 mirror 的滞后当成了保存失败——这正是 `notApplied:ready:writable=true` 的全部真相。
  修复：**已接受的写入 ⟹ 报告保存成功**，表单从草稿重置；回读重试保留（快速收敛时用存量真值校准），最终仍不匹配时取草稿为真值并在 console 留 warn。原有的 revision-change 重播种效应会在 mirror 追上后把显示收敛到宿主实际保存的内容。

- **revision 栅栏拒绝现在会重试一次**（同一次保存的另一条硬化）。用真实宿主代码复现了机制：`configEditor.edit()` 先 `reconcileProfilePatches()`（重建条目 fiber → revision 由 `entry.fiber.uid` 派生而变化）再做 revision 检查，携带旧 revision 的写入会被 `SettingsConflictError` 拒绝、`ConfigFormController.mutate()` 回 `false`。控制器在返回 `false` 前已调 `recover() → mirror.load()` 折入新鲜 revision，因此**紧接着的重试必然携带正确 revision 并落盘**；第二次仍被拒才报错。同时把一次保存从六次独立 `set()` 合并为**一次原子 `mutate(ops)`**（六个 op 一笔事务、一个 revision）。

### Changed

- **失败报告自带完整取证**：`notApplied` 报错附带 `scope 状态 + writable + mirror revision + 写入路径(atomic/sequential) + 逐字段差异(got/exp)`。正是这套取证让最终根因在真机上一次定位（2.0.4 及之前只有一个笼统的 scope 状态）。
- **设置卡常显 `[diag <build>]` 诊断行**（mirror 状态、绑定命名空间、scope 状态、revision、构建标记）。之前它只在 `!writable || status!=="ready"` 时显示——恰好把最需要它的故障窗口藏掉了。构建标记（`SRR_CLIENT_BUILD`）用于确认页面实际运行的 client bundle；宿主在启动时快照 bundle，排查期间每次修改 client.js 必须递增它。

### Testing

- 全量 **112 项通过**（+4）。新增用例都驱动**真实注册卡片 + 真实 `persistDefaultModels`**（从注入的 slot face 捕获，而非桩），对照一个忠实建模 `ConfigFormController` 语义（拒绝先 `recover()` 折入新 revision、接受即折入新值）的控制器：
  ① **栅栏拒绝被重试一次并落盘**；② 慢 reload 被回读重试等过去，不误报；③ **已接受但回读永不收敛的写入报「已保存」而非失败**（真机根因的回归守卫）；④ 真正被拒的写入报错带 rev / write 路径 / `:refused=` 标记，与回读滞后可区分。

## 2.0.4 (2026-09-26)

### Fixed

- **设置卡片保存永久失败（P0）：插件自带的 schemastery 缺 `.volatile()`，整段设置命名空间被宿主静默丢弃**。用户报告的现象是保存时报
  `本机宿主未为此插件提供设置存储（notApplied:unavailable:writable=false），暂时无法保存；请确认插件已在当前 profile 中启用，然后重启 DSH。`——而该插件确实已启用、宿主也确实在服务它，重启与重装都无法改变。
  根因链条（每一环都已用真实宿主代码验证）：
  1. `@deepseek-ai/dsh-settings` 从 Config schema 派生设置面时调用 `volatileForm()`；**没有任何字段带 volatile 标记时它返回 `undefined`，`describe()` 随即 `return []` 丢弃该条目**——插件因此根本不出现在设置命名空间目录里。
  2. 客户端卡片的 scope 从 describe mirror 的这份目录里解析命名空间；目录里没有它，`servedNamespaceNow()` 永远返回 `null`，scope 永不绑定。
  3. 未绑定的 scope 其快照就是字面量 `{ status: "unavailable", value: undefined, writable: false }`，于是保存走完全程后落到
     `notApplied:unavailable:writable=false`——**这正是用户看到的那句话**。
  4. 标记为何没打上：`volatileField()` 只在 `schema.volatile` 是函数时才调用它，而插件 `node_modules` 里实际装的是 **schemastery 3.18.1**，该版本尚无 `volatile()`（3.18.4 才引入）。`package.json` 声明的是 `>=3.18.4`、lockfile 也钉的是 3.18.4，**实际安装树却是 3.18.1**，于是降级分支的恒等 no-op 被当作正常路径执行。
  修复：`volatileField()` 在 `volatile()` 缺失时回退到 `extra("volatile", true)`——3.18.4 的 `volatile()` 本体就是这一句（外加一个重复标记守卫），故该回退在旧构建上语义完全一致、在新构建上仍走原路径。同时把 `@deepseek-ai/schemastery` 依赖下限由 `>=3.18.4` 放宽为 `>=3.18.1`，因为代码已不再依赖 3.18.4 专有方法。
  证据（`SettingsForms.describe()` 与宿主写入门，均为真实宿主代码，对照 git HEAD 的修复前模块）：
  | | 命名空间是否出现在设置目录 | Save（`mutate`）结果 |
  |---|---|---|
  | 修复前 | **0 个（被丢弃）** | `REFUSED -> Plugin entry "dsh-subagent-role-router" has no volatile fields` |
  | 修复后 | 1 个，字段全部可编辑 | `ACCEPTED`，且落盘分节内容正确 |

- **上一条修好后的第二层故障（同一张卡、另一条根因）：`provider` / `model` / `reasoningEffort` 三个字段在「空分节」下被宿主从设置表单里静默剔除**。第一层修复后，保存报错从
  `notApplied:unavailable:writable=false` 变成 **`notApplied:ready:writable=true`**——scope 已 ready 且可写，写入却「没生效」。
  `@deepseek-ai/dsh-settings` 的设置面由 `projectForm()` 逐字段投影，而它会**丢弃任何解析值为 `undefined` 的字段**：

  ```js
  return field === void 0 ? [] : [[key, projectForm(child, field)]];
  ```

  三个字符串字段当初只写了 `z.string()`、**没有 `.default(...)`**，于是空分节下解析为 `undefined`、整条被剔除。后果是卡片读到的 descriptor 里根本没有这三个键：它写进去、回读时该键不存在，于是判定不一致并抛 `notApplied:ready:writable=true`。**一个表单看不见的字段，就是它既写不了也验不了的字段。**
  修复：三者补上 `.default("")`（空串正是本插件各处既有的「未设置 → 继承父会话路由」语义，`defaultModel()` 判的就是 `length > 0`）。
  **作用范围已精确界定**（两种输入都实测过，不夸大）：
  | 分节状态 | 无 `.default("")` | 有 `.default("")` |
  |---|---|---|
  | **空分节**（首次保存、刚装好） | 缺失 **provider, model, reasoningEffort** | 六个齐全 |
  | 已存过值的分节 | 六个齐全（该键已非 `undefined`，`projectForm` 不再剔除） | 六个齐全 |
  也就是说：本缺陷打击的是**首次保存**（以及任何把这三个键清空的路径）；已经存过值以后它不再发作——这正是它难被发现的原因。用户 14:05 那次报错发生在**已有存值**的状态下，因此主要成因见下一条（回读竞态 / 半写入），本缺陷是同一张卡上独立存在的第二个坑。

- **同一次修复：把「一次保存」从六次独立写入合并为一次原子写入，并让回读等待真正落盘**。这一条解释用户 14:05 的报错（该次写入**确实落盘了**：profile patch 的 mtime 与内容都证明六个字段都写进去了）：
  1. **六次独立事务**——卡片原先对六个字段各调一次 `scope.set()`，每笔各自取一次 `expectedRevision`；而 `configEditor.edit()` 会在写入后重建条目 fiber（`dsh-settings` 的 revision 正是由 `entry.fiber.uid` 派生），链中靠后的字段会被 revision 栅栏挡下、`remote.settings.mutate` 回 `ok:false`、`ConfigFormController.mutate()` 返回 **`false`**——旧代码**忽略了这个返回值**，把半写入当成成功。现优先走单次 `mutate(ops)`（服务端把全部 op 收进**一次** `write()`），原子落盘；控制器无原子形态时回退顺序写入，但**在第一个被拒处即中断**。
  2. **回读竞态**——`edit()` 落盘后 Loader 重建 fiber，mirror 要等这次 reload 提交才看得到新文档；旧代码在写 promise 一 resolve 就立刻读快照判定，于是把「已落盘但回读还是旧值」报成 `notApplied:ready:writable=true`。现改为经 scope 的 `refresh()` **强制重读**并在有界次数内重试，再判定。

### Testing

- 全量 **108 项通过**（原 101 项 + 7 项新增守卫）。
- 新增守卫（`plugin/test/settings-install.test.mjs`）：① 无 `volatile()` 的旧构建上 `extra()` 回退必须**真的打上标记**（而非恒等 no-op 直接返回，那正是缺陷形态）；② 有 `volatile()` 时优先走 `volatile()`；③ 两者皆无的字段原样返回，不在模块求值期炸掉；④ **回归守卫**：遍历真实 `Config` 每个字段断言 `meta.volatile === true`；⑤ **每个字段必须声明 `.default(...)`**，并逐个断言那三个空串默认值；⑥ 以空分节解析 schema、解开 volatile 引用后断言**六个键一个不少**（`projectForm` 判的就是这个）。
- 新增守卫（`plugin/test/client-trajectory.test.mjs`）：⑦ scope 必须提供原子写入 `setMany`，且一次保存只产生**一次** `mutate`、op 为宿主要求的 path-addressed 形态；⑧ scope 必须提供 `refresh()` 强制 mirror 重读（否则「已落盘但回读仍是旧值」会被误报）；⑨ 未绑定的 scope 对 `set` 回 `false`、对 `setMany` 回 **`undefined`（绝不谎报成功）**，快照如实报 `unavailable` / `writable: false`。
- **变异验证**（守卫必须能变红）：把 `.default("")` 从 `provider` 去掉 → 2 项测试变红；把 `extra()` 回退改为死代码 → 2 项测试变红；未变异基线 0 失败。模块在每次变异后**逐字节还原**（已断言）。
- 修复前的 `volatile() absence degrades to an identity field` 用例断言的是**缺陷本身**，已按上述替换。

## 2.0.3 (2026-09-26)

### Fixed

- **Windows 全平台受支持（此前存在只在 Windows 上暴露的硬故障）**：`plugin/test/dependency-integrity.test.mjs` 用 `new URL("..", import.meta.url).pathname` 推导插件根目录。Windows 上文件 URL 形如 `file:///C:/...`，其 `pathname` 为 `/C:/Users/...`，经 `path.join` 折成 `\C:\Users\...`——一个不存在的路径，于是 `readFileSync` 在任何断言执行前抛 ENOENT，**整套测试在 Windows 检出上直接死掉**。该缺陷在 macOS/Linux 上不可见（两种写法结果一致），因此只有 Windows 才会暴露。已改为 `fileURLToPath(new URL("..", import.meta.url))`；后者同时也解析 `%20` 等转义，含空格路径（如 `C:\Users\My Project\...`）一并修好。
  新增两条守卫：① 扫描 `lib/`、`scripts/`、`test/` 全部源码，禁止出现 `new URL(...).pathname` / `import.meta.url.pathname`（先剥离注释，避免守卫自身的说明文字自匹配）；② 断言本守卫文件自身确实使用 `fileURLToPath`。已**变异验证**：在 `test/` 放入一个使用 `.pathname` 的文件后该守卫立刻变红。
- **两个开发脚本在 0.1.7 上启动即崩（与平台无关的既有回归）**：`scripts/simulate-retry.mjs` 与 `scripts/verify-mock-failover.mjs` 仍 `import { SettingsProvider } from "@deepseek-ai/dsh-settings"`，而该命名导出在 0.1.7 线已被删除（当前 0.1.7-rc.2 的导出只剩 `SettingsConflictError` / `SettingsForms` / `default` / `redactSecrets`）。两脚本因此抛 `SyntaxError: does not provide an export named 'SettingsProvider'`，一行断言都没跑到。已改用 0.1.7 的设置模型——把配置段**直接**传给 `apply(ctx, config)`（`root.registry.plugin(plugin, config)`），并把配置段由旧的 `{ "subagent-default-model": { … } }` 嵌套形态改为扁平形态。此改动与 2.0.0 起 `test/` 已采用的范式对齐，属测试脚手架未同步的遗漏。
- **`simulate-retry.mjs` 的客户端桩停留在 0.1.6 契约**：修好导入后随即抛 `TypeError: ctx.effect is not a function`——桩里仍在提供已删除的 `settingsScope` 与 `conversationEvents` 服务，缺少 `ctx.effect` 与 `ctx.inject(["configForms"], …)`。已按 `test/client-trajectory.test.mjs` 的现行桩重写（`configForms` 的 `describe`/`get`、`uiConversation.events.register`）。该脚本现已恢复完整链路输出。
- **`verify-mock-failover.mjs` 的成功路径解析错误**：mock 服务器对成功响应默认走 SSE 流式（DSH 默认请求流式），而脚本用 `res.json()` 解析，得到空对象，最后一条断言必然失败。已按 `content-type` 分流：`text/event-stream` 走 `data:` 帧聚合 `delta.content`，`application/json` 走 JSON 解析。

### Changed

- **`npm test` 改为不带 glob 的 `node --test`**（原为 `node --test test/*.test.mjs`）。glob 由 shell 展开：POSIX sh 会展开，Windows 的 cmd/PowerShell 会**原样传入**，于是同一命令在两个平台语义不同。改由 Node 测试运行器自行发现用例后，两平台行为一致（已验证发现结果与显式 glob 完全相同）。
- **`integration.mjs` / `prove.mjs` 改用 `dirname(fileURLToPath(import.meta.url))`**（原为 `import.meta.dirname`）。后者需 Node ≥ 20.11 / 21.2；本次不提升任何运行门槛。
- **CI 增加 `windows-latest` 与 `macos-latest` 矩阵**（原仅 `ubuntu-latest`）。单一 Linux 任务无法捕获平台路径类缺陷——`new URL(...).pathname` 与 `path.join` 在 POSIX 上一致、在 Windows 上分叉，正是本次修掉的故障类别。
- **README（中/英，根目录 + `plugin/`）新增「平台支持」章节**：明确 Windows / macOS / Linux 三平台受支持，给出三平台配置路径对照表，并列明已检查并持续验证的平台面（依赖树跨平台、CRLF 安全、路径解析、测试发现）。根 README 以表格给出结论，`plugin/README` 给出逐条依据。
- **`DEVELOPMENT.md` 新增「平台影响面」检查清单**：此后每次改动都须复盘八个面（路径解析、路径拼接、shell 依赖、测试发现、换行符、依赖树、进程/信号、大小写），并注明 CI 门禁为持续验证手段；同时勘正文档内 macOS 专属写法（`⌘Q` 补 Windows 退出方式、安装路径补 Windows 形态）。

### Testing

- 全量 **92 项通过**（原 90 项 + 2 项新增跨平台守卫）；`integration.mjs` 与 `prove.mjs` 均通过。
- **CRLF 检出验证**：在整仓按 CRLF 重写的副本上跑全套测试，**92/92 通过**——证明按源码文本做断言的用例不依赖行尾（仓库未固定 `core.autocrlf`，Windows 检出即该形态）。
- **脚本恢复验证**：`simulate-retry.mjs` 输出完整五段链路（失败 → 切换 → 帧追加 → 轨迹渲染 → 对话渲染）；`verify-mock-failover.mjs` 对真实 mock 服务器跑通「真实 429 → 插件切换 → 真实 200」全链路。
- **平台守卫变异验证**：向 `test/` 放入使用 `.pathname` 的文件 → 守卫变红并指名该文件；移除后复绿。

## 2.0.2 (2026-09-25)

### Fixed

- **对话流里的「当前/切换/恢复模型」上下文行不可见（P0）：0.1.7 宿主把内置 `context` kind 行从可见对话流里过滤掉了**。`lib/client.js` 的 `chatModelDefinition` 原本写成 `kind: "context"`，复用宿主内置注入行。但 `dsh-client-ui-chat` 的可见性规则 `isVisibleChatNode()` 硬排除 `node.kind === "context"`（注释明写「Exclude system prompts, ordinary Context …」），且分类逻辑对插件注入消息直接归为 `context`。结果：轨迹里能看到那一行，但**对话流主视图里永远不出现**——用户可感的正是「切换/恢复模型提示消失」。
  已把节点 `kind` 改为**自有值** `chat-subagent-model-notice`（`CHAT_MODEL_NODE_KIND`）。该可见性黑名单只列 `system-prompt` / `context` / `permission` 三项，自定义 `kind` 默认可见；`source.kind`（消息来源标识，仍是 `plugin:dsh-subagent-role-router`）与节点 `kind` 是两件事，保持不动。
  注意：光改 `kind` **不够**。宿主按 `entryKey = node.kind` 在 `conversation.chat.node` 这个 **keyed 槽位**运行时分派渲染器；没有占用者的 `kind` 会落到 `ChatNodeSeat` 传入的 `fallback`——一个 `JsonBlock`（标签「unknown surface」+ 节点数据原样 JSON）。也就是说，不配渲染器的话，不可见会变成**对话流里出现一行原始 JSON**，比不可见更糟。
  故同步新增自有渲染器 `SubagentModelNoticeRow`（经 `registerSubagentModelNotice()` 注册到 `conversation.chat.node`，`key: CHAT_MODEL_NODE_KIND`，并声明 `locale:` 以收到字典）：折叠态只显示行头（圆点 + 「上下文注入 · dsh-subagent-role-router」+ summary），点开才渲染 `<pre>` 完整内容；新增 `.srr-notice-*` 样式与 zh/en 的 `row.noticeLabel`；`trajectory` 侧不受此影响（该黑名单只在 ui-chat）。
  旧注释曾写「复用内置注入行（ContextMessageNodeView）」——其复用目标在 0.1.7 已不存在，已一并勘正。

### Testing

- 新增 3 个契约用例（`plugin/test/client-trajectory.test.mjs`）：① `buildViewNode` 产出的 `kind` 必须是自有值、绝不能是宿主的 `"context"`，且 `source.kind` 保持 `plugin:dsh-subagent-role-router`；② `conversation.chat.node` 槽位恰好注册一个渲染器、`key` 必须等于节点 `kind`、组件必须是函数；③ 渲染器表现——折叠态只显示 summary、不挂载 `<pre>`，点击 toggle 后展开出完整文本且 `aria-expanded` 跟随，并对缺 `content`/`summary` 的节点容错不抛错（此时标签退化为字典 key）。
- 因 `slotRegistrations` 不再只含两张设置卡（又多了聊天渲染器），把原先按位置索引 `slotRegistrations[0]` 的断言改为 `cardRegistrations()` 按槽位名（`plugins.`）过滤，避免断言错认贡献。
- 均**变异验证**过：把 `kind` 改回 `"context"`、或把渲染器注册删掉，上面三条立刻变红，还原即全绿。全量 **90 项通过**。

## 2.0.1 (2026-09-25)

### Fixed

- **设置卡的「保存」按钮永久灰着、点不动（P0）：命名空间在 `apply` 期只探测一次，落空后永不重探**。`lib/client.js` 原本写作 `subagentScope = forms.get(subagentEntryIdOf(forms))` —— 一次性的 `get()`。但 `configForms` 的 describe mirror 是**异步加载**的（`mirror.ensure()`），`apply` 跑的时候 `view` 往往还不存在；此时 `subagentEntryIdOf` 看不到任何命名空间，只能回落到**声明条目 id** `dsh-subagent-role-router`，而桌面宿主实际服务的是 **`include:dsh-subagent-role-router`**。
  绑定错命名空间后，宿主的 `ConfigFormController.derive()` 找不到对应 `view`，把表单停在 `status: 'unavailable'`（**静默，不报错**），而 `derive()` 只在 mirror 变化时重跑——**而作用域早已被捕获，于是永远停在 unavailable**。卡片的 `saveDisabled` 含 `snap.status !== "ready"`，因此保存按钮**永久禁用**；同时因 `value` 为 undefined，卡片还会退化成「尚未指定默认模型」的空态。
  已改为 0.1.7 的官方范式 **`configForms.whileServed([...], (served) => …)`**：命名空间**进入 mirror 时**才注册贡献，并把宿主实际服务的命名空间集合交给回调，据此解析并绑定；命名空间消失时自动卸载贡献。`subagentEntryIdOf(forms, servedNamespaces)` 现优先使用该集合（它正是判定「该注册了」的依据，mirror 可能仍在折叠中），mirror 快照退居其次。
  这是 `remote.session` 那条的**同类第三次**：**「取一次就捕获」在异步就绪的服务上必然出错**。
  诊断与验证（不依赖 Electron）：以宿主 `derive()` 的真实语义构造两类作用域，渲染同一张卡片并触发改动 —— 正确绑定（`ready`）→ `Save disabled = false`（可保存）；错误绑定（`unavailable`）→ `Save disabled = true`（永久禁用）。修复前用一次性 `get()` 恰是后者。

### Testing

- 新增 1 个 **行为级**用例 `cards bind to the namespace the host actually serves when the mirror is late`：mirror 为空时 `apply` 必须**不**绑定任何命名空间、**不**注册卡片；待宿主服务的命名空间出现后，绑定必须落在 `include:<条目 id>` 上并注册两个放置点。
- 改写 `resolves the served settings namespace instead of assuming the bare id`，使其断言 `whileServed` 契约（含 `servedNamespaces.has` 优先与逐次绑定），而不再固定旧的一次性 `get()` 形状。
- 两者均**变异验证**过：把实现改回「`apply` 期一次性探测」后立刻变红，还原即全绿。全量 **86 项通过**。

## 2.0.0 (2026-09-25)

### Breaking

- **宿主最低版本提升至 `@deepseek-ai/dsh >= 0.1.7-rc.1`**（peer 区间收窄为 `>=0.1.7-rc.1 <0.2.0`，全部 8 个 `@deepseek-ai/*` peer 一致）。0.1.7 线删除了本插件此前依赖的三处契约：`@deepseek-ai/dsh-settings` 的 `installSettingsSection` / `settingsNamespace` 命名导出、客户端 `settingsScope` 服务与 `settings.plugin.item` 槽位。依据同族插件 `dsh-ldvh` 的同源调研。

### Changed

- **设置接入迁移到 0.1.7「插件 Config 即设置」模型**：`lib/index.js` 导出 `Config`（字段逐个 `.volatile()`），移除对 `@deepseek-ai/dsh-settings` 的**命名导入**——该导入在 0.1.7 上会导致模块链接期失败、整个宿主插件无法装载，且因 peer 区间「覆盖了该版本」而不会被版本检查拦下（**范围覆盖 ≠ 符号仍存在**）。写入改走 profile patch（经宿主 `configEditor`）。
- **客户端设置面迁移**：硬注入 `settingsScope`（0.1.7 已删除，会让整个客户端插件永不 apply）改为仅硬注入 `slots` / `locale`，`configForms` 改软注入；设置卡从已删除的 `settings.plugin.item` 迁到 `plugins.bundle.config` 与 `plugins.row.config` 双注册。
- **设置卡对齐同族范式**：`view: 'page'` 默认展开、`view: 'summary'` 只渲染一行描述，展开/收起按钮补 `aria-label`。
- **`dsh-client-ui-primitives` 图标族适配**：尺寸数字后缀（`…Outline14`）→ 粗细语义后缀（`…OutlineRegular` / `…Medium`），改为按名探测取第一个可用者并在渲染点兜底——把宿主改名造成的渲染期**硬崩溃**降级为视觉降级。

### Fixed

- **会话整体拒绝加载（P0）：对话流注入行仍用 v3 已废除的消息来源包装 `{ kind: "plugin", plugin: … }`**。会话格式 v4 要求每条落盘消息的 `source.kind` 是**生产者自有**标识（`user` / `tool` / `agent-message` / 插件用 `plugin:<包名>`）；旧的裸 `"plugin"` 包装已在 v4 中废除。厂商迁移器**只在读取** v3 会话时改写（`rewritePluginSource`），**活插件运行时直写**旧形状会绕过迁移、直接撞上 `assertV4MessageSources` 的硬校验并抛
  `format v4 message requires a producer-owned source kind`。
  本插件每次注入模型通知行都带 source，因此**每一轮都触发一次**——真实会话 `session-dbff9280`（cwd `dsh-subagent-role-router`，2026-09-25 16:24）的 `titleInput` 里该报错重复了 **5 次**，整轮运行失败。
  更严重的是失败范围：`assertV4MessageSources` 在**会话被收养（adopt）时扫描全部历史消息槽**，因此**单条坏 source 会让整份会话不可加载**（该会话已无 `session.v4.jsonl.zstd`，仅存一份 projcache 存档，损失不可逆）。
  已把 `lib/client.js` 两处发射点改为自有的 `source: { kind: "plugin:dsh-subagent-role-router", … }`（`form` / `summary` 等附加字段不受影响）。**注意与 `98bf2a7` 的节点 kind 区分**：`source.kind` 是消息来源标识，节点 kind 是渲染分类，二者不可混改。
  回归护栏见 `plugin/test/client-trajectory.test.mjs` 的 `assertProducerOwnedSource`（逐字模拟 `assertV4MessageSources`：拒绝 `{kind:"plugin",plugin:"x"}` / `{kind:""}` / `{}` / `undefined` / `[]`，放行 `{kind:"plugin:dsh-subagent-role-router"}`）。
- **宿主整体装载失败（P0）：依赖树指向已被删除的 `/Applications/DSH Desktop.app`**。`plugin/node_modules/@deepseek-ai/` 下的 `schemastery` / `cordis` / `dsh-settings` 三个条目是**指向旧应用包的符号链接**；应用换成 `DSH NEXT.app` 后这些链接全部悬空，`lib/index.js` 第一行的 `import z from "@deepseek-ai/schemastery"` 直接 `ERR_MODULE_NOT_FOUND`。宿主表现为 `dsh-subagent-role-router (dsh-subagent-role-router): failed to import`，插件**一行都没跑**——而 `npm test` 仍全绿。已删除悬空链接并以 `npm install` 重建为真实目录。判据：`find node_modules -maxdepth 3 -type l ! -exec test -e {} \; -print` 必须为空。
- **devDependency 精确锁定致 `npm install` ERESOLVE**：`@deepseek-ai/dsh-settings` 写死 `0.1.7-rc.1`，而它自身 peer 依赖 `@deepseek-ai/dsh-brand@0.1.7-rc.1`，该包只发布了 `0.1.7-rc.2`，于是干净安装直接失败。这正是本仓 CHANGELOG **1.2.2 已经记过的那条教训**（「此处必须用范围而非精确锁定」）——被 0.1.7 适配时的版本推进重新踩了一次。已改为 `^0.1.7-rc.1`。
- **旧 `settings.yaml` 配置不会随 0.1.7 迁移过来**：0.1.6 及更早，本插件把配置注册为 `~/.dsh/settings.yaml` 的 `subagent-default-model` 段。0.1.7 起该文件在启动时被**一次性导入并改名**为 `settings.yaml.imported`（改名先于首次写入，所以部分导入永不重试），导入按段名**直接当条目 id** 使用，而本插件的条目 id 是 `dsh-subagent-role-router`——于是该段导入失败，宿主日志留 `section subagent-default-model … was not imported into entry subagent-default-model`，`profile/cordis.patch.yml` 里始终没有本插件的 `config:`。**本机实测命中**：旧值仍在 `.imported` 文件中，需手工搬进 profile patch。README / DEVELOPMENT.md 已改为描述 0.1.7 的真实存储位置并写明该陷阱（原文档仍在教用户编辑 `~/.dsh/settings.yaml`）。
- **设置保存必然失败（P0）**：`Config` 未声明 `reasoningEffort`，而设置卡的保存路径每次都写入该键。宿主 `@deepseek-ai/dsh-settings` 的 `write()` 对每个写入路径执行 `Config field "…" is not volatile` 门禁，因此**任何一次保存都被拒绝**——不只是改推理强度，而是整张设置卡存不进去，且界面只显示笼统的「保存失败」。已把 `reasoningEffort` 补为声明字段并标记 volatile；`getSection()` 同步读回该键，否则单模型形态配置的推理强度会被静默忽略。
- **设置卡可能绑定到无人服务的命名空间**：0.1.7 的 `configForms.get()` 对宿主 served-namespace 目录做**精确匹配**，而桌面宿主以 `include:<包名>` 挂载 Loader 条目。绑定错误时 `status: unavailable`、**静默失效不报错**（同 `dsh-ldvh` abb35db、`dsh-connect-workbuddy` 2.0.16 修掉的同一类坑）。现抽为具名 `subagentEntryIdOf(forms)`，按「声明条目 id → `include:<条目 id>` → 包名子串」的顺序匹配，仅在 mirror 未就绪时回落到声明 id。已用真机命名空间 `include:dsh-subagent-role-router` 做端到端绑定验证。
- **回落常量取的是已退役的 0.1.6 段名**：`SUBAGENT_MODEL_SETTINGS_NS` 原为 `"subagent-default-model"`，那是 0.1.6 及更早 `settings.yaml` 独立设置模型里的段名；0.1.7 起命名空间**就是 Loader 条目 id** `"dsh-subagent-role-router"`。mirror 未就绪时按旧名回落会绑定到无人服务的命名空间。已改为条目 id；`lib/index.js` 中被遗留的同名常量（仅声明、从未使用）一并删除——宿主而非插件拥有「条目 id ↔ 命名空间」的映射，插件不该保留第二份。
- **图标回退分支无样式**：`IconChevronDown` 探测全缺失时渲染 `.srr-plugin-card-caret` 字形，但该类**只有使用点、没有 CSS 规则**。已补规则，并加守卫用例禁止「渲染了却无规则」的类再次出现。
- **设置卡的 Provider / Model 下拉永远为空（P0）：`remote.session` 是异步挂载的服务，插件却在 `apply` 时只取一次**。`lib/client.js` 原写法 `var sessionRemote = ctx.get("remote.session")` 把叶服务**捕获**进变量；而该服务由网关的**异步** `remote.$mount()` 注册（`packages/api/gateway/src/client/index.ts`：`remoteServiceKey(ns)` → `remote.<ns>`，挂载点在 `async $mount` 内）。`apply` 跑的时候网关通常还没挂完 → 捕获到 `undefined` → `loadCatalog` 从此恒返回空数组，**而且因为值是捕获的，之后挂载完成也永远不会重取**。表现就是设置卡能打开、两个下拉却没有任何可选项。
  已改为**每次调用时懒探测**（先 `ctx.get("remote.session")`，再退回 `ctx.get("remote")?.session`），晚到的挂载即可被拾取；网关始终缺失时仍降级为空下拉且不抛错。官方同功能卡片（`ui-settings-subagent`）是把 `'remote','remote.session'` 写进 `inject` 让 Cordis 等待；本插件保持软注入（网关缺失不该扣下整张卡），因此改用重探测达到同样效果。
- **同族坑：`ctx.get()` 不按点号拆分**。Cordis 的 `get(name)` 是整串查表（`this.ctx[symbols.isolate][name]`），`"remote.session"` 之所以成立，是因为网关真的以这个字面量注册了服务（`remote.${namespace}`），不是 `remote` 的嵌套属性访问。所以「带点的服务名」能否解析，只能以**是否有人注册过该整串**为准——按「父对象.子属性」去推断会得到错误结论。
- **Plugins 详情页整块没有配置区（P0）：读取未在 `inject` 声明的服务会抛错，把 `apply` 后半段整段打断**。`lib/client.js` 用 `if (ctx.uiConversation && ctx.uiConversation.events && …)` 这种「守卫写法」读 `ctx.uiConversation`，而它**没有**出现在 `inject` 里。Cordis 对未声明的服务**不返回 `undefined`**，而是抛 `cannot get property "uiConversation" without inject`（Cordis `lib/index.js` 的 service accessor；已用真实 `new Context()` 复现）。因此那个 `&&` 守卫**完全无效**——求值 `ctx.uiConversation` 本身就是抛错点。
  致命之处在于位置：该读取位于 `apply()` **中段**，它一抛，**其后**的 `ctx.inject(["configForms"], …)` 整块——也就是注册设置卡的那段——再也不会执行。于是详情页连配置区外壳都不出现（宿主只在 `ledger.bundles.has(包名)` 时才渲染该区块），且宿主日志只留一行、没有栈。
  已把 `uiConversation` 加进 `inject`（与官方全部 7 个消费者一致：ui-chat / ui-plan / ui-deliverables / ui-open-in-app / ui-settings-account / ui-settings-models / ui-model-selection）。`configForms` 仍走软注入——它本身是可选的，且 `ctx.inject` 正是「等它就绪而不抛错」的 API。
- **同族坑：`ctx.<service>` 的读取必须声明，`ctx.get()` 才是无声明探测**。前者抛错、后者返回 `undefined`。凡「想可选地用一个服务」只能走 `ctx.get` / `ctx.inject`；写成 `if (ctx.foo && …)` 不但拦不住，还会把 `apply` 打断在最坏的位置。
- **「当前供应商/模型」上下文行不再出现（P0）：0.1.7 适配时把 `uiConversation` 从 `inject` 里误删，导致每次 `apply` 都在读它时抛错**。对照本仓 HEAD 可见演进：适配前是 `["slots","locale","settingsScope","remote","remote.session","uiConversation"]`，适配后只剩 `["slots","locale"]` —— `uiConversation` **不在 0.1.7 的删除清单里**（被删的是 `settingsScope`），属误伤。而本轮 §「未声明服务读取会抛错」已证明：读未声明的服务是**抛错**而非返回 undefined，于是 `apply` 在第 610 行中断，其后两个 `events.register` 与设置卡注册全部不执行——用户可感的正是**「切换模型/当前模型的上下文提示消失」**。已把 `uiConversation` 加回 `inject`。
- **同族坑：`ConversationEventRegistry.register` 对重复 `kind` 抛错，必须包进 `ctx.effect`**。我们把两个 conversation 定义**裸调**注册且丢弃 disposer（`conversation Definition "<kind>" is already registered`）。Cordis 在替换 fiber 时会再次执行 `apply`，第二次注册即抛错——修复 `inject` 后它仍会中断 `apply` 后半段（含设置卡）。官方全部消费者（`ui-plan`、`ui-deliverables` …）都写作 `ctx.effect(() => ctx.uiConversation.events.register(def), '…')`，让 Cordis 在重挂前先释放。已按该范式包裹两处。
  注意：**多定义 `match` 同一事件是设计允许的**——`assembler.dispatchInput` 会遍历**所有**定义并逐个 `accept`，不是「先到先得」。因此本插件的 `request/header` 定义与官方 `ui-trajectory` 的同名匹配**不冲突**，可见性问题与匹配竞争无关。
- **客户端半边整体不激活（P0）：`apply` 重复执行时命中宿主 locale 重名抛错**。`lib/client.js` 的 `apply` 在函数最开头无条件调用 `ctx.locale.register("settings.subagentModel", …)`，且**丢弃返回值**。宿主 `@deepseek-ai/dsh-client-locale` 对「命名空间已有该语言」是**抛错**（`locale namespace "…" already has locale "…"`），而 Cordis 在 fiber 被替换时会再次执行 `apply`——于是第二次 apply 在注册设置卡**之前**就抛错。宿主表现为 `web boot: 1 entry did not activate` / `dsh-subagent-role-router: failed`，客户端半边**全部贡献**（设置卡、轨迹行、对话行）都不注册，且宿主日志只留一行，没有栈。
  已按同族 `dsh-ldvh` / `dsh-sub-cli` 的范式把登记包进 `ctx.effect(...)` 并**接住两个 disposer**：Cordis 在重挂前会先释放上一次登记，重入即从干净命名空间开始。
  复现与验证方式（不依赖 Electron）：以真实 `locale` 语义（重名抛错）+ Cordis 语义（effect 在重挂前释放）构造 stub，连跑三次 `apply` —— 修复前 `#1:OK #2:THREW #3:THREW`，修复后 `#1:OK #2:OK #3:OK`。
  **这一条是被「测试全绿」掩盖的第三个 P0**：原测试的 `locale.register` stub 只做字典合并、从不抛错，所以永远测不出只对第一次 apply 成立的登记。

### Notes

- **`npm test` 全绿不能证明宿主能装载**：测试与宿主走的是两条不同的模块解析路径（测试从 `plugin/` 解析，宿主从 profile 经软链解析）。本轮三个 P0 里有**三个**在测试全绿的情况下依然让插件完全不可用。宿主编译期的唯一判据是**真正 import 一次**：`cd ~/.dsh/profiles/<profile> && node --input-type=module -e 'import("<包名>")'`。
- **stub 比被测代码宽松时，测试会给假绿灯**：`locale` 那条 P0 的根因就是 stub 省略了宿主唯一的失败路径（重名抛错）。写 stub 时应**先读宿主实现**再决定放行什么——本次是照 `dsh-client-locale/lib/client.js` 的重名抛错逐字建模后，才复现出来。
- **客户端半边是否真的激活，要按 `failed` / `pending` 区分**：两者都表现为「插件在 Web 上不见了」，但机制相反——`pending (waiting for service: …)` 是硬注入了一个不存在的服务（apply 因为等不到服务而从未运行）；`<id>: failed` 是 apply **跑了但抛错**。查证入口是 `~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`，它同时给出判据行与 renderer console。
- **改完 `node_modules` 后，已在运行的宿主进程不会重新 import**：它把失败状态留在内存里，`plugin_manager` 反复 enable/disable 都返回同一个 `failed to import`，且不再写新日志。验证修复必须**重启应用**，而不是重试开关。


### Docs

- **安装入口改写**：`dsh plugin --profile desktop add <path>` 在新版桌面壳上会被拒绝（`profile "desktop" is managed exclusively by the Electron application`）。DEVELOPMENT.md 改为走 DSH Desktop 内插件管理 / `plugin_manager` 的 `install_bundle`（target = 插件包绝对路径），并补上三条安装后核对（bundle 列表、软链、`listConfigs` 条目 id）。
- README（中/英，根与包内）配置示例从 `~/.dsh/settings.yaml` 段改为 profile patch 的 `config:` 块，并写明旧文件的一次性导入与段名不匹配陷阱。


### Testing

- `plugin/test/client-trajectory.test.mjs` 新增 5 个契约用例：服务命名空间必须经 `subagentEntryIdOf` 解析且不得裸调 `get(声明id)`、`include:` 前缀命名空间下必须绑定到宿主实际服务的那一个、回落常量必须是 Loader 条目 id 而非遗留段名、`page` 形态默认展开 / `summary` 形态只渲染一行、全部渲染类都必须有 CSS 规则；另加匹配优先级用例（宿主同时服务 `include:<条目id>` 与遗留段名时，精确匹配必须胜出）。
- 新增 `plugin/test/dependency-integrity.test.mjs`（3 项）——把本轮两个 P0 变成测试能拦住的回归：① 依赖软链不得悬空（`lstatSync` 是链接但 `existsSync` 为假即失败）；② 声明的 runtime dependency 必须在 `node_modules` 里存在；③ devDependency 不得是精确预发布锁定（`^\d.*-` 即失败）。两条守卫都用**变异验证**过：重新造一个悬空链接、把 `dsh-settings` 改回 `0.1.7-rc.1`，各自都被对应用例抓住。
- 全量 **85 项通过**（原 63 项 + 设置/图标契约 5 项 + 依赖完整性 3 项 + `apply` 重入契约 3 项 + 模型目录契约 3 项 + 服务声明契约 2 项 + 会话行注册契约 2 项 + 其余 4 项）；`node integration.mjs`（8 项）与 `node prove.mjs`（1 项）同样通过。
- 新增 2 个 **会话行注册契约**用例（`plugin/test/client-trajectory.test.mjs`），针对「上下文提示消失」：① 用一个**重复 `kind` 即抛错**的注册表 stub 模拟宿主语义，断言三次 `apply`（中间执行 fiber teardown）都能把两个定义重新登记上去——修复前第二次即抛 `already registered`；② 静态守卫，要求两处 `ctx.uiConversation.events.register` 都必须写成 `ctx.effect(function () { return ctx.uiConversation.events.register(…) })`。
  同样用**变异验证**过：把两处改回裸调后，上述 2 条立刻变红，改回即全绿。
- 新增 2 个 **服务声明契约**用例（`plugin/test/client-trajectory.test.mjs`），其中一个用**真实 Cordis**（`new Context()` + `root.plugin({ inject })`）跑 `apply`，断言它必须**正常完成**而不是在未声明服务的读取处抛错——这正是「详情页没有配置区」的根因所在。另一个是静态守卫：把客户端源码去掉注释后，凡 `ctx.<service>` 形式的**属性读取**都必须出现在 `inject` 里。
  同样用**变异验证**过：把 `uiConversation` 从 `inject` 拿掉后，上述 3 条（含真实 Cordis 那条）立刻变红，加回即全绿。
- **跨 realm 断言注意**：客户端工厂由 `new Function` 执行，其数组带的是另一个 realm 的 `Array.prototype`，对两个「内容相同但来源不同」的数组用 `assert.deepEqual` 会误报失败（`actual: []` / `expected: []` 却判不等）。相关用例改用 `assert.equal(arr.length, …)` 比较。
- 新增 3 个 **模型目录契约**用例（`plugin/test/client-trajectory.test.mjs`）：① `remote.session` 在 `apply` **之后**才挂载时，`loadCatalog` 必须重探测并取到目录；② 网关**始终缺失**时降级为空数组且不抛错；③ 守卫 `apply` 不得把 `remote.session` 捕获进变量（防止这个 bug 以任何形式复发）。
  同样用**变异验证**过：把 `loadCatalog` 改回「`apply` 时一次性捕获叶服务」的原始写法后，①③ 立刻变红，改回修复版即全绿。
- **跨 realm 断言注意**：客户端工厂由 `new Function` 执行，其数组带的是另一个 realm 的 `Array.prototype`，对两个「内容相同但来源不同」的数组用 `assert.deepEqual` 会误报失败（`actual: []` / `expected: []` 却判不等）。这两条用例改用 `assert.equal(arr.length, 0)` 比较。
- 新增 3 个 **`apply` 重入契约**用例（`plugin/test/client-trajectory.test.mjs`）：① 以真实 `locale` 语义（重名抛错）连跑三次 `apply`，每次先释放上一 fiber 的登记，三次都必须干净登记；② 显式记录边界——宿主若**不**先释放就重挂，仍会抛 `already has locale`（所以登记必须留在 `ctx.effect` 内）；③ 断言 locale 登记确实被 `ctx.effect` 包住（否则 Cordis 无从释放）。
  这 3 项同时用**变异验证**过：把 `lib/client.js` 改回「无条件登记、丢返回值」的原始写法后，①③ 立刻变红，改回修复版即全绿。
- P0 已用**宿主门禁的独立复现**验证：对适配前的 5 字段 `Config` 跑宿主 `isVolatilePath`，`reasoningEffort` 判定为 `not volatile` → 写入抛错；补上该字段后 6 个写入路径全部通过。
- 宿主接缝已逐项在**运行时目录**核对（不是只搜源码）：`agent/request-error`（waterfall）、`agent/request`（waterfall）、`agent/disposed`（emit）三者均存在；已删除的 `agent/session-start` 未被本插件引用；`subagents` 服务的 `start` / `startContinuable` 签名与包装点一致。

## 1.3.0 (2026-09-22)

### Features

- **设置面板预检 `reasoningEffort` 是否被目标模型声明，不匹配时给出红字警告**：当所配 effort 不在目标模型当前声明的 `reasoning.efforts` 内（或该模型**根本没有声明任何 effort**）时，在该路由行内与保存区各显示一条警告，指明具体缺失的档位。选中即时校验，声明补齐后警告自动消失；**保存不被阻止**——供应商目录可能尚未刷新，卡住保存会把用户困在一个暂时性的状态里。
- **警告文案区分「模型未声明任何推理强度」与「未声明指定档位」两种情形**，后者会把档位名插值进文案（`{effort}`）。

### Fixes

- **不再让「effort 不被支持」这类配置错误静默表现为「子代理没有任何上下文」**。此前：所配 effort 不被目标模型接受时，宿主在 `prepareRequest()` 阶段就抛 `UNSUPPORTED_REASONING_EFFORT`，**早于** system prompt 组装与上下文注入，也**早于** `agent/request-error` 瀑布派发。子会话因此只有 11 个事件、`request/header` 与 `system/message` 均为 0——界面上表现为「这个子代理里什么都没有」，父会话只收到一句 `failed before it finished / It left no closing message`；真实错误码只落在会话日志里。实测对照：同一路由在声明补齐后连续 3 次成功（descriptor 逐字一致），确认其成因是**上游供应商目录的能力声明在时间窗口内缺失**，而非本插件注入有误。本插件的确定性缺陷是**从不校验**：`reasoningEffort` 在 schema 层仅校验为字符串，因此界面能选出的值与运行时能接受的值可能在窗口期内不一致。本次在设置面板补上该校验。

### Testing

- `plugin/test/client-trajectory.test.mjs` 新增 13 个用例（9 个纯函数契约 + 4 个面板渲染）：覆盖「声明命中不报」「声明缺该档位报并插值档位名」「模型完全未声明 effort 报」「未配置 effort 不报」「未知 provider/model **不报**」「空 efforts 数组等同未声明」「畸形 catalog 与不完整路由不抛异常」，以及渲染侧断言警告节点确实进入组件树、文案插值已解析（非字面量 `{effort}`）。
- 保守方向**是**被测试保护的：把「未知模型」也判为不支持会同时打挂两个用例（纯函数与渲染各一），已用该变异验证。
- 渲染用例驱动**真实注册的卡片组件**（经 hook 感知的 React 替身展开子组件）而非直接调用纯函数，否则接线丢失不会被发现；已用「让检查返回 null」的变异验证其可捕获性。
- 全部 61 项测试通过（原 48 项 + 新增 13 项）。

## 1.2.3 (2026-09-16)

### Fixes

- **故障转移切换到目标模型时，补上目标条目自己声明的 `reasoningEffort`**：`agent/request` 缝合处原本把继承来的 `reasoningEffort` 丢弃后**不再补值**，于是切换过去的请求仍带着上一条路由的 thinking 模式。对于「thinking 档位必须与 effort 一致」的 provider（pi-ai / anthropic-messages 一类），这会直接返回 `400 invalid thinking type, only be disabled when reasoning effort is none and enabled when reasoning effort is not none`。实测中该错误码为 `INVALID_REQUEST`、**不在**触发列表内，因此**不可重试**：故障转移把池子里所有候选逐个消耗在这个永远不可能成功的请求上，子代理最终失败——**尽管池中配置了健康模型**。现在目标条目声明了 effort 就用它；未声明时保持 `undefined`，由 adapter 解析该模型自身的 `defaultEffort`（或整个省略 reasoning 选项），不再继承目标可能不支持的上游档位。
- **故障转移不再重复选中本次运行已经切换过的池条目**：原 `nextFailoverIndex` 仅按 `count` 计数前进，不记录已尝试项；当无法从 `agent.session.requestContext()` 定位当前路由时（`found < 0`）直接回到 index 0，可能切回刚失败的模型或重复选同一个坏候选，白白消耗配额。现在按 `agent.id` 记录本次运行已切换到的索引集合并跳过它们；仅当全部条目都已尝试（或每次切换都失败）时才回落到普通轮询前进。

### Testing

- `plugin/test/failover.test.mjs` 新增两个回归用例：`applies the target entry's own reasoning effort when switching models`（断言切换产物为 `{ provider: "zzztoken", model: "deepseek-v4-pro", reasoningEffort: "max" }`）与 `does not re-select a pool entry this run already switched to`（三条目池，断言第二次切换落到未尝试过的条目）。前者已用回退验证确认可捕获原缺陷（回退实现即失败），不可静默回退。
- 为已有用例 `drops inherited reasoning effort when switching models` 补充注释，说明其断言仅适用于目标条目**未声明** effort 的情形，避免与新增用例的语义混淆。
- 全部 48 项测试通过（原 46 项 + 新增 2 项）。

## 1.2.2 (2026-09-10)

### Fixes

- **修复 peer 区间不接纳 DSH 0.1.5-rc.1（桌面 2.0.9 捆绑内核）**：原区间 `^0.1.0-rc.6 || ^0.1.1-rc.2 || >=0.1.2-alpha.1 <0.2.0` 在语义化版本预发布规则下**不匹配 `0.1.5-rc.1`**——一个预发布版本只有在同一比较器集合中存在**相同 `major.minor.patch` 元组**且带预发布标识的比较器时才可能被接纳；`>=0.1.2-alpha.1` 的元组是 `0.1.2`，无法为 `0.1.5` 承载预发布。实测在宿主已装 `0.1.5-rc.1`（即 DSH Desktop 2.0.9 的实际运行环境）时，npm 抛 `ERESOLVE overriding peer dependency` 并不满足警告，pnpm/严格模式与依赖审计同样判定不符。新增 `>=0.1.5-alpha.1 <0.2.0` 子句为 0.1.5 线提供同元组承载后，0.1.5-alpha.1 / alpha.2 / rc.1 / rc.2 全部被接纳，同时仍排除 `0.2.x`。
- **devDependencies 基线推进到 0.1.5 线**：`@deepseek-ai/dsh-settings` `0.1.2-rc.1` → `^0.1.5-rc.1`。此处**必须用范围而非精确锁定**：`dsh-settings@0.1.5-rc.1` 自身 peer 依赖 `@deepseek-ai/dsh-brand@^0.1.5-rc.1`，而该包当前只发布了 `0.1.5-rc.2`（`next` 通道），精确锁定 rc.1 会直接 ERESOLVE 装不上。这也印证了内核 0.1.5 线已进入 rc.2 迭代、不宜写死补丁版本。

### Testing

- 新增 `plugin/test/peer-range.test.mjs`：从 `package.json` 读取真实 peer 区间做契约回归，自带预发布感知的 semver 判定（已与官方 `semver` 对 12 个版本逐一比对一致）。断言覆盖：所有 peer 均带 0.1.5 元组承载子句；0.1.0-rc.6 起的全部受支持版本可被接纳（含 `0.1.5-rc.1` 这一回归点）；`0.2.x` 仍被排除；并显式复现原区间拒绝 `0.1.5-rc.1` 的缺陷，使该问题不可静默回退。
- 全部 46 项测试在真实 `0.1.5` 线依赖上通过（含 default-model / failover / settings-install / client-trajectory 集成用例）。

### Compatibility

- 保留对旧宿主的支持：`^0.1.0-rc.6`、`^0.1.1-rc.2`、`>=0.1.2-alpha.1 <0.2.0` 三个原有子句逐字保留，未收窄任何既有可装区间。
- 生成器路径自动选择（`installSettingsSection` 在场则委托、否则走 `settings.installSection` 官方缝）未改动；`0.1.5-rc.1` 捆绑包中两种导出与官方缝均在场，两条路径均可用。

## 1.2.1 (2026-09-06)

### Fixes

- **适配 DSH 0.1.2-alpha.2+ 的 dsh-settings 结构变更**：设置段注册迁移到官方 `settings` 服务缝（`ctx.inject(["settings"], …)` → `settings.installSection`）。`@deepseek-ai/dsh-settings` 自 0.1.2-alpha.2 起移除了独立的 `installSettingsSection` / `settingsNamespace` 导出——纯净 npm cohort 宿主（`@deepseek-ai/dsh` CLI、直跑 `dsh web`、CI）上旧导入会直接模块加载失败；此前仅靠 DSH Desktop 的过渡兼容补丁续命。按模块导出有无自动选择路径：仍有旧导出（0.1.0-rc.6 / 0.1.1-rc.2 / 桌面补丁版）走旧助手，否则走官方缝，声明的 peer 区间 `^0.1.0-rc.6 || ^0.1.1-rc.2 || >=0.1.2-alpha.1 <0.2.0` 全程可装。
- **对话视图跳过 `request/header` 的 `series` reason**：DSH 0.1.2 在后续轮开启新请求系列且配置未变时追加 `reason:"series"` 帧；插件不再为其生成行，避免多轮（continuable/steer）子代理每轮多出一行冗余的「当前供应商/模型」。`initial` / `change` / `resume` 三种提示行为不变。

### Testing

- 新增 `plugin/test/settings-install.test.mjs`：安装路径决策单测（旧助手在场→逐字委托；缺席→官方缝、消费者 ctx 保持 section owner；模块缺失→缝兜底）。
- devDependencies 升级：`@deepseek-ai/dsh-settings` `0.1.0-rc.6` → `0.1.2-rc.1`（纯净版，无旧导出），`@deepseek-ai/cordis` `^4.0.1` → `^4.0.2`——现有 default-model / failover 集成测试现在端到端运行真实官方缝路径。

## 1.2.0 (2026-09-01)

### Features

- **适配 DSH 0.1.2 客户端模型目录接口**：设置卡模型目录从已移除的 `connection.api.llm.models()` 迁移到 `remote.session.modelCatalog()`，继续支持供应商、模型与推理强度下拉选择。
- **设置卡正常路径回归测试**：新增真实 Client bundle 沙箱测试，验证 `settings.plugin.item` 注册、`subagent-default-model` key、Client inject 声明以及 `modelCatalog()` 成功响应解析。

### Fixes

- **恢复插件设置卡显示**：补齐 Client bundle 依赖声明，并将设置卡的运行时服务依赖调整为 `remote.session`，避免旧 API 导致 Plugins 标签页渲染失败。
- **设置注册不再等待 subagents 服务**：Host 设置 namespace 独立注册；`subagents` 服务出现后再安装默认模型包装器，避免服务挂载顺序导致设置卡消失。
- **刷新设置 namespace 目录**：Client 卡片注册后主动刷新 `settingsScope.describe()`，避免社区插件晚注册时被设置页初次读取遗漏。
- **适配 `uiConversation` 服务名**：轨迹和对话模型提示改用 DSH 0.1.2 的 `uiConversation.events` 注册入口。

### Compatibility

- 扩展 `@deepseek-ai/*` peer 范围以覆盖 DSH `0.1.2-alpha.1`，Client peer 均保持 optional，不阻塞独立安装。

## 1.1.1 (2026-08-31)

### Changed

- **模型行文案改为「当前供应商/模型」**: 轨迹视图与对话视图的模型提示行前缀从「子代理模型」改为「当前供应商/模型」（英文同步为 `Current provider/model`），更准确地表达该行展示的是当前请求实际使用的供应商与模型。同步更新测试断言、simulate 脚本与文档示例。

## 1.1.0 (2026-08-31)

### Features

- **轨迹视图显示模型路由**: 子代理每次请求实际用的 provider/model 会显示在**轨迹视图**里——换模型（含 failover 切换）后自动多出一行「子代理模型：`provider/model`」。基于官方 `request/context` 帧（`trajectory-subagent-model` 定义），零宿主改动。
- **对话视图新增模型提示行**: 子代理**对话视图**新增上下文注入行（`chat-subagent-model` 定义，基于官方 `request/header` 帧的 `reason`）：
  - 子代理开始第一句：`子代理模型：provider/model`（写清当前用的供应商与模型）
  - failover 切换成功后：`已切换到：provider/model`（展示现在用的是哪个模型）
  - 会话恢复时：`继续使用：provider/model`
  - 折叠态即可见（`source.summary`），复用 DSH 原生 `ContextInjectionRow`。
- **切换提示文案改为 Provider**: 「连接失败时按队列与策略切换模型」的提示从「需配置 ≥2 个模型」改为「需配置 ≥2 个 Provider」。实测确认：官方重试按 `provider` 记账（`dsh-llm-retry`），同一 Provider 下多模型共享重试配额、第二个模型不重试；**每个模型配独立 Provider 时，各拿满自己的重试次数，全部失败才停**。

### Docs

- 新增 `docs/mock-failover-test.md`：本地 mock 模拟连接失败的完整测试指南（SSE 支持、`MOCK_ALL_FAIL=1` 全失败模式）。
- 新增 `docs/per-model-retry-design.md`：「每个模型独立重试 + 逐个切换 + 全部失败才停」的需求、根因分析（官方重试按 provider 记账）与实现方案；方案 B（每模型一个 provider）已实测通过。

### Testing / Scripts

- 新增 `plugin/test/client-trajectory.test.mjs`：轨迹 + 对话定义的单测（匹配、三种 reason 文案、节点结构、buildViewNode），测试 **36/36 通过**。
- 新增 `plugin/scripts/mock-llm-server.mjs`：本地 OpenAI 兼容 mock，支持 SSE 流式响应与全失败模式。
- 新增 `plugin/scripts/simulate-retry.mjs`：端到端 failover 模拟，输出轨迹/对话视图渲染预览。

## 1.0.0 (2026-08-29)

### Features

- **子代理连接失败自动切换（failover）**: 新增 `failoverEnabled` 复选框（默认勾选），子代理的模型请求遇到限流（RATE_LIMIT）、配额（QUOTA）、服务端/传输错误、空响应时，自动在 `models` 列表内按 `strategy`（轮换/随机）切换模型重试——**仅对 subagent 生效**，主代理循环不受影响。基于官方 `agent/request-error` + `agent/request` 瀑布，与社区的 `dsh-llm-fallback` / `dsh-model-failover` 插件同机制。
- **设置卡片新增复选框**: 设置面板「子代理默认模型」卡片的分配策略下方新增「连接失败时按队列与策略切换模型」复选框，默认勾选，保存后生效。

### Docs

- README 新增「子代理连接失败自动切换」章节，含配置示例与字段说明表。

## 0.3.5 (2026-08-28)

### Added

- **卡片底部「鼓励一下 ★」链接**: 设置卡片底部左侧新增低调灰色小字链接（含五角星），点击在新标签页打开 GitHub 仓库页；零依赖，仅用 CSS + Unicode `★`，不引用任何图标组件
- **文档 `docs/cheer-link.md`**: 独立说明该功能的效果、三步接入法、关键原理与可调参数，供其他插件直接复用

### Changed

- **卡片箭头改为空心宽折线**: 头部箭头从文字三角 `▾` 改为 `@deepseek-ai/dsh-client-ui-primitives` 的 `IconChevronDownOutline14`，与「网页搜索」等内置卡片一致；`.srr-plugin-card-chevron` 加 `display:inline-flex` 使图标居中

## 0.3.4 (2026-08-26)

### Changed

- **设置卡片 UI 对齐内置插件**: 「子代理默认模型」卡片底部新增「放弃修改」按钮，与「保存」一起放入带顶边框的 footer；按钮样式精确复刻 DSH 内置设置卡片（描边「放弃修改」+ 实心「保存」、`border-radius:8px`、`padding:5px 14px`、禁用 `opacity:.4`）
- **添加模型按钮** 改为与内置一致描边样式
- **分配策略单行**: 「分配策略」标签改用纯文本 + `white-space:nowrap`，与下拉框（`max-width:150px`）同排一行
- **下拉框收窄**: 所有设置下拉与路由输入框 `max-width:220px`（策略行 `150px`），不再撑满整行
- 移除渲染中不再使用的内置 `Button` 引用

### Docs

- 同步 `README.md`、`README.en.md`、`RELEASING.md` 中发布包 `files` 说明（加入 `icons/`）

## 0.3.3 (2026-08-26)

### Features

- **插件卡片图标**: 「子代理默认模型」设置卡片标题前新增 LD（LaoDing）品牌 logo，图标以 data URI 内联，不依赖外部静态资源
- **npm 包图标**: `package.json` 新增 `icon` 字段（128px），`files` 加入 `icons/`，图标随包发布，便于市场与扩展市场识别

### Docs

- **仓库首页重构**: `README.md` 重排为标准开源插件格式，含标题、亮点、工作原理、效果预览、安装、配置、市场收录说明、开发、卸载、许可证
- **发布元数据完善**: `package.json` 补齐 `keywords`、`author`、`repository.directory`、`homepage`、`bugs`、`engines.node`
- 新增 `.github/workflows/ci.yml`（Node 20、`npm ci`、`npm test`、`npm pack --dry-run`）
- 许可证对齐 MIT，版权归属 `LaoDing`

## 0.3.2 (2026-08-24)

### Changed

- **设置面板迁移到「插件配置」**: 设置行从 `settings.general.item`（通用设置）迁移到 `settings.plugin.item`（插件配置），key 为 `subagent-default-model`。新增 `SubagentModelCard` 折叠卡片外壳，默认收起、点击展开，样式与其它可配置插件一致；卡片标题带插件名括号（如「子代理默认模型（dsh-subagent-role-router）」）。
- 文档同步：`README.md`、`plugin/README.md`、`PLUGIN_REQUIREMENTS.md`、`DEVELOPMENT.md` 中的「设置 → 通用设置 → 子代理默认模型」更新为「设置 → 插件配置 → 子代理默认模型」。

## 0.3.1 (2026-08-24)

### Docs

- **README 中英双语双文件**: `README.md` 重写为纯简体中文，新增 `README.en.md` 英文翻译，顶部加语言切换链接；`package.json` 的 `files` 加入 `README.en.md`

## 0.3.0 (2026-08-23)

### Features

- **推理强度选择**: 设置面板每行模型路由新增「推理强度」(Reasoning Strength) 下拉菜单，模型支持时自动加载可选强度（如 `high`/`medium`/`low`），不支持时显示「Default」
- **Host 侧支持**: schema 和 resolve 逻辑透传 `reasoningEffort` 到子代理的 `agentOptions`，覆盖单模型和多模型两种配置模式
- **Web UI 适配**: 设置面板 grid 从 3 列扩展为 4 列，新增中英文 locale 字段

### Fixes

- **序列化兼容**: `normalizeDefaultModels` 修复模型条目缺 `provider` 时继承顶层 provider 的逻辑
- **保存校验**: `serializeDefaultModels` 正确处理 `reasoningEffort` 字段序列化

## 0.2.0 (2026-08-19)

### Features

- 多模型支持：`models` 列表 + `round-robin` / `random` 策略
- 设置热重载：配置变更立即生效，无需重启

## 0.1.1 (2026-08-18)

### Features

- Web 设置面板（插件配置 → 子代理默认模型）
- 保存成功 Toast 通知

## 0.1.0 (2026-08-16)

### Features

- 初始版本：单模型默认注入
- Host 侧 `ctx.subagents` 服务包装（`start` / `startContinuable`）