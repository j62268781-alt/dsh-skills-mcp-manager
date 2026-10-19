# MCP OAuth：点击授权与自动刷新

面向使用者与维护者。设计取舍与逐条实测证据见 [`oauth-feasibility.md`](oauth-feasibility.md)
（那份是调研，本文是实现后的使用说明）。

---

## 1. 它解决什么

MCP 服务器要求授权时，会先拒绝连接（HTTP 401 + Bearer 挑战）。这是协议规定的正常行为，
不是服务器坏了。但 `dsh-mcp-client` 构造 transport 时**只传 `requestInit.headers`**，从不传
`authProvider`：

```js
case "streamable-http": return new StreamableHTTPClientTransport(
  new URL(config.url), { requestInit: { headers: config.headers } });
```

于是 SDK 里那段 `if (response.status === 401 && this._authProvider)` 永远不成立，客户端把 401
当成普通网络故障重试 10 次后**永久放弃**，工具全部注销。面板上看到的只有：

```
未连接 · 重试中 → 已放弃重试
```

——把「你去授权一下就好」说成了「这台服务器坏了」。

0.5.5 及以前，这个插件只能**如实标注**（`needs-auth` 状态）。0.5.6 起它能真正完成授权。

---

## 2. 用户看到什么

受保护的服务器在 MCP 标签页里显示黄色的 **需要授权**，展开卡片后：

| OAuth 可用 | 卡片提供 |
|---|---|
| 是 | **授权** 按钮 → 得到授权链接 → 复制到浏览器 → 登录 → 回调自动完成 |
| 否 | 说明原因 + 手贴 `Authorization` 请求头的建议 |

「否」的情况不会显示按钮。**一个点了永远不会成功的按钮，比没有按钮更糟** —— 它看起来像
用户自己的操作错了。原因由 `oauthState.detail` 给出，逐字显示。

授权完成后如果状态没变，点一次「重连」：客户端在用户去浏览器的那段时间里已经耗尽了重试预算，
只有新实例才会重新连接。这与你之前见过的「重连」按钮是同一个机制。

---

## 2.5 完整流程（一次点击到底）

```
① 卡片 `…` 菜单 → 「授权」
        ↓  Host 发起：发现 PRM → 发现 AS 元数据 → 动态注册 → 生成 PKCE 链接
② Host 用系统命令拉起**外部浏览器**（macOS `open` / Linux `xdg-open` / Windows `start`）
        ↓  你在浏览器里登录中台、点同意
③ 浏览器 302 回到 harness 本地回调 `http://127.0.0.1:<端口>/<插件名>/oauth/callback`
        ↓  校验一次性 state → 换令牌 → 落盘（0600）
④ 自动重连这台服务器，工具列表跟着刷新 —— **不用再回面板点「重连」**
        ↓
