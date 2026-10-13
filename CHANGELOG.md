# Changelog

## 0.6.0 — 连接状态标签 + 一键重连：让「悄悄失效的 MCP」看得见、救得回

**这一版修的是一个会让人白折腾很久的问题**：如果 DSH 启动时某个 MCP 连不上，它**再也不会
恢复**——哪怕服务器随后正常了，工具也不会回来，而面板上什么都没有。实测用户环境里的
`deepwiki` 就是这样静默失效了 15 分钟以上（服务端一直健康）。

根因在 `@deepseek-ai/dsh-mcp-client`（DSH 的依赖，不是本插件）：

- **`failOnStartupError: true` 时一次都不重试**。`apply` 只 await **第一次**尝试的
  `connection.ready`，失败即抛错 → 插件实例失败 → 清理时 `dispose()` 把 `disposed`
  置真并 `clearTimeout(reconnectTimer)` → 重试循环连同实例一起消失。
- **`failOnStartupError: false` 时会重试，但预算用完就永久放弃**。默认
  `maxAttempts: 10`、`initialDelayMs: 500`，退避 500→1000→…→30000，**总共只等 151.5 秒**；
  之后的日志是 “giving up after 10 consecutive failed reconnect attempts — reload the plugin
  or restart the Host to reconnect”，然后彻底停止。用户那三条项目级条目
  （`initialDelayMs: 1000`）预算是 **181 秒**。

两种情况都终结于「只能重启」，而**状态在界面上完全不可见**——工具凭空消失，没有任何说明。

### 新增

- **每张 MCP 卡片带连接状态标签**：

  | 标签 | 含义 |
  |---|---|
  | `已连接 · N 个工具` | 正常 |
  | `未连接 · 重试中 · 预计剩 Ns` | 还在预算内，会自己恢复 |
  | `已放弃重试` | 预算已用完，**不会**自己恢复 |
  | `激活失败` | 该有实例却没有（`failOnStartupError: true` 那条路径） |
  | `连接中` / `未挂载` | 尚未得出结论 / 该项目当前没有会话（不是故障） |
  | `已停用` | 用户停用（此时不再显示连接状态，避免留一个过期的「已连接」） |

- **一键「重连」**（在需要它的状态上才出现）：全局行 = 让 Loader 重建该行（停用→启用），
  项目级条目 = 失效挂载 key 重挂。两条路都**不需要重启 DSH**——`dsh-hmr` 用 chokidar
  精确监听 profile 的 patch 文件，写入即时生效。两次写入刻意**跨 tick 分开**并在中间
  等待 Loader 确认，因为写入后立刻改回可能被合并成「无变化」而根本不触发重载。

### 怎么观测到的

客户端把重试计数关在闭包里（`failedAttempts`、`reconnectTimer` 都没有导出），
`connection.ready` 又只代表第一次尝试，所以没有现成的状态可读。本版改用两个可观测信号：

- **劫持 `mcpResources.register`**（手法与 0.5.3 的工具过滤器一致：只写实例、写后验证、
  失败如实报告、可 restore，且**不做任何拦截**）。客户端在 apply 一开始就注册，于是这个
  点同时给出「实例是否还在」和「连接是否活着」。它对**两种层级都生效**——全局行由 Loader
  挂载、项目级由本插件挂载，都会走到同一个注册点。工具注册表做不到这点：项目级的工具挂在
  agent 作用域里，无作用域的 `schemas()` 看不到。
- **存活探测**：`connection.resources.request` 在未连接时会在**发出请求前**就抛
  `server is disconnected`，所以「任何别的回答」都恰好证明客户端是活的（服务器回「方法不
  支持」也算活着）。探测按 12 秒 TTL 节流，且从不阻塞发布。

**推导而非上报**：「重试中 / 已放弃」是按该行配置算出的预算与已耗时推出来的（客户端不上报
重试次数），所以界面一律写「预计」。这是这一版刻意保留的诚实边界。

### 修复

- **`phase` 一直是个死字段**。原先读 `entry.fiberPhase`，但那是
  `dsh-host-plugin-inventory` **另外算出来的派生字段**，原始 Loader entry 上只有
  `entry.fiber` —— 于是行状态永远是空串，面板无法区分「连上了但没工具」和「压根没加载
  起来」。现在按官方 `FiberState` 映射从 `entry.fiber.state` 推出。

### 顺带

