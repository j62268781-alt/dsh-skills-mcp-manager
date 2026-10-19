# MCP「点击授权」OAuth 可行性调研

> 状态：**已实现（0.5.6）。** 本文件保留为决策依据与实测记录；使用说明见
> [`oauth.md`](oauth.md)。文末「前置问题」里的两条技术障碍都已在实现中绕过：
> 插件通过宿主包位置反推运行时 `node_modules` 拿到 SDK，且明确加载 **ESM** 入口
> （CJS 那份是另一个 class，补丁打上去会静默失效）。
>
> **两处结论已过时**，实现时重新实测过：
> 1. §4.3 / §5 的「静态 `Authorization` 会覆盖注入的令牌」只对 SDK **2.0.0** 成立。
>    2.2.0 改成先用静态值建 `Headers` 再 `set()` 覆盖，两种大小写都是动态令牌获胜 ——
>    所以注入路线**不需要**先删除行内 `Authorization`。
> 2. §9.1「插件根本 import 不到 SDK」不再是死路：`import.meta.resolve('@deepseek-ai/dsh-mcp-client')`
>    在 Electron 里能给出宿主包的 `file:` URL，从它可以反推出运行时根。
>
> 相关：[`docs/tools-persistence.md`](tools-persistence.md)（工具清单落盘的可行性，
> 那条路不依赖任何 MCP SDK，风险低得多）。
>
> 调研对象（路径以运行中的 profile 为锚，省略机器相关的绝对前缀）：
> - **(A) MCP TS SDK v2.0.0**（已安装）`<profile>/app-nm/node_modules/@modelcontextprotocol/client/dist/index.mjs`（5481 行）、`src-D_zzAWoS.mjs`、`index.cjs`
> - **(B) Pi MCP adapter**（完整交互式实现参考，第三方仓库，需自行 clone：`github.com/nicobailon/pi-mcp-adapter`）
> - **(C) 宿主**：`<profile>/app-nm/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`（835 行，v0.2.0-rc.2）
>
> 标注约定：`file:line`。凡本文未能从源码直接验证的，显式写 **unverified**。所有文件内容仅作数据分析。

---

## 0. 结论摘要（TL;DR）

| 问题 | 答案 |
|---|---|
| 只打开浏览器够吗？ | **不够**。`redirect_uri` 上必须有一个**监听中的 HTTP 服务**接住 `?code=` |
| SDK 支持 `authProvider` 吗？ | **支持**，构造器第二个参数，`index.mjs:4977-4980` |
| DSH 传了吗？ | **没有**，`dsh-mcp-client/lib/index.js:46` 只传 `requestInit.headers` |
| 不改 dsh-mcp-client 能做到吗？ | **能**，但只能靠原型补丁（已实测可行，见 §4.3） |
| 静态 header 方案能长期用吗？ | **不能**，一次性 hack（见 §5） |
| SDK 支持设备码流程吗？ | **完全不支持**，整个包 0 命中（见 §7） |

---

## 1. 规范要求 vs 实现位置

MCP 授权规范（2025-06-18，配合 RFC 9728 / RFC 8414 / RFC 7591 / RFC 7636）的**授权码 + PKCE** 全流程共 8 步。Pi 的 `docs/auth.md:129-135` 把它总结为 7 步：

```
1. Start the callback server lazily on an OS-assigned local port, …
2. Discover OAuth endpoints automatically
3. Use Dynamic Client Registration by default, or the explicitly configured Client ID Metadata Document when supported
4. Open your browser for authentication
5. Wait for the automatic callback
6. Complete the OAuth flow
7. Store tokens securely
```

逐步对应实现：

### ① 受保护资源元数据发现（RFC 9728）

- **SDK**：`discoverOAuthProtectedResourceMetadata()` — `index.mjs:898-912`，拉 `/.well-known/oauth-protected-resource`。
  - 404 时明确抛错：`index.mjs:905` `` `Resource server does not implement OAuth 2.0 Protected Resource Metadata.` ``
  - 其他非 2xx：`index.mjs:909` `` `HTTP ${response.status} trying to load well-known OAuth protected resource metadata.` ``
- **`resource_metadata` 从哪来**：401 响应的 `WWW-Authenticate` 头 — `extractWWWAuthenticateParams()` `index.mjs:836`，正则 `index.mjs:883`
  ```js
  const match = /resource_metadata="([^"]*)"/.exec(authenticateHeader);
  ```
- **Pi**：`mcp-auth-flow.ts:588` `createOAuthFetch` + 探测；`mcp-oauth-provider.ts:661-679` 持久化 discovery state。

### ② 授权服务器元数据发现（RFC 8414 / OIDC）

- **SDK**：`discoverAuthorizationServerMetadata()` — `index.mjs:1071`；URL 候选由 `buildDiscoveryUrls()` 生成 — `index.mjs:1016-1043`
  ```js
  urlsToTry.push({ url: new URL("/.well-known/oauth-authorization-server", url.origin), type: "oauth" },
                 { url: new URL(`/.well-known/openid-configuration`, url.origin), type: "oidc" });
  ```
  带路径时追加 `/.well-known/oauth-authorization-server{path}`、`/.well-known/openid-configuration{path}`、`{path}/.well-known/openid-configuration`（`index.mjs:1032-1041`）。
- **一步到位**：`discoverOAuthServerInfo()` — `index.mjs:1118-1137`，内部先 PRM 再 AS metadata；PRM 缺失时**回落到 MCP server URL 自身**：`index.mjs:1127`
  ```js
  if (!authorizationServerUrl) authorizationServerUrl = String(new URL("/", serverUrl));
  ```
- **issuer 校验**：`index.mjs:1058-1062` 文档说明，不匹配抛 `IssuerMismatchError`；`skipIssuerValidation` 被标注为 **security-weakening**。

### ③ 动态客户端注册（RFC 7591）

- **SDK**：`registerClient()` — `index.mjs:1331-1352`
  ```js
  if (!metadata.registration_endpoint) throw new Error("Incompatible auth server: does not support dynamic client registration");
  ```
  被拒时抛 `RegistrationRejectedError`（`index.mjs:1346-1350`）。
  > ⚠️ `index.mjs:1325-1329`：DCR **已废弃**（协议 2026-07-28 / SEP-2577），改为 Client ID Metadata Documents（SEP-991），「Remains functional during the deprecation window (at least twelve months)」。
- **Pi**：默认走 DCR — `docs/auth.md:10`、`docs/auth.md:20`；注册请求体构造见 `mcp-oauth-provider.ts:380-389`：
  ```ts
  redirect_uris: [redirectUrl],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
  ```

### ④ PKCE `code_verifier` / `code_challenge`

- **SDK**：`startAuthorization()` 内部生成 — `index.mjs:1148-1150`
  ```js
  const challenge = await pkceChallenge();
  const codeVerifier = challenge.code_verifier;
  const codeChallenge = challenge.code_challenge;
  ```
  方法固定 S256 — `index.mjs:443` `const AUTHORIZATION_CODE_CHALLENGE_METHOD = "S256";`
  AS 不支持则抛错 — `index.mjs:1146` `` `Incompatible auth server: does not support code challenge method ${AUTHORIZATION_CODE_CHALLENGE_METHOD}` ``
  写入 URL — `index.mjs:1153-1154`。