⑤ 之后每 60 秒检查一次，令牌在**到期前 5 分钟**自动用 refresh_token 换新
```

几个刻意的选择：

- **授权入口在菜单里，不只在「需要授权」的注记里。** 注记是按当前状态条件渲染的，
  服务器一旦被判成别的状态、或你想换账号重新授权，入口就没了。菜单是「对这台服务器
  能做什么」的固定清单。
- **打不开浏览器不让授权失败。** 链接照样显示在卡片上，可以手动复制；但打开失败的
  原因会回传并显示 —— 「点了没反应」必须能查出为什么。
- **到期前刷新，不等 401。** 等 401 意味着「下一次请求已经失败」才动手：对 MCP 而言
  一次失败不是单个请求的失败，客户端会退避重试、最后把整台服务器标成「已放弃」并把
  工具全部下掉 —— 用户看到的是一台「坏了的服务器」。所以提前换新令牌。
- **预刷新失败不清旧令牌。** 清掉等于让用户立刻失去连接，而重新授权本来也要再走一遍。

## 3. 它是怎么做到的（三个部件）

`authProvider` 只能从**构造参数**进入 transport，而那个构造点在 `dsh-mcp-client` 内部、未导出。
所以唯一可行的接缝是在类上动手：

| 部件 | 文件 | 作用 |
|---|---|---|
| SDK 定位 | `src/mcp/oauth/sdk.js` | 从宿主包的位置反推运行时 `node_modules`，解析出 SDK 的 **ESM** 入口 |
| 原型补丁 | `src/mcp/oauth/patch.js` | 在 `start()` 里给 transport 注入 `_authProvider` / `_oauthProvider` |
| 流程与回调 | `flow.js` / `provider.js` / `callback.js` | 跑授权码 + PKCE，接住浏览器回调 |

### 为什么打在 `start()` 上

`Client.connect(transport)` 必调 `transport.start()`，而 Streamable HTTP 的 `start()` **不发
HTTP**（实测 2.2.0 里只有两行：建 `AbortController`）。真正的首个请求在 `_startOrAuth()` /
`_send()` 里，而它们都会先 `await _commonHeaders()` —— 那里读 `this._authProvider`。
所以在 `start()` 返回前挂上，时效成立。

### 为什么必须命中 ESM 那一份

SDK 是双包（`index.mjs` / `index.cjs`），两个 class 是**不同对象**（实测 `===` 为 false）。
`dsh-mcp-client` 是 `"type": "module"`，走 ESM。补丁打在 CJS 那份上**不报错**，只是永远不生效
—— 表现是「点了授权没反应，日志里什么都没有」。

### 为什么用 SDK 的 `auth()` 而不是自己拼

SDK 导出的 `auth(provider, options)` 已经是一台完整编排机：资源元数据发现（RFC 9728）→
授权服务器元数据发现（RFC 8414）→ 动态客户端注册（RFC 7591）→ resource 指示器（RFC 8707）
→ scope 选择 → PKCE 授权码换令牌 → refresh_token 续期，每一步都按规范处理了「有
discoveryState 就复用」「issuer 不匹配就拒绝」。

自己重写只会**比 SDK 更不完整**。本插件只做 SDK 不做的三件事：两段式（发起/完成）、把
`REDIRECT` 当成正常结果、人话错误。

---

## 4. 安全

### 回调路由为什么**不**做 `requestRejection`

这是本插件唯一一条不检查 DSH 会话的路由，且必须如此：授权服务器把浏览器 302 到
`redirect_uri` 时，**不会带** DSH 的浏览器鉴权 cookie。加上那道检查，唯一结果是每次回调都被
401，授权永远完不成。

安全边界因此完全落在 `state` 上（`src/mcp/oauth/state.js`）：

- **定长比较**（`timingSafeEqual`）—— `===` 会在第一个不同字节提前返回，攻击者能逐字节猜；
- **按 UTF-8 字节比长度**，不是字符数 —— 多字节字符会让 `timingSafeEqual` 抛错，把一次伪造回调
  变成一次 500；
- **一次性** —— 授权完成后立刻清掉 pending，重放落到 `no pending`；
- **10 分钟超时**；
- `state` 与 `code` 必须**各自恰好出现一次** —— 重复参数是绕过「取第一个」的经典手法；
- 只接受 **GET**，且响应带 `cache-control: no-store`（回调整页带着一次性 code）。

### 凭据

- 目录 `0700`、文件 `0600`；`refresh_token` 通常长命，拿到它等于长期冒充该用户；
- 路径：`$DSH_HOME/dsh-skills-mcp-manager/oauth/<serverName>.json`；
- **一台服务器一个文件**：一份坏掉的 JSON 只波及它自己，不会让全部授权一起消失；
- 服务器名会进文件名，所以挡掉路径分隔符、`.`、`..`；
- **令牌从不进投影**：`oauthServers` 只发布「有没有、能否刷新、何时过期、要不要你去点」。
  投影会写进 profile 的 patch 文件，把 access_token 放进去等于把它写盘并可能进日志。

### 补丁的失败可见性

私有字段（`_authProvider`、`_commonHeaders`、`start`）都是打包产物里的实现细节。所以：

1. 打之前检查 `start` / `_commonHeaders` 存在、原型可扩展；
2. 打之后**用真实例验一次** `_commonHeaders()` 真的带上了 `Authorization`；
3. 任何一步不成立 → 面板显示「OAuth 支持未安装 + 原因」，**不显示按钮**。

第 2 步不是形式主义：上面每一步都可能「成功」而最终请求头里没有令牌。

---

## 5. 排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 卡片显示「OAuth 授权在这个 Host 上不可用」+ 原因 | SDK 没解析到 / 补丁没装上 | 看 `oauthState.detail`；升级 DSH 后重试 |
| 点了「授权」提示「这个 Host 版本没有 OAuth 通道」 | Host 侧未生效（404） | **重启一次 DSH**（Host 改动无法热加载） |
| 授权完成后仍显示「需要授权」 | 客户端重试预算已耗尽 | 点一次「重连」 |
| 回调页显示「回调校验失败（state 不匹配）」 | 本轮授权已作废，或回调被伪造 | 重新点「授权」 |
| 回调页显示「这次授权已经超时」 | 超过 10 分钟 | 重新点「授权」 |
| 授权链接在服务器上打不开 | 回环地址只在运行 DSH 的那台机器上有效 | 在 DSH 所在机器上打开 |

诊断信息：

```bash
# OAuth 是否装上（ready / reason / sdkVersion / redirectUri）
cat ~/.dsh/dsh-skills-mcp-manager.heartbeat.json | python3 -m json.tool | head -40
# 凭据文件（确认存在与权限；内容含令牌，不要贴给别人）
ls -l ~/.dsh/dsh-skills-mcp-manager/oauth/
```

---

## 6. 本机验证（不需要浏览器）

内网明文 `http://` 的 MCP 端点过不了 SDK 的 TLS 检查（见下节），而公网那几台当前都直接返回
200、不要求授权 —— 所以「跑通一次 OAuth」需要自己造一个确实会 401 的服务器。回环地址是协议
允许的明文 OAuth 路径（RFC 8252 §7.3，SDK 的 `isLoopbackHost` 也豁免它），因此：