- 用户那三条项目级条目的问题现在有解了：把「重连最大次数」设大（如 `10000`）、
  「重连最大延迟」设 `60000`，即可让它在服务器回来后自动连上；另外**不要勾**
  「连不上时拒绝激活」——勾上等于一次都不重试。

## 0.5.3 — 按服务器筛选工具、工具清单可视化、备份只留一个文件

- **备份改成只留一个滚动文件**。以前每次改写 `cordis.patch.yml` 都写一个带时间戳的副本，
  一天下来堆了 **135 个文件、却只有 5 种不同内容**（其中 130 个是逐字节重复，同一份内容
  被备份了 99 次）。备份的用途是**撤销上一次操作**，它只需要保存「当前状态之前的那一份」，
  第 2、第 3、第 100 份同样的字节买不到任何东西。现在固定写在
  `$DSH_HOME/skills-mcp-panel.backups/cordis.patch.yml.bak`，每次覆盖。

  代价说明白：滚动文件只能回退一步——如果某次改写写坏了、而你在发现前又保存了一次，
  好的状态就会被覆盖。要长期历史应该交给版本控制，而不是让配置目录里躺满副本。
- **修：测试套件一直在往真实的 `$DSH_HOME` 里写备份**（上面那 135 个文件的主因）。
  `backupPatch` 是这条路径上唯一不走 `writeFileAtomic` 的副作用，**却没有注入点**——
  `patch.apply.lossless.test.mjs` 的注释里写着「用 scratch 备份目录，避免碰 ~/.dsh」，
  但那个注入点根本不存在，于是每次跑测试都往真实目录丢一个备份。因为测试用的是固定夹具，
  备份内容还完全相同，这就是「99 次重复」的来源。现在备份目录可注入，该测试指向临时目录，
  并补了一条断言钉住「真实 `$DSH_HOME` 一个字节都不该被写」。
- **新增「只保留需要的工具」：按服务器筛选 MCP 工具**。面板在展开卡片里给出三档
  ——全部保留（默认）/ 只保留勾选 / 只挡勾选——并逐条勾选。被挡下的工具**不会进入
  注册表**，因此也不占用每次组装工具面的 token。

  为什么必须自己实现：`dsh-mcp-client` 的 `Config`（stdio 与 streamable-http 两种
  zod 变体）**没有任何白名单字段**（`allowedTools`/`includeTools`/`excludeTools` 均无），
  而 `ctx.tools.restrict()` 用的是另一条路——它**要求 scoped 上下文**，全局调用会抛错
  （"a context-global restriction would mask every agent"），而且只**遮罩**定义、
  定义仍在注册表里可被内省。唯一能把工具挡在注册表外的接缝是 `register` 本身。

  顺序上正好占优：本插件是 **bundle 层**，而 MCP 行在 profile 的 `cordis.patch.yml`
  （用户补丁层），profile 的组装顺序是先 bundle 补丁、后用户补丁。所以面板在 MCP 客户端
  注册第一批工具**之前**就装好了劫持，无需用户手动排行序。真机验证也证实了这点：
  过滤状态里 `installed: true` 且 `preExisting: []`（没有任何工具在劫持之前注册）。

  劫持只打在工具服务的**实例**上、不打原型：按名字查找的调用方（`syncTools` 正是如此）
  才看得见写入，而原型属于恰好被导入的那份包副本。

  几处刻意的取舍：
  - **fail-open**：判不了名字就放行。过滤器的自身 bug 不该变成「能力凭空消失」。
    `Reflect.set` 在不可写属性上返回 `false` 且可能静默失败，所以写入结果是被**验证**的
    ——否则会出现「报告安装成功、实际一个都没过滤」这种最坏情况（这条已由测试钉住）。
  - **空的白名单 = 未配置**，而不是「清空该服务器」。勾了开关还没选工具是尚未配置，
    按字面理解会把整个服务器清空。
  - **未配置的服务器、非 MCP 的内置工具**一律放行；归属按**最长前缀**判定，
    这样 `github` 与 `github__enterprise` 并存时工具不会挂到错的服务器上。
  - **规则每次注册都重新读取**，所以面板里改完即生效，不需要重启。
  - **已注册的工具无法被注销**（插件做不到），所以新开的规则要等该服务器重新同步
    或重启 DSH 才完全生效——面板就这一点给出明确提示，避免用户以为功能没生效。
  - 过滤器**没装上**（工具服务不可用 / `register` 不可写）时面板如实显示原因，
    而不是让「关着」和「装不上」长得一样。
  - 勾选界面的淡化表示「**不会被注册**」，而**不是**「没勾选」——deny 模式下两者相反，
    照着勾选状态淡化会把保留下来的工具淡化掉（这个错真实发生过，现已由测试钉住）。