- **持久化**：`index.mjs:789` `await provider.saveCodeVerifier(codeVerifier);`
- **Pi**：`mcp-oauth-provider.ts:637-640`（保存，仅存**内存** `flowCodeVerifier`）、`646-655`（读取，缺失时 `No code verifier saved for MCP server: ${this.serverName}`）。

### ⑤ 授权请求（拼 URL）

- **SDK**：`startAuthorization()` — `index.mjs:1141-1164`，一次性写入 `response_type` / `client_id` / `code_challenge` / `code_challenge_method` / **`redirect_uri`** / `state` / `scope` / `resource`：
  ```js
  authorizationUrl.searchParams.set("redirect_uri", String(redirectUrl));   // 1155
  if (state) authorizationUrl.searchParams.set("state", state);             // 1156
  if (scope) authorizationUrl.searchParams.set("scope", scope);             // 1157
  if (resource) authorizationUrl.searchParams.set("resource", resource.href); // 1159
  ```
  `offline_access` 时追加 `prompt=consent`（`index.mjs:1158`）—— 这是**拿到 refresh_token 的关键**。
- **Pi**：不自己拼 URL，走 SDK；`addAuthorizationParams()` `mcp-oauth-provider.ts:157-167` 只追加厂商扩展参数，且**禁止覆盖**流程参数：
  ```ts
  throw new Error(`OAuth authorizationParams.${key} cannot override an authorization flow parameter`)
  ```
  保留名单 `mcp-oauth-provider.ts:146-155`：`client_id, code_challenge, code_challenge_method, redirect_uri, resource, response_type, scope, state`。

### ⑥ 重定向 / 回调 → **本报告核心，见 §2**

- **SDK**：`index.mjs:790` `await provider.redirectToAuthorization(authorizationUrl);` 返回 `"REDIRECT"`（`index.mjs:791`）。
  ⚠️ **SDK 自己不监听任何端口** —— 控制权交回 provider。
- **Pi**：`mcp-oauth-provider.ts:619-632` 仅回调宿主；真正的监听在 `mcp-callback-server.ts`。

### ⑦ 令牌交换

- **SDK**：`exchangeAuthorization()` — `index.mjs:1223-1237`，请求体由 `prepareAuthorizationCodeRequest()` 拼 — `index.mjs:1176-1183`
  ```js
  grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: String(redirectUri)
  ```
  统一入口 `fetchToken()` — `index.mjs:1293-1307`；底层 `executeTokenRequest()` — `index.mjs:1188-1210`。
- **Pi**：走 SDK `auth()`（`mcp-auth-flow.ts:500` 的 `runSdkAuth`）；手动补全入口 `completeAuth`（`mcp-auth-flow.ts:1094`）。

### ⑧ 刷新

- **SDK**：`refreshAuthorization()` — `index.mjs:1250-1265`（`grant_type: "refresh_token"`）。
  **自动刷新在 `authInternal()` 内** — `index.mjs:762-779`：只要 `tokens.refresh_token` 存在就尝试刷新：
  ```js
  if (tokens?.refresh_token && !forceReauthorization) try {
      const newTokens = await refreshAuthorization(authorizationServerUrl, {...});
      await provider.saveTokens({ ...newTokens, issuer }, infoCtx);
      return "AUTHORIZED";
  } catch (error) { ... }   // 776-779: 失败则**静默落到重新授权**
  ```
- **Pi**：`mcp-auth-flow.ts:1131-1207` `getValidToken()`：`1148-1150` 判过期 → `1156-1202` 刷新；刷新失败仅 `console.error` 并 `return null`（`1200-1201`）。

### ⑨ 令牌落盘

- **SDK 不做存储**，全交给 provider。
- **Pi**：OS 凭据库（Windows Credential Manager / macOS Keychain / libsecret）— `docs/auth.md:261`；`expiresAt` 由 `expires_in` 换算 — `mcp-oauth-provider.ts:595`
  ```ts
  ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
  ```

---

## 2. `redirect_uri` / 回调问题：为什么「只打开浏览器」必然失败

### 2.1 协议层面为什么必须有监听者

AS 完成认证后**不会把 code 告诉你**，它只做一次 `302` 到 `redirect_uri`：

```
GET http://127.0.0.1:<port>/callback?code=<授权码>&state=<state>
```

code 只出现在**那个 HTTP 请求**里。没有监听者 → 连接被拒绝（`ERR_CONNECTION_REFUSED`）→ code 只留在浏览器地址栏里，进程永远拿不到。而 §⑦ 的 `exchangeAuthorization` 必须有 `code` 才能换 token（`index.mjs:1179`）。**这就是「打开浏览器」与「完成授权」之间的全部差距。**

### 2.2 Pi 实际怎么做（`mcp-callback-server.ts`）

**默认常量** — `mcp-oauth-provider.ts:92-96`
```ts
// RFC 8252 section 7.3: use the loopback IP literal, not "localhost".
const DEFAULT_OAUTH_CALLBACK_HOST = "127.0.0.1"
const DEFAULT_OAUTH_CALLBACK_PORT = 19876
const DEFAULT_OAUTH_CALLBACK_PATH = "/callback"
```

**端口怎么选** — `mcp-callback-server.ts:364`
```ts
const listenPort = strictPort ? requiredPort : 0
```
- `strictPort = true`：绑**固定端口**（预注册客户端要求 redirect URI 精确匹配）。
- `strictPort = false`：传 `0` 让**操作系统分配空闲端口**（RFC 8252 动态端口），再从 `candidateServer.address()` 读回实际端口 — `mcp-callback-server.ts:380-385`：
  ```ts
  if (!address || typeof address === "string" || typeof address.port !== "number") {
      throw new Error("OAuth callback server did not report an assigned port")
  }
  setOAuthCallbackPort(address.port)
  ```
  这个动态端口随后要**回填进 redirect_uri 与注册元数据** — `mcp-auth-flow.ts:540-542`。

**端口被占（EADDRINUSE）** — `mcp-callback-server.ts:410-415`，**原文引用**：
```ts
if (strictPort && nodeError.code === "EADDRINUSE") {
  throw new Error(
    `OAuth callback port ${requiredPort} is already in use. Pre-registered OAuth clients require an exact redirect URI; set MCP_OAUTH_CALLBACK_PORT to your registered port or free port ${requiredPort}`,
    { cause: error }
  )
}
```
→ **固定端口模式下硬失败，不重试其他端口**（因为 redirect_uri 必须精确匹配）。非严格模式下因为用 `0`，基本不会撞端口。

**超时** — `mcp-callback-server.ts:189-190`，**具体值 5 分钟**：
```ts
/** Timeout for callback completion (5 minutes) */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
```
超时错误 — `mcp-callback-server.ts:437-442`：
```ts
const timeout = setTimeout(() => {
  if (pendingAuths.has(oauthState)) {
    pendingAuths.delete(oauthState)
    reject(new Error("OAuth callback timeout - authorization took too long"))
  }
}, CALLBACK_TIMEOUT_MS)
```