```bash
# 终端 1：一个真的会 401 的 MCP 服务器（自动同意授权，不弹登录页）
npm run oauth:mock

# 终端 2：完整跑一遍协议
npm run oauth:e2e
```

`oauth:e2e` 用的是**真 SDK + 真 HTTP**，串起：
401 挑战 → 资源元数据 → 授权服务器元数据 → 动态注册 → PKCE 授权 → 换令牌 →
transport 自动带上 Bearer → 真的连上 → 真的调用一个工具。

它补的是单测与实机自检都覆盖不到的部分：单元测试用结构等价的假 SDK，证明不了「我们拼的
参数真的被一个授权服务器接受」；`oauth-live-check` 只证明请求头带上了，不跑协议。

**如果要在面板里手动点一遍**：把 `http://127.0.0.1:8791/mcp` 加成一个 streamable-http
服务器（名字随意，例如 `oauth-mock`）。卡片应显示「需要授权」→ 点「授权」→ 复制链接到浏览器
（mock 会自动同意并跳回回调）→ 回到面板点一次「重连」。

## 7. 内网明文 token 端点（默认关闭）

内网部署的授权服务器常常没有 TLS（例如没配证书的 MCPHub）。SDK 会无条件拒绝：

```js
function assertSecureTokenEndpoint(tokenEndpoint) {
  const url = new URL(String(tokenEndpoint));
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname))
    throw new InsecureTokenEndpointError(url.href);
}
```

这是对的：明文 HTTP 上交换令牌，等于把 `access_token` 和长命的 `refresh_token` 广播给
同网段任何能嗅探的设备。

因此本插件提供一个**每服务器单独、默认关闭**的例外：服务器表单里的
**「允许明文 token 端点」**。

开启后会发生什么：

- 只有**这一台**服务器的 token 交换（含刷新）走本插件自己的实现
  （`src/mcp/oauth/insecure.js`，RFC 6749 §4.1.3 的一个表单 POST）；
- **SDK 的代码一行不改** —— 所有 HTTPS 服务器继续走 SDK 的完整编排。不 patch SDK 是
  刻意的：patch 一个没有公开扩展点的私有实现，升级就会坏，而且坏了是静默的；
- **每次明文请求都会在 Host 日志里留一条 warning**，写着端点地址。这是你日后唯一能
  查到自己开过什么的证据。