- **展开卡片不再显示与传输无关的字段**。http 行不再出现「命令 / 参数 / 环境变量」，
  stdio 行不再出现「地址 / 请求头」——以前是一律显示并填 `—`，整片占位符读起来像表格噪声。
  可选字段（参数、环境变量、请求头）只在有值时出现。
- **补齐请求头（headers）的编辑入口**。`form.js` 里早就声明了这个字段、数据流也贯通，
  但表单从未渲染它 —— 等于 http 传输**根本没有鉴权头的写入入口**。
  同时修正提示文案：host 端按 `KEY=VALUE` 解析（`parseEnv`），而提示原文写的是 `KEY: VALUE`，
  **照提示填会静默失效**；又因为请求头是 `KEY: VALUE` 形态，直接复用环境变量的掩码
  会把 `Authorization: Bearer sk-…` 原样显示出来，所以另加了 `maskHeaders`。
- **请求头与环境变量支持「清空即删除」**。以前留空被当作「未改动」，清掉一个已配好的
  密钥后保存，键会留在配置里；现在由客户端算出 `headersChanged` / `envChanged`
  再交给 Host（沿用连接参数那套做法），清空即删键、未改动则一个字节都不碰。
  环境变量的 `PATH` 例外：`spawnEnv` 必须注入它，否则 stdio 行里的 `npx` 找不到可执行文件。
- **展开卡片新增工具清单**。数据取自 harness 自己的工具注册表
  （`ctx.tools.schemas()`，MCP 客户端把工具注册成 `mcp__<serverName>__<tool>`），
  按服务器归组后发布给面板；**不新建第二条连接**。读态下工具名保持完整——它就是模型要调用的名字；
  进入勾选界面后显示短名（前缀在每行都相同，重复它会埋掉真正不同的那部分），完整名留在 `title` 里。
- **工具清单的失败会说明原因**，而不是笼统的「不可读」。五种状态刻意区分：
  读到（列出工具）、读到但该服务器没有工具、**Host 是旧版本**（错误字段整个缺失 → 提示重启 DSH）、
  Host 正常但尚未发布该行、以及 Host 报告的具体失败（含原始错误信息）。
  起初只返回「空」不够用：判断旧 Host 的依据是 `serverToolsError` 字段**是否存在**，
  拿「原因为空串」当判据会把「注册表健康、只是该服务器没有工具」误报成「需要重启」。
- **工具行的标题与副标题拉开层级**。之前工具名和描述都是 11.5px，两行等价、看不出哪个是
  名称；现在工具名 13px + 字重 500 + 主色，描述 11px + 三级色，行高走面板已有阶梯
  （13px→20px、11px→16px）。字重试过 600，实际偏粗、与 DSH 自身的层级不符，回到 500。
- **描述不再按字符数截断，改为完整展示 + 折行封顶**。原先砍到 140 字符：多数描述本来很短，
  这一刀白白砍掉信息（实测 35 个真实 MCP 工具：中位 74 字符、p25 49）。测量结果也显示长尾
  很极端（p90 318、最长 2006，且 14% 含换行），所以保留完整文本、只给极端长的少数一个
  4 行上限，完整内容仍可通过悬停的 `title` 查看。
- **把 DSH 自动注入的 `PATH` 与用户自填的环境变量分开显示**。每个 stdio 行都会被写进一条
  `PATH`（桌面版 Host 的 PATH 不含 node，不注入的话 `npx` 会死在
  `#!/usr/bin/env node` 上），它的值是**机器的登录 PATH**，几百个字符且每行相同。
  以前它混在「环境变量」里显示，看起来像是用户配的，还会撑爆卡片；现在单独标注为
  「PATH · DSH 自动注入」，用户没填变量时也不再出现「环境变量」行。
  编辑表单仍如实回填它（它确实属于那一行，不回填就会在保存时被删掉），但会说明它是自动的。
- 修 `scripts/host-smoke.mjs` 的两处可移植性缺陷：它硬编码 `npx tsc`（没装 npm 的机器上门禁
  被静默跳过）与 `symlink`（Windows 需提权/开发者模式）。现在直接调用本地 tsc 入口，
  并用目录联接替代符号链接，冒烟门禁在任何机器上都真的会跑。