**`state` 校验（CSRF）** — `mcp-callback-server.ts:222-262`，三条原文错误：
```ts
"Missing required state parameter - potential CSRF attack"        // 224
"Invalid or expired state parameter - potential CSRF attack"      // 236 / 258
"No authorization code provided"                                  // 267
```

**AS 返回错误时** — `mcp-callback-server.ts:234-253`：把 `error_description || error` 渲染成失败页，然后 reject。

**绑定与路径** — 只绑回环主机 `mcp-callback-server.ts:372` `candidateServer.listen(listenPort, requestedHost, …)`；非 `/callback` 一律 404（`210-214` `"Not found"`）。

**关闭** — `mcp-callback-server.ts:400` `server.unref()`（不阻塞进程退出）；`464-499` `stopCallbackServer()` 关服务器并 reject 所有 pending；单次流程用 `cancelPendingCallback()`（`451-459`）。

### 2.3 用户在浏览器里看到什么

成功页（自动 2 秒关窗）— `mcp-callback-server.ts:131-141`：
> **Authorization Successful** — "You can close this window and return to *\<app\>*."

手动补全页 — `mcp-callback-server.ts:143-152`：
> **Authorization Received** — "Copy the full callback URL from your browser address bar and paste it back into *\<app\>* with auth-complete."

失败页 — `mcp-callback-server.ts:154-164`：
> **Authorization Failed** — "Something went wrong during authorization. You can close this window and try again from *\<app\>*."

（样式内联、无外部资源，注释见 `mcp-callback-server.ts:20-26`。）

### 2.4 如果**只**开浏览器、没有监听者

1. `startAuthorization()` 正常返回授权 URL（`index.mjs:1141-1164`）—— 这一步确实只需要拼串。
2. 浏览器打开，用户完成登录/同意。
3. AS `302` 到 `http://127.0.0.1:<port>/callback?code=…`
4. **`ERR_CONNECTION_REFUSED`** —— 页面白屏/报错，用户看到「无法访问此网站」。
5. 进程侧：`waitForCallback()` 的 Promise 一直挂着，直到 **5 分钟**后抛 `OAuth callback timeout - authorization took too long`。
6. `code_verifier` 已在 `index.mjs:789` 存下，但**永远等不到 code**，`exchangeAuthorization` 从不执行 → **没有 token**。
7. 用户实际体验：**授权看起来"成功了"（AS 那侧记录已授权），但 DSH 里什么也没发生，5 分钟后超时。**

> 这正是 Pi `docs/auth.md:152` 描述的远程场景：*"The browser may fail to load the loopback callback page because `127.0.0.1` refers to your workstation; copy the full URL from its address bar and paste it into Pi."* —— 连 Pi 都为此准备了「手动粘贴回调整 URL」的兜底（`mcp-auth-flow.ts:1048-1052`、`docs/auth.md:158-172`）。

---

## 3. 是否必须预注册 `client_id`？

**不必须。** 规范允许三种拿 `client_id` 的路径，SDK 全部实现：

| 路径 | 条件 | SDK 位置 | Pi 默认 |
|---|---|---|---|
| 预注册 | 用户显式提供 | provider 直接返回 `clientInformation` | 仅当配置了 `oauth.clientId` |
| **动态注册（DCR）** | AS 支持 `registration_endpoint` | `registerClient()` `index.mjs:1331` | ✅ **默认** — `docs/auth.md:10,20` |
| CIMD（URL 作 client_id） | AS 广告 `client_id_metadata_document_supported: true` | `index.mjs:710-718` | 仅当配置 `clientMetadataUrl` |

SDK 的**决策顺序** — `index.mjs:708-732`：
```js
if (!clientInformation) {
    if (authorizationCode !== void 0) throw new Error("Existing OAuth client information is required when exchanging an authorization code");
    const supportsUrlBasedClientId = metadata?.client_id_metadata_document_supported === true;
    const clientMetadataUrl = provider.clientMetadataUrl;
    if (clientMetadataUrl && !isHttpsUrl(clientMetadataUrl)) throw new OAuthError(...);
    if (supportsUrlBasedClientId && clientMetadataUrl) {
        clientInformation = { client_id: clientMetadataUrl, issuer };   // CIMD
    } else {
        if (!provider.saveClientInformation) throw new Error("OAuth client information must be saveable for dynamic registration");
        clientInformation = { ...await registerClient(...), issuer };   // DCR
    }
}
```

**Pi 的默认行为** — `mcp-oauth-provider.ts:513-514` 注释即结论：
```ts
// No client info or URL changed - will trigger dynamic registration
return undefined
```
预注册分支在 `mcp-oauth-provider.ts:406-432`（配置了 `clientId` 就直接返回，且**secret 只留在 config、不进凭据库**）。

### `clientMetadataUrl` 是什么 + 它的约束

SDK 中它是 provider 的一个**可选属性**（非方法）：`provider.clientMetadataUrl`（`index.mjs:711`）。语义 = 「用这个 **HTTPS URL 本身**当 `client_id`」（SEP-991 / CIMD），AS 自己去拉这个 URL 上的 JSON 文档来获得客户端元数据。

**约束 —— 具体校验错误原文**（`index.mjs:712`，同样逻辑在 `validateClientMetadataUrl()` `index.mjs:806-808`）：
```
clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: ${clientMetadataUrl}
```
判定函数 — `index.mjs:813-821`：
```js
return url.protocol === "https:" && url.pathname !== "/";
```
即**必须是 HTTPS、且路径不能是根 `/`**。错误码 `OAuthErrorCode.InvalidClientMetadata`。

Pi 侧对应校验 `mcp-auth-flow.ts:212-224`：
```ts
if (!clientMetadataUrl) throw new Error("OAuth clientMetadataUrl must not be empty")
validateClientMetadataUrl(clientMetadataUrl)
...
if (config.clientMetadataUrl !== undefined && config.clientSecret !== undefined && !config.clientId)
    throw new Error("OAuth clientSecret requires an explicit clientId when clientMetadataUrl is configured")
```
且 `docs/auth.md:82,234` 强调：**adapter 不提供默认 URL、也不托管该文档**，必须由运营方自己发布并保持 `redirect_uris` 一致。

**结论**：对 DSH 面板这种本地桌面插件，**CIMD 不可行**（需要一个公网 HTTPS 文档），**DCR 是唯一现实的自动化路径**；若 AS 不支持 DCR，就只能让用户手填 `client_id`。Pi 为此专门做了人话错误 — `mcp-auth-flow.ts:447-452`：
```ts
: "This server only accepts pre-registered OAuth clients. If the provider gave you a client ID, set oauth.clientId (and oauth.clientSecret if required) for this server."
```

---

## 4. 【关键】不改 `dsh-mcp-client` 能否做到？

### 4.1 (a) `StreamableHTTPClientTransport` 接受 `authProvider` 吗？—— **接受**