它**不**做的事：不放宽 SSRF 保护；不影响发现 / DCR / 授权端点（那些仍走 SDK）；
不改变凭据落盘位置或权限（仍是 0600）。

MCPHub 自己也用同样的思路解决同一个问题（它的 `allowInsecureTokenEndpoint`，默认 `false`），
见[它的 OAuth 文档](https://docs.mcphub.app/features/oauth#http-token-endpoints-in-private-networks)。

### 什么时候该用

| 情况 | 怎么做 |
|---|---|
| 授权服务器是 `https://…` | **不要勾**，走 SDK |
| 授权服务器是 `http://127.0.0.1:…`（本机） | **不要勾**，回环地址本来就被豁免 |
| 授权服务器是 `http://内网主机/…` | 只能勾；但更好的方向是给它加 TLS |

## 7.5 端口每次启动都会变，但不用管它

桌面版把 Web 端口写死在启动参数里：

```js
// dsh-desktop-host/lib/index.js
args: ["--no-open", "--host", "127.0.0.1", "--port", "0"]
```

`--port 0` 表示让操作系统随机挑一个空闲端口 —— **没有任何配置文件或环境变量暴露它**。
于是 `redirect_uri` 每次启动都不同，而动态注册得到的 `client_id` 是**绑定 redirect_uri** 的。

理论上可以用 profile patch 按 id 覆盖 `webserver` 那一行来固定端口（bundle 行可以被用户
patch 覆盖，最后写入者胜）：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

**但不建议这么做。** `server.listen` 失败会 reject，端口一旦被别的程序占住，**整个 Web UI
都起不来** —— 为了一个 OAuth 的便利，给日常用的应用埋一个「打不开」的雷，不划算。

本插件改为**自己处理端口变化**：`begin` 之前比对缓存里 client 的 `redirect_uris` 与此刻
的回调地址，不一致就丢掉那份 client，让 SDK 重新注册一次（DCR 本来就是为这种场景设计的）。
代价是一次多出来的注册请求，收益是「重启 DSH 后 OAuth 仍然可用」。

三个刻意的边界：

- **地址一致时绝不重注册**：有些服务器对注册限流、或要求管理员批准，无端重注册会把一条
  本来能用的路径变慢甚至变坏；
- **拿不到当前地址时什么都不清**（Host 还没拿到 `webServer` 时就是这种状态）—— 不知道
  就别动一份可能有效的凭据；
- **只清注册产物和与之绑定的进行中状态**（`clientInformation` / `pending` / `codeVerifier`），
  **令牌不动** —— 它们可能仍然有效，清掉等于让一台本来能用的服务器掉线。

## 8. 已知限制

- **只支持 `streamable-http`**。stdio 没有 HTTP 状态码可挑战，请用环境变量传凭据。
- **不自动打开浏览器**。DSH 官方登录也是「复制登录链接」，而且 Host 侧 `open` 在无头/远程
  会话里会静默失败。
- **动态注册（DCR）是唯一自动化路径**。CIMD（用 HTTPS URL 当 `client_id`）需要公网可访问的
  文档，桌面插件提供不了。只接受预注册客户端的服务器会走到 `invalid_client`，此时只能手填。
- **设备码流程（RFC 8628）不支持** —— SDK 本身没有实现。
- **刷新靠 401 触发**，不做时间预判。猜时间只会让令牌提前失效。
- **不跨机器共享凭据**：回环回调 + 本机文件，这是刻意的。
- **内网明文 `http://` 的授权服务器默认走不通**，需要按上一节显式开启每台服务器的例外。
  SDK 的 `assertSecureTokenEndpoint` 只豁免回环地址（`localhost` / `127.0.0.1` / `::1`）；
  非回环的明文端点在默认配置下会被本插件拒绝，并给出「去打开哪个开关」的说明。
- **只支持动态注册（DCR）或已存在的客户端**。若授权服务器既不支持 DCR、又要求预注册
  `client_id`，目前需要手工把 `clientInformation` 写进凭据文件
  （`$DSH_HOME/dsh-skills-mcp-manager/oauth/<serverName>.json`）；面板还没有输入 `client_id` 的字段。