- 新增 27 个测试（工具清单多状态区分、请求头打码与清空语义、未改动不写坏），
  并把工具清单通道与「错误字段必须存在」纳入 Host 冒烟断言。

## 0.5.2 — 修复：项目级 MCP 的连接参数不回填、编辑后条目跳到列表末尾

- **修复：项目级 MCP 编辑时不回填「连接与重连」**。编辑草稿只填了名称/传输/地址等字段，
  漏了那 4 个连接参数，所以输入框永远是空的（显示 placeholder「500（默认）」），
  一保存就把已配好的值覆盖成默认——看起来就是「设了 1000 不生效」。
  现在项目级编辑与全局一样回填（`draftFromRow` / `connectionDraft` 同一套）。
- **修复：编辑一个项目级条目会把它挪到列表最后**。`replaceServer` 是「过滤掉旧的 + 追加到末尾」，
  改成按原位置替换（找不到才追加）。
- **修复：编辑项目级条目会静默把它重新启用**。保存时原先硬写 `enabled: true`，
  现在沿用该条目原来的启用状态（同时保留 `source` 等未在表单里出现的字段）。
- 新增客户端回归测试：项目级编辑必须回填 `1000/60000/60`、保存后仍在原位置、
  未改动的字段不被清空、且不会串改另一条目。该测试在修复前的代码上会失败
  （`连接字段没回填：["","",""]`），已验证。

## 0.5.1 — 修复：只改 URL 会把已有的 reconnect 配置删掉

- **修复**：编辑一个已配好连接策略的 MCP 行时，只要没碰那 4 个输入框，保存后**不再**动它们。
  原先「留空即删键」在编辑场景下把「用户清空了」和「表单根本没显示过」混为一谈：Host 半若
  是旧版（不投影这些字段）或表单未回填，一次只改 URL 的保存就会把 `reconnect` /
  `failOnStartupError` 静默删掉。现在由客户端计算「是否真的改过」并随 op 传下去
  （`connectionChanged`），Host 只在为真时才写；缺少该标记时保守地视为未改动。
  真清空输入框仍然会删键回到默认值 —— 这条语义没变。
- 新增回归测试：只改 URL 保留已有值 / 标记为改动才写 / 缺少 original 时是 no-op

## 0.5.0 — MCP 连接与重连可配（failOnStartupError / reconnect.*）

- **新增：MCP 的「连接与重连」配置**。添加/编辑 MCP 时多一组输入，直接对应
  `@deepseek-ai/dsh-mcp-client` 自己的字段，全局（配置文件行）与项目级（面板条目）都支持：

  | 表单 | config | 默认 |
  |---|---|---|
  | 连不上时拒绝激活 | `failOnStartupError` | `false` |
  | 重连首次延迟（ms） | `reconnect.initialDelayMs` | `500` |
  | 重连最大延迟（ms） | `reconnect.maxDelayMs` | `30000` |
  | 重连最大次数 | `reconnect.maxAttempts` | `10` |

  **留空即用 DSH 默认值**（不写多余配置）；编辑时清空输入框会把对应键删掉，回到默认。
  边界值取自客户端自己的 zod schema（延迟 `1–2147483647`、次数 `≥1` 的整数）：越界或非整数
  会被拒绝并给出原因 —— 直接写进配置会让整行加载失败。项目级挂载遇到非法值则退回默认值，
  不让一个填错的数字把整次挂载（以及重编排循环）带下去。
- **修复：编辑 profile 里的 stdio 行会把命令行写坏**。行投影里的 `target` 是「命令 + 参数」
  拼出来的（`npx -y pkg`），原先把 `target` 回填进表单的 `command`，保存后该行的 `command`
  就变成了 `npx -y pkg` 这个并不存在的可执行文件。现在投影额外提供原始 `command`，
  编辑改用 `draftFromRow()` 回填，命令与参数各归各位。
- 内部：连接策略字段的解析收进 `src/mcp/connection.js` 一处，两条写路径（写 YAML / 挂载）
  共用同一套边界与回填逻辑

## 0.4.1 — 重新发布（0.4.0 的版本号被 npm 永久保留，不可重用）

- **内容与 0.4.0 完全一致**，没有任何功能改动。0.4.0 从 npm 删除后，registry 永久保留该版本号
  （`npm error 400 Cannot publish over previously published version "0.4.0"`），只能换一个版本号重新发布