选项处理代码 — `index.mjs:4971-4989`（**原文引用**）：
```js
constructor(url, opts) {
    this._url = url;
    this._resourceMetadataUrl = void 0;
    this._scope = void 0;
    this._requestInit = opts?.requestInit;
    this._skipIssuerMetadataValidation = opts?.skipIssuerMetadataValidation;
    if (isOAuthClientProvider(opts?.authProvider)) {          // 4977
        this._oauthProvider = opts.authProvider;              // 4978
        this._authProvider = adaptOAuthProvider(opts.authProvider, { skipIssuerMetadataValidation: opts.skipIssuerMetadataValidation });  // 4979
    } else this._authProvider = opts?.authProvider;           // 4980
    ...
}
```

类型判定 — `index.mjs:235-239`：只要同时有 `tokens` 和 `clientInformation` 两个函数就算 `OAuthClientProvider`（会被 `adaptOAuthProvider` 包装）；否则当作**极简 `AuthProvider` `{ token }`** 原样使用。

**每请求动态读取令牌**（这是刷新可行的根本原因）— `index.mjs:5034-5050`：
```js
async _commonHeaders() {
    const headers = {};
    let token;
    try { token = await this._authProvider?.token(); } catch (error) { throw markAuthSeamEscape(error); }
    if (token) headers["Authorization"] = `Bearer ${token}`;     // 5042
    ...
    const extraHeaders = normalizeHeaders(this._requestInit?.headers);   // 5045
    return new Headers({ ...headers, ...extraHeaders });                 // 5046-5049
}
```

**401 自动重授权** — `index.mjs:5334-5359`（`_send`）与 `5097-5122`（SSE）：
```js
if (response.status === 401 && this._authProvider) {
    ...
    if (this._authProvider.onUnauthorized && !isAuthRetry) {
        await this._authProvider.onUnauthorized({ response, serverUrl: this._url, fetchFn: this._fetchWithInit });
        await response.text?.().catch(() => {});
        return this._send(message, options, true, stepUpRetries);   // 重试一次
    }
    throw markAuthSeamEscape(new UnauthorizedError());               // 5358
}
```

**手动完成授权**（回调拿不到时的兜底）— `finishAuth()` `index.mjs:5269-5283`。

> ⚠️ **勘误**：任务简报列的导出里包含 `adaptOAuthProvider`，但 **v2.0.0 实际未导出它**。本次实测导出共 **112** 个名字，`index.mjs:5456` 的行尾 export 列表中**没有** `adaptOAuthProvider`；`Object.keys(ns)` 也确认不存在（实测报错 `TypeError: ns.adaptOAuthProvider is not a function`）。`OAuthClientProvider` 同理，**只是类型，不是运行时导出**。
> **好消息**：不需要它 —— 直接塞极简 `AuthProvider`（`{ token: async () => … }`）即可，见 §4.3 实测。

### 4.2 (b) `dsh-mcp-client` 是否把 transport 构造权锁死了？—— **锁死了**

- `createTransport()` 定义 — `dsh-mcp-client/lib/index.js:38-48`，唯一构造点：
  ```js
  case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  ```
- **未导出**：`lib/index.js:835` 唯一导出语句
  ```js
  export { Config, apply, createMcpToolDefinition, inject, name };
  ```
  → `createTransport` **不在其中**（package.json 的 `exports` 也只暴露 `.` 和 `./src/*`）。
- **内部调用点**：`lib/index.js:643` `transport = createTransport(config);` → `644` `await generation.connect(transport);`。构造与连接之间**没有任何 hook**。
- **`apply` 不允许注入 transport**：签名就是 `async function apply(ctx, config)`（`lib/index.js:809`），config 由 Schemastery `Config` 校验（`780-800`），**无任何 auth 字段**：
  ```js
  }), z.object({
      transport: z.const("streamable-http"),
      serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
      url: z.string().required(),
      headers: z.dict(String).default({}),          // 795 —— 唯一的凭据通道，且是静态的
      toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
      failOnStartupError: z.boolean().default(false),
      maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
      reconnect: Reconnect
  })]);
  ```
- **全文 0 命中**：对 `lib/index.js` grep `authProvider|oauth|OAuth|device_code|refresh_token|finishAuth` → **ZERO MATCHES**。（与插件自己的判断一致 —— `src/mcp/auth.js:7-9` 已写明这一点。）
- 失败后的**永久放弃**：`RECONNECT_DEFAULTS` `maxAttempts: 10`（`lib/index.js:434-439`），耗尽后 `573` 记日志「giving up after 10 consecutive failed reconnect attempts」，且 `dispose()` 会清掉重连定时器 —— 只有新 plugin 实例才能重来（插件自己的注释 `src/index.js:1186-1198` 已确认）。

**结论：第三方无法通过公开 API 把 transport 递给 DSH。** 传入 `authProvider` 的唯一机会，是**在 `createTransport` 执行之前，改掉 `StreamableHTTPClientTransport` 这个类本身**。

### 4.3 (c) 最干净的拦截点 —— **原型补丁（已实测可行）**

**可行性实测结果**（Node v24.21.0，直接 import 真实 SDK）：

| 探测项 | 结果 |
|---|---|
| ESM namespace 可写？ | ❌ `Object.isFrozen=false` 但 `isSealed=true, isExtensible=false`；赋值抛 `TypeError: Cannot assign to read only property 'StreamableHTTPClientTransport' of object '[object Module]'`；descriptor `writable:true` 但 `configurable:false` |
| class **prototype** 可写？ | ✅ `Object.isExtensible(T.prototype) === true`，add prop 成功 |
| 无 `authProvider` 时 `_authProvider` | `undefined`，`_oauthProvider` `undefined` |
| 事后直接塞 `_authProvider` | ✅ `_commonHeaders()` 立刻返回 `Bearer TOKEN-A` |
| 令牌轮换 | ✅ 第二次调用返回 `Bearer TOKEN-B-ROTATED`（证明每请求重读） |
| **原型补丁 `T.prototype.start`** | ✅ 新实例无需构造参数，`start()` 时注入成功，`_commonHeaders()` 返回 `Bearer INJECTED-BY-PROTOTYPE-PATCH` |
| 跨 import 路径同一实例？ | ✅ `import "@modelcontextprotocol/client"` 与 `import "file:///D:/…/dist/index.mjs"` 返回**同一** class 对象（Node 按 realpath 缓存）→ 插件打的补丁，DSH 一定看得见 |
| `Client.connect()` 会调 `start()` 吗？ | ✅ `src-D_zzAWoS.mjs:5764` `await this._transport.start();` |

**为什么可行**：`Client.connect(transport)` 必调 `transport.start()`（`src-D_zzAWoS.mjs:5740-5764`），而 `start()` 在 HTTP 发出**之前**。在这个时刻把 `_authProvider` 补上，后续 `_commonHeaders()`（`index.mjs:5038`）就会取到动态令牌。

**具体拦截点**：
```js
// 在面板插件的 apply() 里，且必须早于任何 mcp-client 行构造 transport
import { StreamableHTTPClientTransport as T } from '@modelcontextprotocol/client'
const origStart = T.prototype.start
T.prototype.start = async function patchedStart(...args) {
  if (this._authProvider === undefined && this._oauthProvider === undefined) {
    const provider = tokensFor(this._url)           // 从插件自己的令牌库按 origin 取
    if (provider) this._authProvider = provider      // 极简 { token }；需要 401 重授权再加 onUnauthorized
  }
  return origStart.apply(this, args)
}
```

