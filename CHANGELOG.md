# Changelog

## 0.5.6 — MCP OAuth：点击授权与自动刷新

> **本版没有破坏性变更。** 新增能力可以在老配置上直接生效；`needs-auth` 状态与手贴
> `Authorization` 请求头的旧做法都保留。Host 侧改动需要**重启一次 DSH**，客户端改动刷新页面即可。
>
> 使用与安全说明见 [`docs/oauth.md`](docs/oauth.md)；设计取舍与逐条实测证据见
> [`docs/oauth-feasibility.md`](docs/oauth-feasibility.md)。

### 1. 受 OAuth 保护的 MCP 服务器现在能真正连上了

0.5.5 及以前，面板只能把 401 **识别**成「需要授权」并如实标注 —— 因为
`dsh-mcp-client` 构造 transport 时只传 `requestInit.headers`，从不传 `authProvider`，于是 SDK 的
`if (status === 401 && this._authProvider)` 分支永不成立，客户端把授权要求当成网络故障重试 10 次后
永久放弃。用户看到的是「已放弃重试」，而真相是「去授权一下就好」。

现在卡片上有一个**授权**按钮：点它拿到授权链接，复制到浏览器完成登录，回调落在 DSH 自己的端口上，
令牌随即落盘。之后每次请求前 SDK 都会读一次令牌，401 时自动用 refresh_token 续期 —— **不再需要手贴
header，也不会因为令牌过期而静默变砖**。

实现分三个部件，每一个都能独立地如实失败：

| 部件 | 做法 |
|---|---|
| SDK 定位 | 从宿主包 `import.meta.resolve` 的位置反推运行时 `node_modules`，取 SDK 的 **ESM** 入口 |
| 原型补丁 | 在 `StreamableHTTPClientTransport.prototype.start()` 里注入 `_authProvider` |
| 流程 | 直接用 SDK 的 `auth()` 编排（发现 → DCR → PKCE → 换令牌 → 刷新），本插件只补两段式与回调 |

**为什么打在 `start()` 上**：`Client.connect()` 必调 `start()`，而 Streamable HTTP 的 `start()`
不发 HTTP（2.2.0 里只有两行）。首个请求在 `_startOrAuth()` / `_send()` 里，都会先
`await _commonHeaders()` —— 那里读 `_authProvider`。

**为什么必须命中 ESM 那一份**：SDK 是双包，`index.mjs` 与 `index.cjs` 给出**不同的 class 对象**
（实测 `===` 为 false）。`dsh-mcp-client` 是 `"type": "module"`，走 ESM。补丁打在 CJS 那份上不报错，
只是永远不生效 —— 表现是「点了授权没反应，日志里什么都没有」。

### 2. 补丁必须能如实失败，否则就是一个假按钮

SDK 的私有字段（`_authProvider`、`_commonHeaders`、`start`）会随版本变化，所以：

- 打之前检查三者的存在性、以及原型是否可扩展；
- 打之后**用真实例验一次** `_commonHeaders()` 真的带上了 `Authorization`；
- 任何一步不成立 → `oauthState.ready = false` + 原因，面板显示原因并**不显示按钮**。

第三点是关键：这类补丁最坏的结局不是抛错，而是「装上了但没生效」。用户会看到一个永远点不成功的
按钮，并以为是自己操作错了 —— 比没有按钮更糟。

### 3. 授权状态与令牌是两件事

`oauthServers` 投影只发布「有没有令牌、能否刷新、何时过期、要不要你去点」，
**绝不包含令牌本体**。投影会写进 profile 的 patch 文件，把 `access_token` 放进去等于把它写盘，
并可能进日志。

凭据单独存放：`$DSH_HOME/dsh-skills-mcp-manager/oauth/<serverName>.json`，
目录 `0700`、文件 `0600`，**一台服务器一个文件**（一份坏 JSON 不会让全部授权一起消失）。

### 4. 回调路由是唯一不做 `requestRejection` 的路由

授权服务器把浏览器 302 到 `redirect_uri` 时**不带** DSH 的浏览器鉴权 cookie，加上那道检查的唯一
结果是每次回调都被 401，授权永远完不成。安全边界完全落在 `state` 上：

- 定长比较（`timingSafeEqual`），**按 UTF-8 字节**比长度（用字符数会让它抛错，把一次伪造回调变成 500）；
- 一次性 + 10 分钟超时；
- `state` / `code` 必须各出现一次（重复参数是绕过「取第一个」的经典手法）；
- 只接受 GET，响应带 `cache-control: no-store`。

### 5. 升级 DSH 0.2.1 解锁的两项优化

- **SDK 2.2.0 不再让静态 `Authorization` 吃掉动态令牌**。2.0.0 的实现是
  `new Headers({ ...dynamic, ...static })`（静态赢），2.2.0 改成先用静态值建 `Headers` 再
  `set('Authorization', …)` 覆盖。实测：2.0.0 下 `init[Authorization]` 会覆盖动态令牌、`init[authorization]`
  会拼成 `Bearer A, Bearer B` 的坏头；2.2.0 下两种大小写都是动态令牌获胜。**因此注入路线不需要先删除行内
  `Authorization`** —— 调研文档里那条「必须先删 header」的前提只对 2.0.0 成立。
- **`dsh-tools` 的 `mode` 收窄**（`native` / `ptc` / `both` → `native` / `ptc`）。本插件不依赖它，但
  若将来要引入 PTC，只能整体切换，不能混用。

### 6. 顺带修掉的两处门禁问题

- **`host-smoke.mjs` 的响应桩 `setHeader` 是 `noop`**：断言读 `cache-control` 永远读不到，于是
  「回调整页不可缓存」这条断言**永远不会失败**。改成真的存 header —— 一个不会失败的断言等于没有断言。
- **`oauthServers` 一度把「上次读取时刻」发布进投影**：那个值每个 TTL 就变一次，会让投影的 key
  在每次 publish 都不同，于是 Host 每 5 秒写一次 settings。这正是 0.5.3 修过的
  `discoveryInfo.at` 老毛病，被现有的「空闲扫描与连接倒计时不触发 settings 写盘」断言当场抓住。
  现在发布的是**凭据本身**的变更时间，读取时刻只用于 TTL。

### 7. 真机验证暴露并修掉的两个问题

**a) `redirectUri` 一直是空的。** 重启后 `oauthState.ready` 是 true、SDK 2.2.0 已加载、补丁验过，
但投影里 `redirectUri: ""`。根因：`oauthRedirectUri()` 读的是 `ctx.webServer`，而本插件的
`inject` 只有 `['loader']`，顶层根本拿不到那个服务（只能 `ctx.get('webServer')`）。
空 `redirect_uri` 的后果比看起来严重：SDK 的 `provider.redirectUrl` 为 `undefined` 时会把流程
判定为**非交互**，直接跳掉授权码分支 —— 而且完全静默，`ready` 仍说 true、按钮仍渲染。

**b) transport 与 flow 各持一份 provider。** `oauthLookup` 每次调用 `makeOAuthProvider` 新建
实例，而 flow 用它自己 Map 里的另一个。两份内存缓存互不可见：用户授权后 `flow.complete()` 把
令牌写进它那份，transport 仍读自己那份「没有令牌」的快照 —— 服务器永远 401，面板却显示
「已授权」。现在 `oauthLookup` 通过 `flow.providerFor()` 取**同一个实例**，并有单测钉住
「同一 (serverName, url) 必须返回同一个 provider」。