- 本次发布由 GitHub Actions 通过 npm **可信发布（Trusted Publisher / OIDC）** 完成，无需任何 token，
  并带 provenance 签名（可在 npm 页面与 sigstore 透明日志核对）

## 0.4.0 — 首个可发布版本：去掉 @local，按 npm / 插件市场的要求打包

- **包名（scoped）**：`dsh-skills-mcp-manager` → **`@j62268781-alt/dsh-skills-mcp-manager`**。
  不带 scope 的名字虽然 npm 上是空的，但插件市场目录里已有一个**同名同功能**的条目
  （`zebbkira/dsh-skills-mcp-manager`），所以用 scope 把 npm 名固定在自己账号下。
  同步改了 `cordis.patch.yml` 行名、客户端 bundle id、部署路径与文档里的每条命令；
  GitHub 仓库名与市场条目名保持不变（仍是 `dsh-skills-mcp-manager`）
- **包名**：`@local/dsh-skills-mcp-panel` → **`dsh-skills-mcp-manager`**（npm / 仓库 / 面板 id 同名）。
  同步改了 `cordis.patch.yml` 的行名、客户端 bundle 的 `__ModuleLoader__.load({ id })`、
  部署目标目录与 `verify-served.mjs` 的匹配串
  > `dsh-skills-mcp-panel` 这个名字在 npm 上已被他人占用（KyattoCat 的同类插件），故不用它
- **可发布字段**：`license` / `repository` / `homepage` / `bugs` / `author` / `keywords` /
  `main` / `engines.dsh` / `publishConfig.access=public` / `icon.svg`，并加了 `prepack`（发布前自动 build）
- **发布清单**：`files` 白名单收紧成 `dist` + `lib/client.js`（不再把 `lib/src/**` 源码打进包里）
- **市场收录**：新增根目录 `screenshots.json`（两张面板截图）与
  `docs/market-entry.yml`（awesome-dsh-plugin 条目，直接复制进 PR）
- **文档**：新增 `docs/PUBLISHING.md`（npm 发包、GitHub Release、上架插件市场、每次发版清单）；
  README 的「安装」改成用户视角（插件市场 → 命令行 → 从源码），并指向发布文档
- **README 只留用户视角**：自测命令、诊断文件与恢复手册搬到 `docs/DEVELOPMENT.md`（新增），
  README 里只留一条「更多文档」索引；两张预览图改用 raw.githubusercontent 绝对地址，
  这样在 npm 页面与 GitHub 上都能正常显示
- **打包**：`prepack` 改为 `prepare`。`prepare` 除了在 `npm pack` / `npm publish` 前构建，还会在
  **git 安装时**由包管理器执行，于是「源码安装」这条路也能用：两个插件市场在 npm 包未发布时
  都会回退到 `dsh plugin add github:j62268781-alt/dsh-skills-mcp-manager`，而 `dist/` 不进版本库，
  没有 `prepare` 就装出一个跑不起来的插件（1024 Store 的闸门把这个标签判为
  `entry_missing_no_prepare`，补上后变为 `prepare_builds_entry`）
- **CI**：新增 `.github/workflows/ci.yml` —— push 到 `master` 与所有 PR 在 Node 20 / 22 / 24
  三个版本上各跑一遍 `build` + `gate`，并核对 `npm pack --dry-run` 的清单
- **CI 发布**：新增 `.github/workflows/publish.yml` —— 发布 GitHub Release（tag `v<版本>`）即自动
  核对版本 → 构建 → 跑门禁 → 发包到 npm；优先走 npm 可信发布（OIDC，无需 secret），
  没配 Trusted Publisher 时回退到 `NPM_TOKEN`；支持手动触发与 `dry_run` 演练
- 修复：请求 nonce 从 `String(Date.now())` 改为 `时间戳36进制-序号`。同一毫秒内发出的两次
  操作会生成同一个 nonce，于是「上一次的回执」被当成这一次的回执（删除/保存的转圈一闪而过）；
  客户端集成测试在 Node 18 上偶发复现
- 修复：登录 shell 不再写死 `/bin/zsh`。Linux 上没有 zsh，查 PATH 直接抛错 → stdio MCP 子进程
  拿不到 PATH（`npm run gate` 的两个 runtime.env 测试在 CI 上就是这么挂的）。现在优先用 `$SHELL`、
  退回 `/bin/sh`，PATH 查询改成 POSIX 的 `printf %s "$PATH"`，查不到时回退到本进程的 PATH