**加载顺序有利**：面板是 **bundle 层**插件，而 MCP 行在 profile 自己的 patch 里，而 **profile 先组合 bundle patch** —— 插件源码注释已确认这一点（`src/index.js:564-565`：*"this panel is a **bundle-layer** plugin while the MCP rows live in the profile's own patch, and the profile composes bundle patches first, then the profile's patches"*）。所以面板 `apply()` 先跑完，补丁已就位，之后 mcp-client 行才会构造 transport。

**诚实的代价 / 失败模式**：
1. **耦合私有字段** `_authProvider` / `_commonHeaders` / `start` —— 全是 `dist` 里的打包私有实现，SDK 升级可能改名。（缓解：注入前做存在性检查 + 打不上补丁时降级并告警，绝不静默失败。）
2. **HMR 幂等性** —— 插件热重载会重复执行 `apply()`，补丁必须幂等（检查是否已打过标记），否则会叠加多层 wrapper。
3. **卸载不干净** —— 插件 dispose 后补丁仍在（会继续给别的 transport 注入）。要么保留（无害，provider 查不到就跳过），要么在 effect 里还原。
4. **⚠️ 静态 `Authorization` header 会覆盖注入的令牌**（实测）：

   | `requestInit.headers` 的键 | `_commonHeaders()` 最终 `authorization` |
   |---|---|
   | `Authorization: Bearer STALE` | `"Bearer STALE"` ← **静态值赢，令牌被吃掉** |
   | `authorization: Bearer STALE` | `"Bearer FRESH-DYNAMIC, Bearer STALE"` ← **两个值被逗号粘在一起，头损坏** |

   原因：`index.mjs:5046-5049` 的 `{ ...headers, ...extraHeaders }` —— `extraHeaders` 在后。**所以走注入路线时，必须先把行里的 `Authorization` 删干净**（否则连 `_commonHeaders` 都白改）。

**其他候选方案评估**：

| 方案 | 可行性 | 诚实评价 |
|---|---|---|
| 包 `Client.prototype.connect` | 可行 | 能拿到 transport 实例，但 `_authProvider` 已确定；不如直接补 `start()`。多此一举 |
| 补 `globalThis.fetch` | 可行但更脏 | DSH 没传 `fetch`（`createTransport` 只给 `requestInit`），所以 transport 用全局 `fetch`。可按 origin 注入 `Authorization`。**全局副作用**、影响所有网络调用、且要自己解析 body/方法；比原型补丁更难控 |
| 传静态 header | 可行 | 但**一次性**，见 §5 |
| 自己发 HTTP 不走 transport | 可行 | 面板已有 `src/mcp/authprobe.js` 直连 HTTP。**能完成授权拿 token**，但拿到的 token 仍要交给 transport → 回到静态 header 问题 |

---

## 5. 刷新令牌死路：静态 `headers` 能长期用吗？—— **不能**

**场景**：面板在带外（out-of-band）完成 OAuth，把 `Authorization: Bearer <token>` 写进行配置的 `headers`。

**会发生什么**：

1. **配置是静态快照** —— `Config.headers` 是 `z.dict(String)`（`dsh-mcp-client/lib/index.js:795`），在行加载时读一次，构造时原样塞进 `requestInit`（`46`）。**没有过期时间概念、没有刷新钩子。**
2. **令牌过期后**：服务器返回 401 → 但 `_authProvider` 是 `undefined`（因为没传 `authProvider`）→ `index.mjs:5334` 的 `if (response.status === 401 && this._authProvider)` **永远不成立** → 直接落到 `index.mjs:5358` `throw new UnauthorizedError()`。正是插件 `src/mcp/auth.js:10-13` 已记录的现象。
3. **DSH 把它当普通网络故障** → 按 `RECONNECT_DEFAULTS`（`434-439`）重试 → `maxAttempts: 10` 耗尽 → `573` 放弃 → 工具全部注销。用户看到「未连接 · 重试中」→「已放弃重试」。
4. **要恢复只能重写 patch** → `applyRowOp()` `src/patch/apply.js:95-154` 写 `cordis.patch.yml`（`99`），而该文件**被 dsh-hmr 用 chokidar 监听**：
   - `dsh-hmr/lib/index.js:5` `import { watch } from "chokidar";`
   - `:354` `const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];`
   - `:375` `for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false));`
   - 结果：**每次刷新令牌都会触发一次 Loader 重载 → 该 MCP server 断开重连**。
   - 插件源码已记录这个坑：`src/index.js:1195-1196` *"`dsh-hmr` watches the patch file, and a value written and immediately restored can coalesce into 'no change' and never reload at all"*；`1149-1150` 还记录了 *"HMR transactions cannot be nested"*。
   - 也就是说：刷新**每次都要付一次断连代价**，且写入与重载之间存在竞态窗口（可能合并成「无变化」而根本不重载，反而更糟）。

**关于令牌寿命**：SDK 不假设任何具体时长 —— `expires_in` 是可选字段，provider 自行换算（Pi 见 `mcp-oauth-provider.ts:595`）。Pi 把**缺失 `expiresAt` 当作永不过期**（`mcp-auth-flow.ts:1148-1150`：`expiresAt ? expiresAt < now : false`）。业界 AS 默认常见 **3600 秒（1 小时）**，但**这一点在本仓库源码中 unverified** —— 不要把它当作验证过的事实。

**结论**：静态 header 是 **one-shot hack**。它能让「第一次点击授权」看起来成功，但：
- ❌ 无法刷新
- ❌ 无法 401 自动重授权
- ❌ 过期即静默变砖，且症状被误报成「服务器故障」
- ❌ 靠重写 patch 刷新会每次触发 HMR 断连重载，且存在竞态

---

## 6. 最小可行「点击授权」方案（按工作量排序）

### 6.0 【补充】DSH 自己就有浏览器授权先例 —— 本报告的方案 ① 不是新发明

本报告原稿遗漏了一条**最强的可行性证据**，而它就在同一个进程里：

`@deepseek-ai/dsh-deepseek-account-platform` 用**同一个 `webServer` 服务**注册了
`/oauth/callback`，走完整的 PKCE 浏览器授权：

- 路由注册：`dsh-deepseek-account-platform/lib/index.js:970-995`（`kind: "exact"`、`path: "/oauth/callback"`）
- `redirectUri` 就是本机同源地址：`:997` `` `${attempt.origin}/oauth/callback` ``
- PKCE：`:999-1000` 传 `code_challenge` + `code_challenge_method: "S256"`
- `state` 用**定长 `timingSafeEqual`** 校验，并拒绝重复参数：`:983-984`
- 回调把浏览器的等待响应**挂起**（`:992` `attempt.callback = res`），授权完成后再 `302`：`:845`

**交互方式反而比「自动打开浏览器」更简单**，且 DSH 官方登录自己就是这么做的：

| 文案 key | 原文 |
|---|---|
| `loginDescription` | "Sign in to your DeepSeek account…" |
| `copyLink` | "Copy sign-in link" / 「复制登录链接」 |
| `browserDescription` | ", then open it in your browser to finish signing in." / 「，手动打开登录页完成登录。」 |