这两个都是由**真机/真协议**发现的，单元测试与冒烟都看不见：前者的冒烟桩把 `webServer` 只挂在
`ctx.inject` 上（不是宿主真实形状），后者的失败需要「授权成功之后再连接」才会出现。

### 8. 本机即可跑通 OAuth（新增两个脚本）

公网那几台当前都直接返回 200、不要求授权；内网明文 `http://` 又过不了 SDK 的 TLS 检查
（只豁免回环地址）。所以新增：

- `scripts/oauth-mock-server.mjs`（`npm run oauth:mock`）—— 一个**真的会 401** 的 mock MCP
  服务器，实现 PRM / AS 元数据 / DCR / PKCE 授权 / 令牌 / refresh，挂在 127.0.0.1。
- `scripts/oauth-e2e.mjs`（`npm run oauth:e2e`）—— 用**真 SDK + 真 HTTP** 跑完整条链路：
  401 → 发现 → DCR → PKCE → 换令牌 → 带 Bearer 连上 → 调用工具。

回环地址是协议层面允许的明文 OAuth 路径（RFC 8252 §7.3，SDK 的 `isLoopbackHost` 明确豁免），
所以这条验证不受内网 TLS 限制影响。没有 mock 在跑时**跳过并说明原因**。

### 9. 内网明文 token 端点（默认关闭的例外）

SDK 的 `assertSecureTokenEndpoint` 无条件拒绝向非 https 的 token 端点发凭据，只豁免回环
地址。内网部署的授权服务器（如没配证书的 MCPHub）正好落在这条线外，于是 OAuth 在换令牌
那一步必然失败。

新增**每服务器单独、默认关闭**的 `allowInsecureTokenEndpoint`（面板里是「允许明文 token
端点」勾选框）。开启后：

- 只有这一台服务器的 token 交换与刷新走 `src/mcp/oauth/insecure.js`（RFC 6749 §4.1.3
  的一个表单 POST）；
- **SDK 一行不改** —— 所有 HTTPS 服务器继续走 SDK 的完整编排。不 patch SDK 是刻意的：
  patch 一个没有公开扩展点的私有实现，升级就会坏，而且坏得静默；
- 每次明文请求都记一条 warning，写着端点地址 —— 那是用户日后唯一能查到自己开过什么的证据。

它不放宽 SSRF 保护、不影响发现 / DCR / 授权端点、不改变凭据落盘位置与 0600 权限。
没有这个字段的旧配置读作 `false`（拒绝），且关闭时会**删掉配置键**而不是写 `: false`。