- 修复：`npm test` 不再把目录当参数传给 `node --test`（Node 24 会报
  `ERR_UNSUPPORTED_DIR_IMPORT`），改用 test runner 的默认发现，18/20/22/24/26 都一致
- 设置命名空间仍是 `skills-mcp-panel`：**已有配置不迁移、不丢**（它只与行 id 有关，与包名无关）

## 0.3.2 — README 重写为面向用户的插件说明（含两张面板截图）+ 三处小修

- **README**：从 556 行的开发日志改成用户向的插件说明（亮点 / 界面预览 / 安装 / 使用 /
  工作原理 / 开发与自测 / 诊断与恢复 / 已知边界）；产品名定为 **dsh-skills-mcp-manager**
  （安装进 profile 的包 id 仍是 `@local/dsh-skills-mcp-panel`，改名需要单独迁移 profile 配置）
- **文档**：原 README 全文搬进 `docs/ENGINEERING.md` 留档（真机验证记录 / 事故复盘 / 踩坑清单）
- **截图**：新增 `scripts/screenshots.mjs`，用真实构建产物离线渲染 `docs/images/mcp-panel.png`
  与 `docs/images/skills-panel.png`（示例数据全是编造的，不带作者的服务器地址与路径）
- 导入卡片文案里漏出的 Markdown 星号（`**用户级**`）改为纯文本
- 技能列表页全局卡片上重复渲染了两个 `key="view"` 的「预览」按钮（同一个 key 渲染两次，
  一个按全局读、一个按项目读）；现在按条目自己的 scope 取一次，并按落盘规则推出
  `SKILL.md` 路径，预览才真的读得到正文
- 导入来源下拉补上 `vscode`：Host 的来源表里一直有 VS Code，面板之前选不到它

## 0.2.0

- 全局 MCP 改为 `cordis.patch.yml` 里的独立 Loader 行（面板通过 row op `add`/`update`/`delete`/`toggle` 管理）
- 项目级 MCP 仍由插件按 `agent/created` + cwd 挂进 agent 作用域
- MCP 导入：26 个来源（Claude / Cursor / VS Code / Gemini / Qwen / Continue / Crush / Zed / opencode / KIMI / Qoder / …），
  全局读用户级配置、项目级读选中工作区，跳过同名不覆盖
- 界面：行卡片对齐模型页、标题/间距/滚动条对齐内置插件页、官方 Modal 做删除确认、
  在途操作 loading（删除/切换/保存/新增）、全局限定行内展开与停用
- 诊断：心跳文件 `$DSH_HOME/skills-mcp-panel.heartbeat.json`，patch 写入前自动备份

## 0.3.0 — 按 create-dsh-plugin(panel) 规范完成模块化重构

### 工程结构

```
package.json          exports: "." -> ./dist/index.js (Host)，"./client" -> ./lib/client.js
tsconfig.json         tsc 构建 Host 半（allowJs，可增量转 TS）
esbuild.config.mjs    把 lib/src/** 打成单文件 lib/client.js（CSS 以 text loader 内联）
scripts/deploy.mjs    拷贝式安装进 profile（旧版自动备份；不用符号链接，见下）
src/                  Host 半（源码）
  index.js            插件入口（apply / Config / 定时器装配）
  patch/rows.js       配置文件行手术：定位/插入/改字段/启停/删除（纯函数）
  patch/apply.js      applyRowOp + backupPatch（锁与原子写可注入 setPatchIO）
  runtime/env.js      登录 PATH、内置 runtime、裸命令解析、parseEnv/splitArgs/spawnEnv
  import/sources.js   26 个来源表 + 形态适配（zed / opencode）
  import/scan.js      单来源扫描
  project/mount.js    cwd 祖先匹配 + stdio/http 挂载配置（mcp-client 可注入）
  skills/reconcile.js 技能落盘与回收（状态文件记录 owned 文件）
  diagnostics/heartbeat.js  beat / beatFile
lib/src/              Client 半（源码）
  client.js           入口与组件组合
  styles/panel.css    全部面板样式
  crud/servers.js     行操作构造（add/update/toggle/delete + 草稿/条目转换）
  crud/skills.js      技能条目（scope 归属、按 name+scope upsert、名称校验）
  crud/import.js      导入的既有名字集合与新增/跳过拆分
  crud/inflight.js    在途 loading 状态机（含 15s 超时 / 4s 编辑宽限）
  components/dialog.js  官方 Modal 删除确认
  components/card.js    展开详情字段表（环境变量始终打码）
  components/form.js    字段定义、提示文案 HINTS、校验
  components/sections.js 分组副标题与空态文案
  components/filters.js 仅按名称搜索等过滤
test/                 按接口拆分的接口测试（node --test test/）
```