以上三条见 `dsh-client-ui-settings-account/lib/client.js:2803-2809`。也就是说：DSH 官方登录
**不自动拉起浏览器**，而是「复制链接 → 用户自己粘贴到浏览器」。这消掉了方案 ① 里三个成本项：

1. **不需要** `open(url)` / `xdg-open`（原报告步骤 3）—— 把它做成「复制链接」按钮即可，
   而且与本仓库既有的 `navigator.clipboard` 用法一致。
2. **不需要**自己起 `node:http` 服务器再操心端口占用 —— `ctx.webServer.register()` 挂在
   app 已有的监听端口上，**没有端口冲突问题**（这正是 `mcp-callback-server.ts:410-415` 那条
   报错的来源，而我们绕开了它）。
3. 路由鉴权有现成做法：照 `dsh-host-open-in-app/lib/index.js:1264` 的 `rejected(req, res)`
   调 `connection.requestRejection(req)`。

代价与注意点（必须处理，否则会变成安全洞）：

- `webServer.register` 对**重复 (kind, path) 抛错**（`dsh-host-webserver/lib/index.js:177-180`），
  所以路径要带插件前缀，且 HMR 重载时 disposer 要能重复注册。
- 这条路由**在 app 的监听端口上、对任何能访问该端口的人开放**，因此 `state` 必须用
  `timingSafeEqual` 定长比较 + 一次性（照抄账号平台的做法），且授权完成即卸载路由。
- 该服务需要 `inject: ['webServer']`（本插件当前只 inject 了 `loader`，见 `src/index.js:53`）。

**结论**：方案 ① 的实际成本应从 600-900 行下调（回调和打开浏览器两块几乎白送），但它
**仍然**依赖 §4.3 的原型补丁才能让令牌真正被 transport 用上并自动刷新 —— 那一块才是不可省的部分。

### 方案 ①（推荐）：原型补丁 + 极简 `AuthProvider` + 本地回调服务器 + 自带令牌库

**代码要写什么**
1. **回调服务器**（新增，约 150-200 行）：参考 `mcp-callback-server.ts` 抄骨架 —— `createServer`（`:8`）、绑 `127.0.0.1`（`:372`）、动态端口 `listen(0)`（`:364`）、`state` 校验（`:222-262`）、**5 分钟超时**（`:190`）、成功/失败 HTML 页（`:131-164`）、`unref()` + 关闭（`:400,464-499`）。
2. **发现 + 注册 + PKCE + 换 token**（新增，约 120-200 行）：**直接调 SDK 导出的函数**（全部已确认导出，`index.mjs:5456`）：
   `discoverOAuthServerInfo` → `registerClient` → `startAuthorization` → `exchangeAuthorization`。
   > 若走 `auth()` 全自动编排，需要实现较完整的 `OAuthClientProvider`（见 `mcp-oauth-provider.ts:256` 的 16 个成员：`redirectUrl:350`、`clientMetadata:363`、`clientInformation:396`、`saveClientInformation:520`、`tokens:557`、`saveTokens:587`、`redirectToAuthorization:619`、`saveCodeVerifier:637`、`codeVerifier:646`、`saveDiscoveryState:661`、`discoveryState:666`、`state:695`、`addClientAuthentication:764`、`prepareTokenRequest:808` …），**工作量大得多**。最小路径是手工串 4 个函数。
   > ⚠️ 只手工串的话要自己做 `state` 校验和 `iss`（RFC 9207）处理。
3. **开浏览器**（1 行）：`open(authorizationUrl)`（Pi 同款，`mcp-auth-flow.ts:1072`），或 Node `child_process` 调 `start`/`open`/`xdg-open`。
4. **令牌库**（新增，约 80-150 行）：`{serverName, url, accessToken, refreshToken, expiresAt, clientInfo, issuer}`。Pi 用 OS 凭据库（`docs/auth.md:261`）；最小实现可先用加密文件，**不要在明文里放 refresh_token**。
5. **原型补丁**（约 30-50 行）：见 §4.3。初始只需 `{ token: async () => store.get(url)?.accessToken }`；**再加 `onUnauthorized` 才能 401 自愈**（`index.mjs:5340`）。
6. **清理静态 `Authorization` 行**（必须，否则令牌被覆盖，见 §4.3 实测表）。
7. **UI 按钮 + 状态**（面板侧）。

**要改 `dsh-mcp-client` 吗？** ❌ **不需要**（原型补丁 + 公开 SDK 导出足够）。

**失败模式**
- 私有字段 `_authProvider` / `start` 随 SDK 升级改名 → 补丁失效（**必须**做能力检测 + 明确告警）。
- 面板 HMR 重载导致补丁重复叠加（**必须**幂等）。
- AS 不支持 DCR 且无预注册 client_id → 需引导用户手填（照抄 `mcp-auth-flow.ts:447-452` 的措辞）。
- 固定端口被占 → 照抄 `mcp-callback-server.ts:410-415` 的错误文案。
- 用户 5 分钟内不完成 → 超时（`mcp-callback-server.ts:190`）。
- 行里残留 `Authorization` header → 令牌被静默吃掉。

**工作量估计**：**中大**（约 600-900 行 + 测试）。这是唯一能**长期正确**的方案。

---

### 方案 ②：`client_credentials` / 用户粘贴预签发令牌（**完全不碰浏览器，零改动**）

**代码要写什么**
- 纯 UI + 存储：让用户粘贴一个 PAT / 静态 token，写进行 `headers`（复用现有 `applyRowOp`，`src/patch/apply.js:149-154` 已有 `headersChanged` 分支）。
- 或 `client_credentials`：SDK 有现成 provider —— `ClientCredentialsProvider` `index.mjs:1423-1466`（`prepareTokenRequest` `1461-1465` 直接发 `grant_type=client_credentials`），另有 `PrivateKeyJwtProvider` / `StaticPrivateKeyJwtProvider`。但**这些都需要 `authProvider` 才能生效** → 仍要方案 ① 的原型补丁；除非**只在面板侧用它换 token、再把结果写进 headers**。

**要改 `dsh-mcp-client` 吗？** ❌ **不需要**（纯 headers）。

**失败模式**
- 同样**无法刷新**（见 §5），但这类 token 通常**本来就是长期有效**的 —— 这是它相对方案 ① 的最大优势：把「短命 OAuth 令牌」问题整个绕开。
- `client_credentials` 需要 AS 支持且通常**拿不到 refresh_token**（无用户上下文），令牌过期仍要重新换取 → 又要写 patch → 又要 HMR 重载。
- 安全性：token 落在 `cordis.patch.yml` 明文里。
- 对**只支持授权码流程的 AS（多数 SaaS MCP 服务器）完全无效**。

**工作量估计**：**小**（约 50-150 行，主要是 UI + 复用现有 row-op 管线）。**但对大多数真实 MCP OAuth 服务器不可用。**

---

### 方案 ③：带外完成授权 + 令牌写进 headers（一次性）