同一问题 MCPHub 自己也用同样思路解决（`allowInsecureTokenEndpoint`，默认 `false`），
见 [MCPHub OAuth 文档](https://docs.mcphub.app/features/oauth#http-token-endpoints-in-private-networks)。

### 10. 持久化部署：`scripts/pack-deploy.mjs`

真机上踩到一次：`npm run deploy` 把 0.5.6 拷进了 profile，但 profile 的 `package.json`
依赖仍指向 **0.5.5 的 tarball**。DSH 重建 profile 时按那份依赖重装，覆盖了拷贝进去的目录 ——
跑起来的其实是 0.5.5，于是 `/oauth` 与 `/oauth/callback` 全是 404，而 `package.json` 说
0.5.5，一切看起来都正常。症状是「新功能完全不存在，也没有任何报错」。

`deploy.mjs` 只做文件拷贝，这在设计上就不够：**profile 的依赖指向才是真相**。
新增 `scripts/pack-deploy.mjs`：

1. `npm pack` 出当前版本的 tarball（会跑 `prepare` → build），写进 `~/.dsh/plugin-packages/`
2. 校验 tarball 里真的有 `dist/index.js` / `lib/client.js` / `cordis.patch.yml`
   （否则会「部署成功」但插件不可用）
3. 把 profile 依赖指向新 tarball
4. 顺带跑一次 `deploy.mjs`，让不重建 profile 的情况下也立刻生效

新版本用**新文件名**，不覆盖旧 tarball：回退就是把依赖改回旧那行再重启。

### 11. 表单里的布尔设置改成开关，两行文案不再被挤

两处都来自同一个旧样式 `.smp-inlineCheck { height: 32px }`：

- 布尔设置是 `<input type=checkbox>`，而这张表单里其它布尔控件（卡片上的启用/停用、
  技能启用）都是宿主自己的开关。同一个页面两种表达方式，读起来像两套系统拼出来的。
- **固定 `height: 32px` 是真正的 bug**。这些说明几乎都是整句话，两行 13px/18px 需要 36px，
  于是第二行被压在第一行上、看起来像被裁掉。单行文案下完全正常，所以它一直没被发现 ——
  换行是常态，不是例外。

现在两条都渲染成 `smp-switchRow`：**文字在左、开关固定贴右、两者上下居中**，
标题与后果说明分成上下两行。开关贴右是刻意的 —— 整张表单的布尔设置都应该读成
「这一项叫什么 → 它是哪一档」，位置不再随文字长短左右浮动。删掉了固定高度
（`min-height` 代替），字段内间距 4px → 6px，标签行高 18px → 19px。

两个开关分属不同概念（连接策略 / OAuth 安全），中间加了一条 `.smp-divider` 横线：
没有它时两块文字挨在一起，读起来像一个开关组里的两行，而不是两项各自独立的设置。
横线用 `1px` 而不是卡片边框那种 `.5px` —— 一条在非 retina 屏上会消失的分隔线，
比略重一点更糟，何况它是这里唯一区分两组的东西。

同一个问题还暴露出**展开详情**的对比度问题：`.smp-detailsKey` 和 `.smp-detailsValue`
两级灰（tertiary / secondary），于是「行 id」和它右边那串 id 糊成一片低对比文字，
分不清哪个是标签、哪个是内容。值是**数据**，键只是说明 —— 值改成主色（正文黑），
键保留三级灰。

顺手把开关的渲染收编成一处 `switchControl`：它原本在三个地方各写了一遍（MCP 卡片、
技能卡片、表单），只是标签和回调略有不同。第十三处副本出现时「这是哪个开关」就会变成
每个调用点各自的问题，而且回退分支只有被碰到的那一处会被测到。

还修掉一个被这次改动放大的错标：「连接与重连（留空 = 用 DSH 默认值）」那个字段里现在
只有一个开关，**没有可留空的东西**，而三个重连数字早已预填真实默认值、不再靠留空表达
默认。一条让用户去找输入框的提示、旁边却没有输入框，比不写还糟 —— 改成「连接失败处理」。

测试加了 `test/styles.panel.test.mjs`：钉住「开关行不能有固定高度」「文字列必须
`min-width: 0` 否则长句子撑破对话框」「旧勾选框样式必须删掉（死样式会被人照抄）」。
这些是布局契约，渲染一张截图证明不了换行以后还对 —— 上一版在单行下完全正常，正是这种
假阳性让它活到了用户看见为止。

### 12. 卡片详情去掉重复信息

两处都是「同一件事说了两遍」，而两遍必然漂移：

**删掉「状态」行。** 卡片右侧的开关就是启停状态的唯一真源。再写一行
「已启用 / 已停用」等于同一件事有两个出处 —— 而且它们确实会不一致：开关是**乐观更新**的
（点了立刻变），文字来自投影（下一轮才到），中间那段时间两处说的不是一回事。
MCP 卡片、项目条目、受管技能三处一起去掉（没开关的磁盘技能本来就没有这一行）。
连接状态那块早就遵守这条了（`client.js` 里的注释：「「已停用」本身就由右边的开关表达」）。

**「作用域」不再重复「工作区」三个字。** 键已经写了「作用域」，值再带
`工作区：` 前缀，这一列就读成 `作用域 | 工作区：/p/tcl` —— 同一个词说了两遍，
还把真正要看的路径推向右边。现在全局档只写「全局」，项目档直接给路径。

注意只改**值**：导入卡片的「选工作区」、表单里的「作用域（哪个工作区可用）」
都是**解释性**文案，那里说清「工作区」是必要的，删掉反而更难懂。

### 13. 项目级行的启用开关写错了层级（「点了没反应」）

真机上点了开关没反应，查出来是**两个「启用」概念混在了一起**：

| 层级 | 谁在用 | 项目级行 | 全局行 |
|---|---|---|---|
| entry 的 `disabled` | Loader 是否自己连接 | **必须永远 true** | 就是用户开关 |
| `config.enabled` | 用户界面上那个开关 | 就是用户开关 | 不用 |

项目级行必须永久 `disabled: true`，因为插件自己把它挂进匹配的 agent —— Loader 一旦
也连它，同一个服务器就有两个客户端、两套工具、一个命名空间。所以用户开关只能存在
`config.enabled`。

但 `toggle` 对所有行都写 entry 级 `disabled`，于是：

- **关掉**时写 `true` 覆盖本来就是 `true` 的值 → 没有变化 → 落到「row not found」，
  开关看起来是死的；
- **打开**时清掉 `disabled` → Loader 直接连接了插件也在挂载的行 → 重复连接。

现在按行的 `config.scope` 分层：项目级写 `config.enabled`（关掉写 `false`，打开**删键**，
与从未动过的配置逐字一致），全局行仍写 entry 级 `disabled`。测试两档都钉住，并反向验证
过把分支去掉后断言会失败。

### 14. 授权变成一次点击：菜单入口 → 自动开浏览器 → 自动重连 → 到期前刷新

原来点「授权」只是**拿到一个链接**，剩下的全是人工：复制、切浏览器、粘贴、登录、回面板、
点重连。整个流程里机器能做的部分都留给了人。现在：

| 环节 | 之前 | 现在 |
|---|---|---|
| 入口 | 只在「需要授权」的注记里 | 卡片 `…` 菜单里**始终**有 |
| 打开链接 | 自己复制粘贴 | Host 直接拉起**系统浏览器** |
| 授权完成后 | 回面板点「重连」 | **自动重连**，工具列表跟着刷新 |
| 令牌续期 | 等 401 触发 | **到期前 5 分钟**主动刷新 |

**为什么打开浏览器是 Host 做而不是 `window.open`。** 面板有两种宿主：Web 模式下面板
就跑在用户的浏览器里；桌面模式下它在 Electron 窗口里，`window.open` 开出来的是**另一个
Electron 窗口**，而授权页要求用户已登录中台 —— 登录态在系统浏览器里，开成 Electron
窗口等于让人在新容器里再登录一次。所以由 Host 调系统命令，两种模式行为一致。

Windows 那条命令有个容易错的细节：`cmd /c start "" <url>` 里的空参数是必须的，
`start` 会把第一个带引号的参数当成窗口标题，少了它 URL 被当成标题、浏览器根本不开。

**为什么预刷新不等 401。** 等 401 意味着「下一次请求已经失败」才动手。对 MCP 来说一次
失败不是单个请求的失败：客户端会退避重试，最后把整台服务器标成「已放弃」并把工具全部
下掉 —— 用户看到的是一台「坏了的服务器」，而不是「令牌过期了」。所以在到期前 5 分钟
先换新令牌。预刷新失败**不清旧令牌**：清掉等于让用户立刻失去连接，而重新授权本来也
还要再走一遍。

**为什么入口搬进菜单。** 注记是按当前状态条件渲染的：服务器一旦被判成别的状态、或用户
想换账号重新授权，入口就消失了。菜单是「对这台服务器能做什么」的固定清单，授权属于
那一类 —— 能不能用由服务器类型决定（OAuth 可用 + http 传输），而不是由某一刻的状态决定。
不可用时**不渲染**，理由是同一个：一个点了只会失败的按钮比没有更糟。

### 15. 测试

新增 78 个用例（399 → 454 全绿），四个文件，**都不 import 宿主包**（CI 上没有宿主
`node_modules`，导入宿主包会让测试只在 CI 上炸）：

| 文件 | 覆盖 |
|---|---|
| `test/mcp.oauthState.test.mjs` | `state` 定长比较、长度不等不抛错、多字节按字节比、重复参数拒绝 |
| `test/mcp.oauthStore.test.mjs` | 凭据落盘/权限 0600/坏文件隔离/`tokens()` 无参调用/`expires_in` 换算 |
| `test/mcp.oauthPatch.test.mjs` | 注入生效、lookup 抛错不影响连接、HMR 不叠 wrapper、冻结原型如实失败、`verify()` 能验出「注入了却没进请求头」 |
| `test/mcp.oauthFlow.test.mjs` | 两段式跑通、伪造 state 拒绝、超时、PKCE 跨段存活、**provider 必须单实例共享**、明文端点拒绝/放行两条分支、回调路由只接受 GET、响应体不含令牌 |
| `test/mcp.oauthBrowser.test.mjs` | 只开 http/https（`file:`/`javascript:` 一律拒绝）、三平台命令、Windows 的空参数、不经 shell 重解析、启动器缺失只记 warning 不抛错 |
| `test/mcp.oauthInsecure.test.mjs` | 明文判定与 SDK 的 `isLoopbackHost` 逐字一致、https/回环不误判、每次明文请求必须留 warning、令牌响应收敛（丢掉未知字段）、非 JSON 不谎报成功 |
| `test/styles.panel.test.mjs` | 布局契约：开关行不能有固定高度、文字左/开关贴右/上下居中、文字列 `min-width:0`、旧勾选框样式已删、字段间距 ≥6px、详情值必须用主色 |

每条关键断言都验证过**在修复前会失败**（例如把 `isValidServerName` 的 `.`/`..` 判断去掉、
把补丁的注入点短路掉），而不是只在绿的时候跑过一遍。


## 0.5.5 — 插件身份统一、MCP 配置单源化、行操作改走 HTTP

> **这一版包含破坏性变更。** 升级前后请读 [`docs/MIGRATION-0.5.5.md`](docs/MIGRATION-0.5.5.md)：
> 三项改动都动了「数据存在哪里」，不做迁移的后果分别是面板列表全空、项目级服务器连不上、
> 命令没有响应。**迁移全部自动完成**，但**需要重启一次 DSH**（Host 侧改动无法热加载）。
>
> | 破坏性变更 | 为什么必须动 | 自动迁移 |
> |---|---|---|
> | 插件身份 `skills-mcp-panel` → `dsh-skills-mcp-manager` | 面板靠行 id 找到自己那一行；id 不匹配则**列表全空**，而配置其实完好 | 改行 id + 删除 3 个废弃字段，其余键原样保留 |
> | 项目级 MCP 从 `config.servers[]` 改为带 `scope` 的 profile 行 | 两档曾是两种东西，要合并两个数组才能显示一个列表，且无作用域读注册表**看不到项目级工具**（恒 0） | 逐条转行，字节与手工添加一致；已存在则不覆盖 |
> | 行操作从 settings 队列改为 `POST /<插件名>/rows` | 写 patch 只要 1–5ms，队列通道却让用户等 2–4 秒，且删除的卡片留在屏幕上 | 队列**保留为回退通道**，旧面板/旧 Host 三条路都可用 |
>
> 备份、回退步骤与逐条迁移说明见该文档。

### 迁移要点（详见 docs/MIGRATION-0.5.5.md）

- **顺序**：身份迁移必须早于第一次投影写入，否则新旧两种命名空间的行会同时存在，配置被读两遍。
- **备份**：每次写 profile patch 前自动备份到 `$DSH_HOME/dsh-skills-mcp-manager.backups/`。
  它是**滚动文件**（只留最近一次）且**没有自动恢复路径**，用途是撤销*刚刚那次*操作。
- **旧技能清单**：`skills-mcp-panel.state.json` → `dsh-skills-mcp-manager.state.json`，
  首次读取时导入，且用 `{ flag: 'wx' }` 写入（**绝不覆盖**另一个实例刚创建的文件）。
- **技能落盘根**：条目新增 `id`（`dsh` | `agents`），缺省 `dsh` ⇒ **旧条目语义不变**。
- **旧备份目录 / 旧心跳文件不迁移、不删除**，原地留存，不影响功能。


### 1. 连接与重连默认值改为显式


#### 变更

- **表单预填真实默认值**：`重连首次延迟 / 最大延迟 / 最大次数` 三个输入框打开就是
  `500 / 30000 / 10`，不再是空框配一个「（默认）」占位。以前表单显示"未设置"，而 500 其实
  在生效——那个值住在 `dsh-mcp-client` 里，用户要读别人的源码才知道这一行会怎么重连。
- **落库也写显式默认值**：没填的 `reconnect.*` 现在写成 `{initialDelayMs: 500, maxDelayMs: 30000,
  maxAttempts: 10}`，而不是省略键让客户端补。配置文件长一点，但一眼能看出行为，也不会因为
  上游改了默认值而让"当初没填"的行行为突变。
- **stdio 的「命令」预填 `npx`**（新增表单，以及把传输切成 stdio 时；**只在字段为空时**，
  不会覆盖已填的值或正在编辑的行）。Host 本来就把空命令当 `npx`，现在两端一致。
- `failOnStartupError` 仍只在勾选时写入：`false` 与"键不存在"完全等价，写它只是给每一行加噪音。

#### 实现

- `CONNECTION_DEFAULTS` 是唯一来源：`CONNECTION_DRAFT_DEFAULTS` 由它派生（表单预填），
  `connectionFields` 与 `connectionDraftOf` 都读它，所以表单、磁盘、挂载三条路径说的是同一组数字。
- 客户端直接 `import` `src/mcp/connection.js`（它没有任何 import，可安全进浏览器 bundle），
  而不是在两边各抄一份常量——那样迟早漂移。
- 默认值取自**真实的** `dsh-mcp-client`（`lib/index.js:434-439` `RECONNECT_DEFAULTS`），
  不是照抄注释。

### 2. 技能增删改走 HTTP：新增从约 9 秒降到毫秒级

用户报告「删除很快、新增很慢」。实测**写盘只要 1ms**，延迟全在通道上：技能写入走设置队列，
要连等四个轮询 —— Host 600ms 取请求 + 面板自己的 settings 回读 + Host 2s 对账 + 5s 投影，
最坏合计 **约 9.1 秒**。对照 MCP 走 HTTP 后的 10–30ms，差两个数量级。

**删除只是"看起来"快**：它带乐观墓碑（`removedKeys`）让卡片立刻消失，走的其实是同一个慢通道。
所以修的是通道，不是删除路径。

新增 `POST /<name>/skills`（与 `/<name>/rows` 同一套契约：鉴权在前、只收 POST +
`application/json`、同一 schema 校验、串行执行、失败回执）。两处随之而来的去重：

- **Host 端**：`create/update/rename/delete` 抽成 `applySkillWrite()`，HTTP 与队列**共用一份实现** ——
  两条通道各写一遍必然漂移，而 `serverRows.js` 的两张字段清单已经教过一次这个教训；
- **客户端**：乐观状态变更抽成 `applyOptimisticSkillWrite()`，两个通道产生**完全一致**的界面结果。

新建技能现在**点击即出现卡片**（乐观插入），不再等对账与投影。

`read`（读正文 / 预览）**刻意留在队列**：它是读、已有「正在读取正文…」的即时反馈，
而且不是用户抱怨的痛点 —— 改动越小越安全。路由会明确拒绝 `read`，免得误路由后静默可用。

队列作为回退通道继续排空（旧 Host / 无 webServer / 请求失败三条路都有测试），
所以这一步是优化，不是要求。

### 3. 可配置单次工具调用超时（`toolCallTimeoutMs`）· 来自 PR #1

`dsh-mcp-client` 对单次 `tools/call` 的默认超时是 **60 秒**，而面板此前无从调整它 ——
**任何分钟级的工具调用都会被 60 秒打断**（实测一次 Ghidra「导入 + 全量分析」约 188 秒）。
新增一个顶层字段，沿用既有的「面板扁平字段 → config 片段」管道。

合入时并入本版的「显式默认值」约定：表单预填 `60000`、落库写显式值，与 `reconnect.*` 一致。

> 作者在 PR 里提醒这个值要在 **4 条路径**上都被带上，否则症状很隐蔽：`update` 是逐键写的
> （漏了会「新增能存、编辑存不进去」），`serverRows.js` 有**两张**显式字段清单
> （漏了会「行里有值但读回为空、挂载拿不到」）。合入时逐条实测过这 4 条路径。

### 4. 项目级挂载丢失 env / headers + 项目行状态问错权威源 · 对应 issue #2 / #3

**issue #2：项目级 stdio 行的 `env` 到不了子进程。** 不是宿主的问题，是**形状**不匹配：
`serverRows()` 产出的 `env`/`headers` 已经是解析好的**对象**，而 `mount.js` 对它调
`parseEnv()` —— 后者期望 `KEY=VALUE` 文本行，`String(object)` 是 `"[object Object]"`、
没有 `=`，于是每行都被跳过、返回 `{}`。`JAVA_HOME`、`GHIDRA_INSTALL_DIR` **静默消失**、
没有任何报错；而 0.5.4 的 `config.servers[]` 路径传的是字符串，所以是好的 ——
与报告者观察到的版本差异完全吻合。`headers` 同样中招，后果是 **Authorization 静默丢失**
（一台行里带着凭据的服务器显示「需要授权」）。新增 `envObject()` 同时接受两种形状。

**issue #3：一台工作完全正常的项目行长期显示「已放弃重试」+ `toolCount: 0`。**
`connected` 只在全局档信任 `toolCount > 0`，项目行只能靠 probe；而 probe 问的是 DSH 注册表，
项目行按设计**不注册**进去（`disabled: true` 正是为了让 DSH 不连它），于是必然得到
`unavailable in this agent's scope`，再按重试预算推导成「已放弃重试」。由于本版已让
`readRuntime` **按 agent 自身作用域**读取项目工具，`toolCount` 是真实值，因此 `connected`
对两档一致地信任它：注册表里已有工具就是「服务器正在跟我说话」，比 probe 的推断更直接。

> 报告者的诊断里「`expected` 恒为空」这一层在当前代码已不成立：`readServers()` 读的是
> `loader.entries()`，而 `disabled` 是 entry 的 getter、不是过滤器，所以项目行仍在其中。
> 已在 issue 里说明，避免后续往那个方向排查。

### 5. 技能弹窗与正文读写的五处修复（真机验证后补记）

这一版把技能的写操作搬去 HTTP 之后，连着暴露了四处缺陷。它们的共同点是
**「把声明/定义从一处搬到另一处时，丢了原处的一部分」**，而且症状都不在改动点：

- **弹窗一打开就卡「保存中…」（纯客户端）** —— 弹窗的 pending 是
  `skillNonce !== '' || editBodyPending`，而两个标记**只由匹配的回执清除**。
  一次「编辑 → 正文回执到达前取消」就会把 `editBodyPending` 永久留在 true，
  三个入口（添加 / 编辑 / 取消）没有一个重置它。修法：新增 `resetSkillPending()` 在每个
  入口调用，并给正文读取补 15 秒安全超时（删除流程早有同样护栏）。
- **`Config` 导出丢失 → 技能列表全空** —— 提取共享 schema 时把定义插在了 `export` 与
  `const Config` **之间**，`export` 绑到了下一个声明。宿主靠**读插件导出的 schema** 解析
  命名空间，`Config` 没了 ⇒ 条目不再可配置 ⇒ 每次 `settings.update()` 抛
  `No configurable plugin entry` ⇒ 所有投影写入失败、列表空。而插件看起来完全正常
  （心跳在跳、路由已注册、磁盘 17 个技能都在）—— 只有投影那一环悄悄失败。
- **编辑读不出正文** —— 同一份 `SkillRequest` 丢了 `.volatile()`（宿主只允许写 volatile
  字段）与 `path`（read 请求靠它定位 SKILL.md）。
- **编辑/删除报「未知的写入区域」** —— 上一处修好后又走到另一个极端：`SkillRequest` 被
  同时当作 **Config 字段**与 **HTTP 路由的校验器**，而两者需要不同形态 ——
  **调用一个 volatile schemastery schema 返回 `{}` 而不是校验结果**，于是 `scope`/`id`
  变 undefined、`writableRoots` 匹配不到根。现在拆成 `SkillRequest`（纯 wire schema）与
  `SkillRequestField`（volatile 包装），各自正确。
- **编辑时正文多一行、且每次保存文件都长一点** —— `bodyOf` 只吃掉 frontmatter 结尾的
  一个换行，而 `renderSkillMarkdown` 把那个空行当作格式分隔。读取因此不是写入的逆运算。
  修法：只消费分隔换行（**不能**用 `\s*`，那会吃掉正文的前导缩进，而写入侧是保留缩进的）。

护栏：冒烟新增 `Config` 导出与 schema 元数据断言；新增 `host.configSchema.test.mjs`
（形态不可混用、字段集合完整、走队列的字段必须 volatile）、`skills.route.test.mjs`
（路由必须保留 `scope`/`id`）、`skills.write.test.mjs`（7 种正文形态往返恒等）。
这些断言都实测过**在修复前会失败**。

### 6. MCP 行操作改走 HTTP：新增/删除不再等 2–4 秒


#### 修复

- **新增或删除一台 MCP 服务器后，面板要等 2–4 秒才刷新**，看起来像"必须手动改 yml 才行"。
  这不是写盘慢：`applyRowOp` 写 `cordis.patch.yml` 实测只要 **1–5ms**。等待全在传话链上——
  500ms 排空轮询 + 固定 1200ms 死等 + 写完等 Loader 重载 + 面板自己 700/1500ms 轮询。
  现在命令走 `POST /dsh-skills-mcp-manager/rows`（DSH 官方插件注册路由用的同一个 `webServer` 服务，
  本插件的只读 `/runtime` 也是这么做的），一次请求就落盘并刷新投影。

#### 变更

- **点击立刻看到结果**：删除的卡片在点击瞬间消失，新增的卡片在保存瞬间就以**真实卡片**出现
  （数据取自已提交的表单，不再是「正在写入配置文件…」占位）。真实的投影到达时原地替换。
- **失败可见且会回滚**：Host 拒绝的命令会把乐观状态放回去并显示原因。乐观 UI 只有在失败可见时
  才诚实——否则会给用户看一个配置文件里并不存在的状态。
- settings 的 `rowOps` 队列**保留为回退通道**：旧 Host、没有 webServer 的 profile、或请求失败时
  仍然可用，所以两种 Host 上面板都能工作。

#### 修复（写路径的幂等性）

HTTP 会被重试、也会和周期投影赛跑，所以写路径自己保证安全：

- **`add` 现在是幂等的**：行 id 已存在时**改写那一行**，而不是追加第二行。`insertRow` 原本无条件追加，
  重复的命令会留下两行同 id 的 mcp-client 行，被 Loader 连接两次（两个客户端、两代工具、一个命名空间）。
  这在队列通道下基本碰不到（Host 写 patch 前先清空队列），换 HTTP 后双击/重试就能触发。
- **`delete` 幂等**：行本来就不在时返回成功（目标状态已成立）。以前抛 "not found"，会让用户为一次
  **已经成功**的删除看到一个吓人的失败。
- 命令串行执行，两次点击不会交错成两次 read-modify-write 而丢掉其中一次改动。

#### 安全

写端点比只读端点风险高，因此逐条约束：先过 `connection.requestRejection`（与只读路由同一套信任检查）；
只接受 `POST` 且必须 `content-type: application/json`（跨站 HTML 表单发不出这个类型）；
body 由**同一个 `RowOp` schema** 校验，两个通道不能产生分歧；不返回凭据，失败只回一句原因。

### 7. Skills：去掉项目筛选器、统一标签、四个落盘根


#### 变更

- **Skills 列表跨工作区展示**，工具栏的「项目选择器」删除。它以前会把除当前项目外的所有
  项目级技能都藏起来——刚在别的工作区添加的技能根本不在屏幕上。现在全局在前、然后按工作区
  注册表顺序，与 MCP 完全一致；卡片上的标签说明归属。（MCP 也从没有这个选择器。）
- **卡片标签统一为「全局 / 工作区名」**。以前 skills 按*根名*打标签（`dsh` / `agents`），
  而 MCP 的全局行不打标签——两个页签两套语言，而且「属于哪个工作区」在 skills 那边没被回答。
  哪个根现在写在展开后的「落盘」一行里。
- **新增技能的「区域」显示四个真实绝对路径**：`~/.agents/skills`、`~/.dsh/skills`、
  `<工作区>/.agents/skills`、`<工作区>/.dsh/skills`。DSH 的 provider 四个都读，所以「全局」
  不是一个目录而是两个。选中项目级区域时才出现「工作区」字段（默认当前会话的工作区）——
  用户级根问工作区是个没有效果的字段。

#### 修复

- **写进非默认根的技能会被静默搬走**。`config.skills[]` 的条目以前不记录自己在哪个根，而
  `reconcileSkills` 的 `scopeRoot` 把全局写死成 `~/.dsh/skills`、项目级写死成
  `<root>/.agents/skills`；而 reconcile 每个周期都按配置重写磁盘。于是写到
  `~/.agents/skills` 的文件会在下一轮被删除并在默认根重写，**没有任何报错**——用户会看到
  自己刚建的技能"不见了"或"跑到别的地方"。
  修法：条目增加 `id`（`dsh` | `agents`），`scopeRoot(scope, id)` 按它解析，reconcile 逐条
  使用自己的根。`id` 缺省为 `dsh`，所以旧条目语义不变；编辑条目时若草稿没带 `id`，从原条目
  继承——改文字不该搬动文件。回归测试断言两个根各自只出现自己的文件、重复 reconcile 幂等。
- `upsertSkillByName` 继承落盘根（同上），并补了对应测试。

### 8. Skills 与 MCP 布局统一


#### 变更

- **Skills 页签改用 MCP 的布局**：一份列表，不再有「全局技能 / 项目级技能」两个可折叠
  区块。排序、summary 位置、卡片结构、间距与 MCP 完全一致。
  - **顺序**：全局在前，然后按工作区注册表顺序，注册表之外的作用域按首次出现排在最后；
    组内保持创建顺序。规则抽成两个页签共用的纯函数 `lib/src/components/scopeOrder.js`。
  - **summary** 移到搜索框上方，报「列表里现在有几个」，与 MCP 同一位置同一写法。
  - **「添加技能」移到搜索行**（与「添加服务器」同一个槽位），不再挂在区块标题上。
  - **卡片改为两列**（`.smp-cardRow`）：左列标题 + 作用域标签 + 描述，右列启用开关 +
    `…` 菜单，整行垂直居中。原先三个操作按钮平铺在标题行里，在双行卡片上会偏上。
  - **操作收进 `…` 菜单**（预览 / 编辑 / 删除），与 MCP 行一致。

#### 修复

- **编辑受管技能会静默丢改动**。受管条目（在 `config.skills[]` 里）此前走的是「只写磁盘」
  的对话框，而 Host 每个周期都会按配置条目重写磁盘（`src/skills/reconcile.js`）——
  用户改完几秒后文件被改回去，且没有任何报错。受管条目改为**原地编辑**（卡片变成表单，
  保存写配置条目），磁盘发现（不在配置里）的条目才走对话框，与 MCP 行的编辑方式一致。
  回归测试断言保存后 `config.skills[]` 确实变化。
- **编辑已停用的技能会把它悄悄改回启用**。`skillEntryOf` 把缺失的 `enabled` 当作启用，
  所以原地编辑的草稿必须带上原状态。已补测试。
- **空态文案以空格开头**。`emptySkillText('')` / `emptyMcpText('')` 在无标签时生成
  `" 还没有项目级技能。"`，读起来像渲染坏了；无标签现在是独立的一句。

#### 移除

- `lib/src/components/group.jsx`（分组标题行 + 副标题）与其测试：两个页签都不再有分区标题。
- `globalMcpSubtitle` / `projectMcpSubtitle` / `globalSkillSubtitle` / `projectSkillSubtitle`
  四个副标题函数：数字现在由 summary 行统一给出。

### 9. 插件标识统一


- Host 行 id、settings 命名空间、运行时接口、日志及诊断文件统一使用 `dsh-skills-mcp-manager`。
- 启动时迁移旧配置行，保留连接参数、技能和过滤规则；首次读取时导入旧技能归属清单，之后以新清单为准。
- 旧标识仅保留在数据迁移常量及对应测试中。

### 10. MCP 运行时数据脱离 YAML


- 工具清单、描述和连接状态改从只读 `GET /dsh-skills-mcp-manager/runtime` 获取，沿用 Host 连接鉴权，禁用响应缓存；移除三个运行时字段的配置 schema 和 settings 发布。
- 面板在 MCP 页签打开、卡片展开、页面恢复可见时读取，可见期间每 5 秒刷新。读取失败展示原因并清除过期状态；不回退到旧 YAML 清单。
- 启动时通过配置文件锁、备份和原子写删除旧 `serverTools`、`serverToolsError`、`serverStatus`，保留连接参数、过滤规则及其他配置。
- 投影去重排除扫描时间戳，连接倒计时也不再进入 settings，避免仅运行时变化造成周期性写盘。

### 11. MCP 卡片改版：状态圆点、作用域跟随、开关 + 操作菜单


#### 修复

- **新增的 MCP 会窜到列表第一位**。`serverRows` 用 `localeCompare` **按名字排序**，
  所以后加的 `chrome-devtools` 因为 "c" 排到了 `context7` 前面 —— 读起来像「它把我的
  第一台服务器顶掉了」。改为**保持 patch 的插入顺序**（`serverRows.js`），因为面板是
  这些行唯一的创建入口，顺序就该是用户创建它们的顺序。回归测试断言了前提
  `'chrome-devtools'.localeCompare('context7') < 0`，避免靠巧合通过。
- **每台服务器被发布两条连接状态**（0.5.9 重构的遗留）。重构把项目级也改成
  `mcp-client` 行之后，`readServers()` 同时返回两档，而 `computeServerStatus` 仍按
  旧假设「rows = 全局、entries = 项目」拼装，于是每台服务器都同时发一条
  `tier: 'global'` 和一条 `tier: 'project'`。面板按 tier + scope 匹配，项目行因此会
  拿到那条不存在的全局状态。改为按每行**自己的 `scope`** 分档。
  原先的冒烟夹具只有全局行，所以这个 bug 对 298 个测试完全不可见 —— 已补项目级夹具。

#### 变更

- 🔵 **状态改为「小圆点 + 小号文字」（10px）**，替代原来的药丸标签。药丸的视觉重量与
  卡片自己的标签一样重，于是「一切正常」看起来也像个警告。四档颜色覆盖全部状态：

  | 状态 | 圆点 | 文字 |
  |---|---|---|
  | 已连接 | 🟢 | 可用 · N 个工具 |
  | 首次连接 / 断线重试 | 🟡 | 连接中 · 约 Ns |
  | 已放弃重试 | 🔴 | 已放弃重试 |
  | 激活失败 | 🔴 | **异常** |
  | 需要授权 | 🟡 | 需要授权 |
  | 未挂载 / 状态未知 / 已关闭 | ⚪ | 未挂载 / 状态未知 |

  「连接中」合并了 `pending` 与 `retrying` —— 对用户是同一件事（还在连），两档都不需要
  他动手。黄与红的分界是「会不会自己好」：红只留给不会自愈的。
- **去掉「配置文件」tag**；作用域 tag 移到服务器名旁边 —— 它描述的是「这台服务器是谁的」，
  与右边的运行状态（连没连上）是两件事。全局行不标，因为「没有作用域」就是全局。
- **卡片操作区改为「小号开关 + `…` 竖向菜单」**。三个按钮并排时操作区比它所属的名字还宽，
  两列网格下会把服务器名挤出视野。开关同时表达「现在是哪一档」，一列卡片扫下来能直接看出
  哪些开着；重连/编辑/删除 收进菜单。停用的行不显示操作组；重连只在**启用且异常**时出现。
  菜单点遮罩或按 Esc 关闭 —— 菜单不该在一次无关点击后还开着。
- 重连的可用状态改用**白名单**而非黑名单。改写成黑名单时漏掉了 `needs-auth`，于是
  「需要授权」的服务器又冒出了重连按钮（重连治不了缺授权）。白名单漏一个只是**少给**一个
  按钮，黑名单漏一个会**多给**一个无效按钮 —— 后者更糟，方向必须选对。

#### 测试

- 新增 `openMenu()` 测试助手：操作项都在 popup 里，各用例不该各写一遍位置式查找。
- 受影响用例更新 9 个（按钮进菜单、文案改名、停用标签改开关），新增 2 个
  （开关点击写 toggle 行操作、新增服务器排在最后）。
- `npm run gate` 全绿：**300 通过 / 0 失败** + 真实 Host 装配冒烟通过。

### 12. 「需要授权」：OAuth 拒绝不是故障


**这一版修的是同一类谎言的另一种形态**：前面的状态标签让「悄悄失效」看得见，但受 OAuth 保护
的服务器被拒绝连接时，标签会说「已放弃重试」——把「你去补一次授权就好」说成了「这台服务器
坏了」。

根因是 `@deepseek-ai/dsh-mcp-client` **完全没有 OAuth 支持**：整份实现里没有任何
`authProvider`／`oauth` 字样，`createTransport` 只把 `requestInit.headers` 交给 SDK。于是
SDK 的 401 分支（`if (response.status === 401 && this._authProvider)`）永远不成立，直接落到
`throw new UnauthorizedError()`，客户端随后按普通网络故障重试、预算耗尽后永久放弃。受保护的
服务器拒绝未授权连接是**协议规定的正常行为**，不是故障。

#### 新增

- 🔐 **`需要授权` 状态**（`needs-auth`）。用一次轻量 HTTP 探测读响应里的鉴权挑战：

  | 观测到的响应 | 判定 |
  |---|---|
  | `401`（带或不带 `WWW-Authenticate: Bearer`） | 需要授权 |
  | `403` + `error="insufficient_scope"` | 已授权但范围不足（step-up） |
  | 其它一切（404/405/5xx/超时/网络错误/非 Bearer 挑战） | **不下结论**，回落原本的重试推导 |

  挑战里的 `scope` 与 `error_description` 会转述到卡片上。判定方向刻意偏保守：**漏报可以接受，
  误报不行** —— 给一台真故障的服务器贴「需要授权」会让用户去补一个根本不需要的授权。

- **探测为什么自己发 HTTP**：`mcpResources.request()` 在客户端未连接时会在**发出请求前**就抛
  "server is disconnected"，401 根本到不了那一层。所以探测直接发一个合法的 `initialize` POST
  —— 不用 GET/HEAD，因为 Streamable HTTP 端点对它们的回答五花八门（405/404/SSE），会把
  「不支持 GET」误读成「需要授权」。MCP 规定鉴权发生在协议层之前，所以 `initialize` 能稳定
  拿到 401/403。
- **探测节奏与连接探测分开**：真实 HTTP 往返要几秒，而授权需求不会在 tick 之间忽生忽灭 ——
  连接探测保持 12 秒 TTL，鉴权探测 2 分钟。
- 卡片展开后给出**下一步**，而不只是一个标签：说明这不是故障，并指出 DSH 的客户端不带 OAuth，
  只能靠给这一行加 `Authorization` 请求头（或换成带 token 的地址）来补。

#### 设计要点

- **`needs-auth` 不用红色**（用 warn 而非 danger）：红色会让人以为服务器坏了，而这正是这个状态
  要消除的误解。
- **`needs-auth` 不给「重连」按钮**：重连治不了缺授权，给按钮只会教用户反复点一个无效操作。
  它因此**不在** `RECOVERABLE_STATUSES` 里。
- **已连接优先于鉴权挑战**：挑战是缓存观测值，连接状态才是当下事实。反过来的话，一台已经连上
  的服务器会因为几分钟前的一次 401 被标成需要授权，用户会去补一个已经生效的授权。
- **`expected` 仍然优先**：项目级条目在没有对应会话时压根没挂载，此时谈授权没有意义。

#### 测试

- `test/mcp.auth.test.mjs`（6 项）：`WWW-Authenticate` 解析逐字对齐 SDK
  （含 `error` 与 `error_description` 的前缀易混、引号可有可无、scheme 大小写不敏感），
  以及 `insufficient_scope` 是**下划线**的协议取值。
- `test/mcp.authprobe.test.mjs`（10 项）：只探该探的（stdio／坏 URL／非 http(s) 一概不发请求）、
  网络错误收敛成 null 而不抛错、header 解析，以及**大小写不敏感的头合并**
  （`Accept` 与 `accept` 同时发出会让结果取决于迭代顺序）。
- `test/mcp.status.test.mjs`（+5 项）、`test/client.statusTag.test.mjs`（+4 项）：优先级与 UI。
- `scripts/host-smoke.mjs`：新增一行 401 夹具，在真实 Host 装配下验证「需要授权」，
  并断言用 POST 探测、说明里含「不是故障」。

#### 文档（本轮只提交代码，不发布）

- 新增 [`docs/tools-persistence.md`](docs/tools-persistence.md)：工具清单为什么不该落盘。
  实测 `serverTools` 占 patch 全文 **34.6%**（3179/9176 字节），并**实测确认** patch
  文件每 5 秒被重写一次 —— 根因不是它，而是 `discoveryInfo.at` 每次 scan 都变、
  让 `publish` 的去重 key 永久失效（即那个去重机制目前是坏的）。给出三条路线，
  推荐走 `webServer` 路由（DSH 官方插件同款，无私有 API 依赖）。
- 新增 [`docs/oauth-feasibility.md`](docs/oauth-feasibility.md)：点击授权的可行性
  （**调研，未决策**）。含独立复核发现的三个前置问题，其中最关键的一条是**插件目前
  根本 import 不到 MCP SDK**（未声明依赖 + 真实 profile 里没有
  `@modelcontextprotocol` + DSH 只路由 `@deepseek-ai/dsh-*`）。
- 修正 `docs/ENGINEERING.md` 里过期的仓库名与安装步骤（移除过期名称），
  并删掉 `scripts/deploy.mjs` 里一个从未存在于本仓库历史的 `.scaffold-panel` 过滤项。
- `docs/PUBLISHING.md` 补上使用当前 scoped npm 包名的依据。

## 0.5.4 — 连接状态标签 + 一键重连（含 0.6.x 撤回后的修复）

> **版本说明**：这一版的功能曾以 `0.6.0` / `0.6.1` 发布过，但两个版本都带着缺陷 ——
> `0.6.0` 会误报「激活失败」，`0.6.1` 的观测机制在真机上**从未捕获到任何实例**。
> 两者都已从 npm 撤回，0.5.4 是合并修复后的正式版本，功能与其他修复一并包含在内。

**这一版修的是一个会让人白折腾很久的问题**：如果 DSH 启动时某个 MCP 连不上，它**再也不会
恢复**——哪怕服务器随后正常了，工具也不会回来，而面板上什么都没有。实测一个 `deepwiki`
就这样静默失效了 15 分钟以上（同时服务端一直健康，`HTTP 200` 且能返回完整工具列表）。

根因在 `@deepseek-ai/dsh-mcp-client`（DSH 的依赖，本插件不改它），有两条不同路径：

- **勾了「连不上时拒绝激活」= 一次都不重试**。`apply` 只 await **第一次**尝试的
  `connection.ready`，失败即抛错 → 插件实例失败 → 清理时 `dispose()` 把重试定时器
  `clearTimeout` 掉，重试循环连同实例一起消失。
- **没勾，但重试预算用完就永久放弃**。默认 `maxAttempts: 10`、`initialDelayMs: 500`，
  退避 500→1000→…→30000，**总共只等 151.5 秒**（用户那三条项目级条目
  `initialDelayMs: 1000`，预算是 181 秒）；之后日志是 *"giving up after 10 consecutive
  failed reconnect attempts — reload the plugin or restart the Host to reconnect"*，彻底停止。

两种情况都终结于「只能重启」，而**状态在界面上完全不可见**。

### 新增

- 🚦 **每张 MCP 卡片带连接状态标签**

  | 标签 | 含义 |
  |---|---|
  | `已连接 · N 个工具` | 正常 |
  | `未连接 · 重试中 · 预计剩 Ns` | 还在预算内，会自己恢复 |
  | `已放弃重试` | 预算已用完，**不会**自己恢复 |
  | `激活失败` | 权威信号（Loader / 挂载 fiber）说这个实例失败了 |
  | `需要授权` | 服务器要求先 OAuth 授权（401/403 挑战）—— **不是故障**，见上一条未发布说明 |
  | `连接中` | 首次连接仍在进行（客户端最久等到 `toolCallTimeoutMs`，默认 60 秒） |
  | `未挂载` | 该项目当前没有会话 —— 不是故障 |
  | `状态未知` | 观测机制不可用 —— 如实说明，而不是假装正常 |
  | `已停用` | 用户停用（此时不再显示连接状态，避免留一个过期的「已连接」） |

- 🔁 **一键「重连」**（只在需要它的状态上出现）：全局行让 Loader 重建该行（停用→启用），
  项目级条目失效挂载 key 重挂。两条路都**不需要重启 DSH** —— `dsh-hmr` 用 chokidar
  精确监听 profile 的 patch 文件，写入即时生效。两次写入刻意**跨 tick 分开**并在中间等
  Loader 确认，因为写入后立刻改回可能被合并成「无变化」而根本不触发重载。

### 修复（这正是撤回 0.6.x 的原因）

- **观测机制从未捕获到任何实例**（真机发现）。原做法是劫持 `mcpResources.register` 来
  记录每个实例的连接句柄，但 profile 重新组装时会换成**新的服务实例**，一次性写下的影子
  留在旧实例上，之后所有注册都从旁边走过去 —— 而它仍然报告自己「已装上」，面板因此显示得
  像是一切正常。现在改为调用服务**公开的** `request(server, request, exec)`：它内部按调用者
  scope 解析 provider，每次探测都重新解析，不受实例更替影响，也不再需要劫持任何东西。
  这个改动同时带来了第三种状态 ——「没有 provider」（挂载/激活问题），它与「连不上」
  （网络问题）的处置完全不同，不能混为一谈。
- **误报「激活失败」**。原做法从「观测不到实例」反推激活失败，而注册回调要等 fiber 变成
  ACTIVE 才执行；fiber 在 `apply` 里 await 首次连接期间一直是 LOADING（最久 60 秒），于是
  「还没连完」被当成了「已经失败」。现在「激活失败」只由权威的 `phase === 'failed'` 判定；
  `loading`/`pending` 一律显示 `连接中`；`phase` 为 `active` 时跳过监听判据，按预算给
  「重试中 / 已放弃」，绝不升级成告警。
  **告警误报比没有告警更糟**：用户会去修一个根本没坏的东西。
- **`phase` 一直是个死字段**。原先读 `entry.fiberPhase`，但那是
  `dsh-host-plugin-inventory` **另外算出来的派生字段**，原始 Loader entry 上只有
  `entry.fiber` —— 于是行状态永远是空串，面板无法区分「连上了但没工具」和「压根没加载
  起来」。现在按官方 `FiberState` 映射从 `entry.fiber.state` 推出（项目级条目则用本插件
  挂载时保留的 fiber）。

### 诚实的边界

「重试中 / 已放弃」是按该行配置算出的预算与已耗时**推导**的，不是客户端上报的
（`failedAttempts` 在闭包里，没有任何导出；`connection.ready` 又只代表第一次尝试），
所以界面一律写「预计」。另外新发布 `probeState`（观测机制自身的状态与逐服务器的探测回答），
面板在观测不可用时显示「状态未知」—— 与 0.5.3 的 `filterState` 同理：**「看不见」和
「一切正常」长得一样，是这类告警最坏的失败方式**。

### 想让它以后自己等，而不是靠你点

| 字段 | 建议 | 原因 |
|---|---|---|
| 重连最大次数 | `10000` | 默认 10 次 ≈ 151.5 秒就放弃 |
| 重连最大延迟 | `60000` | 之后持续每 30–60 秒重试，服务器一回来就自动连上 |
| 连不上时拒绝激活 | **不勾** | 勾上等于**一次都不重试** |

### 验证

- 单测覆盖三种探测回答（连着 / 未连接 / 没有 provider）、「别的错误算连着」、**服务实例
  被替换后必须用新实例**（真机那条 bug 的回归守卫）、以及项目级探测必须带上 agent scope
- 状态推导双向覆盖：`phase: loading` + 超过任何宽限期 ⇒ `pending`（不是 `failed`）；
  `phase: active` + 监听漏掉实例 ⇒ 按预算判定（不是 `failed`）
- Host 冒烟新增两行夹具（一行无 provider、一行有 provider 但连不上），断言分别得到
  `pending`/`failed` 与 `retrying`，并断言 Host 真的通过公开 `request()` 探测
- 顺带修掉冒烟夹具自身的缺陷：mock loader 的 `entries()` 每次调用都新建数组，脚本中途
  修改 fiber 改不到 Host 读的那份，断言会**因错误的原因通过**
- `npm run gate` 退出码 0（254 项测试 253 通过 1 跳过，Host 冒烟通过）


## 0.5.3 — 按服务器筛选工具、工具清单可视化、备份只留一个文件

- **备份改成只留一个滚动文件**。以前每次改写 `cordis.patch.yml` 都写一个带时间戳的副本，
  一天下来堆了 **135 个文件、却只有 5 种不同内容**（其中 130 个是逐字节重复，同一份内容
  被备份了 99 次）。备份的用途是**撤销上一次操作**，它只需要保存「当前状态之前的那一份」，
  第 2、第 3、第 100 份同样的字节买不到任何东西。现在固定写在
  `$DSH_HOME/dsh-skills-mcp-manager.backups/cordis.patch.yml.bak`，每次覆盖。

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
- **包名**：本地开发包 → **`dsh-skills-mcp-manager`**（npm / 仓库 / 面板 id 同名）。
  同步改了 `cordis.patch.yml` 的行名、客户端 bundle 的 `__ModuleLoader__.load({ id })`、
  部署目标目录与 `verify-served.mjs` 的匹配串
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
- 当时保留原设置命名空间，避免已有配置丢失；当前版本已统一命名并自动迁移。

## 0.3.2 — README 重写为面向用户的插件说明（含两张面板截图）+ 三处小修

- **README**：从 556 行的开发日志改成用户向的插件说明（亮点 / 界面预览 / 安装 / 使用 /
  工作原理 / 开发与自测 / 诊断与恢复 / 已知边界）；产品名定为 **dsh-skills-mcp-manager**
  （当时仍使用本地开发包，升级需要迁移 profile 配置）
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
- 诊断：心跳文件 `$DSH_HOME/dsh-skills-mcp-manager.heartbeat.json`，patch 写入前自动备份

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