### 命令

```bash
npm run check      # 两半语法检查
npm test           # 接口测试（80 项）
npm run build      # build:host (tsc) + build:client (esbuild)
npm run deploy     # 安装进 desktop profile（旧版备份为 .backup-<时间戳>）
node scripts/integration-import.mjs   # 走真实 settings 通道的导入集成测试（需 app 依赖）
```

### 为什么安装用拷贝而不是符号链接

Node 默认把符号链接解析到真实路径，Host 半的 `@deepseek-ai/*` 依赖只能从 profile 的
`node_modules` 解析 —— 链到工作区必然失败，因此 `scripts/deploy.mjs` 采用拷贝 + 备份。

### 本轮修复的静默失败（拆分过程中暴露）

- 抽 `patch/apply` 时漏导入 `writeFile`，被 `backupPatch` 的空 catch 吞掉 → **备份失效**
- 抽 `diagnostics/heartbeat` 时用 async `mkdir/writeFile` 却导入 sync 版 → **心跳文件从未写出**
- 抽 `skills/reconcile` 时把状态写入切到了 `return` 之后（不可达）→ **技能清理永不生效**
- 客户端搜索用的是整行 JSON 匹配，与"只搜名称"的要求不符 → 已改为只匹配名称
- `matchesName(undefined, 'x')` 因 `String(undefined)` 含字母 x 而假命中 → 非字符串不再匹配
- 行已消失时 toggle 的 loading 会空转到超时 → 改为立即结算

对策：空 `catch` 改为 `SMP_DEBUG=1` 时打印真实异常；新增"通用导入核对"（扫描 src/** 的
导出，谁引用未导入就补齐），这类错误不再靠报错逐个发现。

## 0.3.1 — 技能删除对齐 MCP：去掉多余边框 + 删完卡片立刻消失

用户反馈两点：技能行删除中比 MCP 多一个边框；点了删除列表不刷新。

- **多出来的边框**：删除中状态此前塞在 `data-variant=danger` 的按钮里，按钮自身的
  错误色描边就成了「删除中…」外面那圈圆角框。现在整组动作按钮在删除期间被替换成
  与 MCP 行完全一致的「转圈 + 删除中…」纯文本状态
- **删了卡片还在**：真正的来源是创建时插入的乐观卡片（`optimistic`）——删除成功后设置
  文档不再列出该技能，于是那张本地乐观卡片又被渲染出来（幽灵卡片），用户只好再点一次
  删除，第二次自然回「不存在」。现在删除回执到达即清掉该技能的乐观卡片，并登记
  `name::scope` 墓碑，直到设置文档真的跟上为止；失败且磁盘上已不存在时同样收掉幽灵卡片
- 删除失败的原因现在可见（此前写进 `skillError`，但没有任何地方渲染它）
- 删除 15 秒无回执不再无限转圈（Host 半重载/异常时会留下没有回执的请求）
- Host 半：技能操作抛异常也会写回执（以前只打日志，前端卡片会一直转圈）
- 回归测试：新增 `test/client.deleteFlow.test.mjs`（迷你 React 运行时真跑「创建 → 删除 →
  回执」流程；在修复前的 bundle 上 10 项断言中 3 项失败）；`host-smoke` 增加删除与重复
  删除断言，并把固定等待改为轮询（原先在有计时扰动时会假失败）
- `verify-served.mjs` 解码 esbuild 的 `\uXXXX` 转义后再匹配中文（此前「添加服务器」在
  正确的 bundle 上也必然假失败）
- 删除排查用的临时计时探针（`probeLines`/`probeState`/`probeRef` 与 `.smp-probe` 样式）：
  刷新延迟已定位并修复，面板上不再显示那段「① 发送 / ② 回执 / ③ 列表」的自检卡片
- `.gitignore` 忽略 `.agents/skills/`：本仓库作为工作区时，面板落在这里的项目级技能与
  删除备份属于运行时数据（早先误提交过一个冒烟技能）