**代码要写什么**
- 方案 ① 的第 1-4 步（回调服务器 + 4 个 SDK 函数 + 令牌库），但**不做原型补丁**，改为把拿到的 access token 直接写进行 `headers`。
- 复用现有 `applyRowOp` 写 patch（`src/patch/apply.js:95-154`）。

**要改 `dsh-mcp-client` 吗？** ❌ **不需要**（纯 headers）。

**失败模式**
- **全部 §5 的问题**：无法刷新、401 不重试、过期变砖、刷新需重写 patch 触发 HMR。
- 比方案 ② 更差：付出了完整的 OAuth 实现成本，却只换来一次性效果。

**工作量估计**：**中**（约 400-600 行），**收益最差**。仅适合「先验证流程能通」的原型。

---

### 方案对比

| | ① 原型补丁 + 回调 | ② 预签发令牌 | ③ 带外 + 静态 header |
|---|---|---|---|
| 改 `dsh-mcp-client` | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 |
| 能否刷新 | ✅ 能 | ➖ token 本身长期有效 | ❌ 不能 |
| 401 自愈 | ✅ 能（加 `onUnauthorized`） | ❌ 不能 | ❌ 不能 |
| 浏览器交互 | 有 | **无** | 有 |
| 适用服务器 | 全部 | 少数（PAT/CC） | 全部 |
| 长期可用 | ✅ | ✅（若 token 长期） | ❌ |
| 工作量 | 中大（600-900 行） | **小**（50-150 行） | 中（400-600 行） |

**务实建议**：**先做 ②（成本极低、立刻可用），同时把 ① 作为正式方案推进。** ③ 不建议单独做 —— 它的全部成本都被 ① 包含。

---

## 7. SDK 支持设备码流程（RFC 8628）吗？—— **完全不支持**

**grep 范围：整个包**（`dist/` 下全部 `.mjs/.cjs/.js/.json/.ts/.map`，逐个文件扫），模式：
`device_code|device_authorization|DeviceAuthorization|slow_down|authorization_pending|urn:ietf:params:oauth:grant-type:device`

**结果：0 命中。** 在 `index.mjs` 和 `src-D_zzAWoS.mjs` 中同样 0 命中。

**旁证**：
- `index.mjs:5456` 的导出列表（112 个）中无任何 device 相关名字。
- `authInternal()`（`index.mjs:636-792`）只处理两种结果：`authorizationCode` 存在 / `nonInteractiveFlow = !provider.redirectUrl`（`733`）。**没有轮询分支、没有 `interval`、没有 `slow_down` 处理。**
- 唯一的非交互路径是 `provider.prepareTokenRequest()`（`index.mjs:1301-1306`，`fetchToken`），SDK 里只有 `client_credentials`（`1461`）、`private_key_jwt`（`1533`）、`jwt-bearer`（`1589`）用到它。
- Pi 也**没有**实现设备码（grep `pi-mcp-adapter` 亦无 device 相关实现；其 `grantType` 配置只有两种 —— `mcp-oauth-provider.ts:132`）：
  ```ts
  grantType?: "authorization_code" | "client_credentials"
  ```

**能否绕过？** 理论上可以手工实现（`POST /device_authorization` 拿 `device_code` + `user_code`，展示 `verification_uri`，轮询 `/token`），但：
- SDK **给不了任何帮助** —— 没有轮询器，`fetchToken()` 要求 `prepareTokenRequest()` 返回一次性的 `URLSearchParams`（`index.mjs:1301`），轮询语义要全部自己写。
- 用户仍要在浏览器里输入 `user_code`（只是不需要**本机**监听端口）。
- 对**本地桌面**场景收益很小：方案 ① 的回调服务器在本机是可靠的，设备码主要解决的是「无浏览器 / 远程 SSH」。
- AS 支持度参差（很多 SaaS AS 不提供 device endpoint）。

**结论**：设备码**当前不可用**，且即便手工补齐也**不解决 DSH 的核心问题** —— 核心问题不是「怎么拿到 token」，而是「拿到 token 后怎么让 transport 用上并自动刷新」（§4/§5）。

---

## 8. 最终裁决

### 「是否只需要用调用本地浏览器打开授权 oauth 地址就好了？」

# ❌ **不是。**

打开浏览器是**整条链路的第 5 步（共 8 步）**，而且是最简单的一步 —— `open(authorizationUrl)` 就一行（Pi：`mcp-auth-flow.ts:1072`）。真正的工作量在它前后：

**缺的东西，按重要性排序：**

1. **`redirect_uri` 上必须有一个监听中的 HTTP 服务器**（§2）。这是「打开浏览器」这个心智模型**最致命的漏洞**。授权码只会出现在一次 `302` 的 query string 里；没有监听者 → `ERR_CONNECTION_REFUSED` → 5 分钟后超时（`mcp-callback-server.ts:190,440`），**授权看似成功但进程永远拿不到 token**。
2. **必须有 `client_id`**（§3）。要么动态注册（`registerClient`，`index.mjs:1331`），要么用户预注册手填；CIMD 需要公网 HTTPS 文档（`index.mjs:712`），**本地插件不可行**。
3. **必须生成并保管 PKCE `code_verifier`**（`index.mjs:1148-1150, 789`），并在换 token 时回传（`index.mjs:1180`）。丢了就换不到 token。
4. **必须做 `state` 校验**（CSRF）—— Pi 三条原文错误见 `mcp-callback-server.ts:224,236,258`。
5. **必须落盘 token 并处理过期**（§5）—— 这才是 DSH 真正的死结。
6. **最关键的架构障碍：`dsh-mcp-client` 完全不传 `authProvider`**（`lib/index.js:46`，全文 0 命中 OAuth 字样），所以即使你拿到了 token，它也只能以**静态 header** 形式进去，**无法刷新、401 不自愈**（§5）。

**最小真实实现是什么？**

> **一个本地 `127.0.0.1` 回调服务器（动态端口 `listen(0)` + `state` 校验 + 5 分钟超时）
> + 用 SDK 导出的 `discoverOAuthServerInfo` / `registerClient` / `startAuthorization` / `exchangeAuthorization` 串起流程
> + 一个按 origin 存令牌的小型令牌库
> + 在 `StreamableHTTPClientTransport.prototype.start` 上打一个幂等原型补丁，注入 `{ token, onUnauthorized }`
> + 清理该行残留的静态 `Authorization` header。**

**这个实现不需要修改 `dsh-mcp-client`** —— 但代价是耦合了 SDK 的私有字段 `_authProvider`（及 `start` 的时机），必须做能力检测与降级告警，且在插件 HMR 重载时保持幂等。加载顺序是有利的（面板是 bundle 层，先于 profile 的 MCP 行执行，`src/index.js:564-565`）。

**如果只想尽快可用**：先做**方案 ②**（让用户粘贴预签发令牌写进 headers，50-150 行、零架构风险、token 通常长期有效），把**方案 ①**作为正式路径 —— 它是唯一能长期正确工作的方案。

---

### 附：本次调研的两处事实修正

1. **`adaptOAuthProvider` 在 SDK v2.0.0 中并未导出**（任务简报将其列入导出清单）。实测 112 个导出中无此名，调用抛 `TypeError: ns.adaptOAuthProvider is not a function`。`OAuthClientProvider` 同理，仅为类型。**影响**：不能依赖它把 `OAuthClientProvider` 适配成 `AuthProvider`；直接传极简 `{ token }` 即可（实测有效，且 `index.mjs:235-239` 的类型判定保证它不会被误包装）。
2. **静态 `Authorization` header 会覆盖注入的令牌**（§4.3 实测）：同名同大小写时静态值获胜，大小写不同时两个值被逗号拼接成**损坏的头**（`Bearer A, Bearer B`）。原因是 `index.mjs:5046-5049` 的展开顺序。**影响**：采用注入方案前必须清除行内 `Authorization`，否则整个方案静默失效。

---

## 9. 前置问题（对抗性复核发现，未解决）

> 这一节是**独立复核**（逐条重跑、逐字节核对引用）的结论。方案 ① 在写第一行代码之前
> 必须先回答这三个问题 —— 否则会白写 600-900 行。

### 9.1 ❗ 插件目前**根本 import 不到 SDK**（第一块多米诺）

方案 ① 的第一行是
`import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"`。
**这一行在插件里跑不起来**，实测：

```powershell
# 从插件目录
node -e "console.log(await import.meta.resolve('@modelcontextprotocol/client'))"
# → ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/client'
```

原因有三层，全部核实：

1. 插件 `package.json` **没有 `dependencies` 字段**（只有 `peerDependencies` +
   `devDependencies`）。
2. `@modelcontextprotocol/client` 是 **`dsh-mcp-client` 的依赖**，不是本插件的；
   真实 profile 的 `node_modules` 里**连 `@modelcontextprotocol` 目录都不存在**。
3. DSH 的模块解析路由**只接管 `@deepseek-ai/dsh-*`**
   （`dsh-app-boot/lib/index.js:294`：`if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue`），
   其余一律走 Node 原生解析。

也**不能**通过已声明的 `peerDependencies` 间接拿到：`dsh-mcp-client` 只导出
`{ Config, apply, createMcpToolDefinition, inject, name }`（`lib/index.js:835`），
**不 re-export 任何传输类**（实测 `m.StreamableHTTPClientTransport === undefined`）。

**这意味着**：方案 ① 的前置工作不是"打原型补丁"，而是"先让插件能解析到 SDK"
（声明依赖 + 确保 profile 安装时真的装上，而 DSH profile 的依赖布局由 DSH 决定）。
**这一条不确定，后面全部免谈。**

### 9.2 CJS / ESM 双包风险（这次侥幸没事）

SDK 是双入口（`import` → `index.mjs`，`require` → `index.cjs`），二者是**不同的
class 对象**（`===` 为 false）。原型补丁打在 ESM class 上，任何走 CJS 的加载路径
**看不见这个补丁**。

本次侥幸成立，只因为 `dsh-mcp-client` 是 `"type": "module"`（走 ESM）。但原报告把
"跨 import 路径是同一实例"当作已证事实，**实际只测了 ESM→ESM**。

### 9.3 `finishAuth` 与极简路线互斥

原报告把 `finishAuth` 列为"回调拿不到时的兜底"。实测
`index.mjs:5269`：`if (!this._oauthProvider) throw new UnauthorizedError("finishAuth requires an OAuthClientProvider")`。
而 `_oauthProvider` **只在 `isOAuthClientProvider()` 为真时赋值**（`:4977-4980`），
极简 `{ token }` 路线下**永远是 `undefined`**。所以走极简路线 = 放弃 `finishAuth`。

### 9.4 安全框架不足（原报告只说口号）

原报告说"必须做能力检测 + 降级告警"，但没给出判据、没接到面板状态、没提版本锁。
可用的具体做法（复核者提供）：

- **能力检测**：注入前检查 `typeof T.prototype.start === 'function'` 且
  `T.prototype` 上能读到 `_commonHeaders`；注入后调一次 `_commonHeaders()` 验证
  `Authorization` **真的出现**。
- **接到现有模式**：本仓库已有「装不上就如实说」的惯例
  （`filterState.reason` / `probeState.reason`，见 `src/index.js:600-601`、`:634`）。
  原型补丁失败必须走同一条路 —— 面板要显示"OAuth 支持未安装 + 原因"。
- **版本锁**：SDK 是精确版本 `"@modelcontextprotocol/client": "2.0.0"`。建议插件
  记下已适配版本并运行时校验，而不是只写一句"可能改名"。

**这不是"某个私有字段改个名"级别的脆弱**：它同时耦合 `_authProvider`、
`_commonHeaders`、`start`、`_oauthProvider` 的存在性语义，**外加一个未文档化的内部
时序**（补丁能在第一次 POST 前生效，靠的是 `start()` 本身不发 HTTP、而 era 协商探测
在其之后 —— 原报告把时机理由说反了，结论侥幸仍成立）。

### 9.5 其他修正（引用核对）

逐字核对 12+ 处引用，**绝大多数精确**（含 pi 侧 20+ 处）。需修正的：

| 位置 | 原报告 | 实际 |
|---|---|---|
| 导出行 | `index.mjs:5456` | **`:5480`**（5456 是 `}`） |
| `WWW-Authenticate` 正则 | `index.mjs:883` | 该处在**已废弃**的 `extractResourceMetadataUrl` 里；活代码用 `:866`。语义相同，结论不变 |
| `OAuthClientProvider` 成员数 | "16 个" | class 体约 **19 个**（接口成员约 16） |

另：原报告称 §6 方案 ① 里「开浏览器只需 1 行」—— 那是 pi 用了第三方包 `open`
（`mcp-auth-flow.ts:16`）。**DSH 没有 host 侧开 URL 的能力**（`dsh-host-open-in-app`
只处理文件/应用，`shell-open` verb；能开外链的 `openExternalLink` 在 client 侧，
Host 半拿不到），需自己 spawn `start`/`open`/`xdg-open` 并处理三平台差异。

> **不过**：DSH 官方登录**本来就不自动开浏览器** —— 它给的是「复制登录链接」
> （`dsh-client-ui-settings-account/lib/client.js:2806`、`:2809`：
> `copyLink: "复制登录链接"`、`browserDescription: "，手动打开登录页完成登录。"`）。
> 所以照抄这个交互反而更省事，见 §6.0。

### 9.6 关于方案 ② 的适用性（建议顺序的理由要换）

原报告把「先做 ②」的理由说成"成本极低、立刻可用"。更诚实的理由：

- ② 的**真正价值不是"快"，而是它不需要原型补丁**（纯静态 headers，走已有的
  `applyRowOp` 管线，零架构风险）。
- 但 ② **只在目标服务器支持 PAT / `client_credentials` 时才有用** —— 多数 SaaS
  只支持授权码流程。所以 ② 不是"必然可用的小步"，而是"**取决于你的服务器**"。

**因此正确的第一步不是写代码，而是先查清目标服务器支持哪种授权**：
支持 PAT → ② 收工，① 根本不用做；不支持 → ② 毫无价值，直接面对 ① 的成本与风险，
**或者干脆不做**（维持现在的「需要授权」如实标注 + 手动加 header）。
