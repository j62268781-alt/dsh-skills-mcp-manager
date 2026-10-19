/**
 * transport 原型补丁：把 `AuthProvider` 塞进 `StreamableHTTPClientTransport`。
 *
 * ## 为什么非得打补丁
 *
 * `dsh-mcp-client` 的 `createTransport()` 是模块内私有函数（未导出），构造 transport 时
 * 只传了 `requestInit: { headers }`，**没有任何 auth 字段**：
 *
 * ```js
 * case "streamable-http": return new StreamableHTTPClientTransport(
 *   new URL(config.url), { requestInit: { headers: config.headers } });
 * ```
 *
 * 而 `authProvider` 只能从**构造参数**进入。所以第三方唯一能插手的位置，是在
 * `createTransport` 执行之前或者之后改「这个类」或「这个实例」。
 *
 * ## 为什么打在 `start()` 上
 *
 * `Client.connect(transport)` 必调 `transport.start()`，而 Streamable HTTP 的
 * `start()` 只建 `AbortController`，**不发 HTTP**（实测 2.2.0：`start()` 里只有两行）。
 * 真正的首个请求在 `_startOrAuth()` / `_send()` 里，而它们都会先 `await _commonHeaders()`
 * —— 那里读 `this._authProvider`。所以在 `start()` 返回前把 provider 挂上，时效是成立的。
 *
 * ## 为什么必须命中 ESM 那一份 class
 *
 * SDK 是双包，`import "…/index.mjs"` 与 `require("…")`（→ `index.cjs`）拿到的是
 * **两个不同的 class 对象**（实测 `===` 为 false）。`dsh-mcp-client` 是 `"type": "module"`，
 * 走 ESM。补丁打在 CJS 那份上不会报错 —— 它只是永远不生效，表现是「点了授权没反应，
 * 日志里什么都没有」。`sdk.js` 已经保证只返回 ESM 入口。
 *
 * ## 能力检测与降级
 *
 * 私有字段（`_authProvider`、`_commonHeaders`、`_startOrAuth`）都是打包产物里的实现细节，
 * 版本升级可能改名。所以：
 *   · 打之前检查 `start` 存在、实例上 `_authProvider` 是可写自有属性；
 *   · 打之后**用真实例验一次** `_commonHeaders()` 真的带上了 `Authorization`；
 *   · 任何一步不成立就返回原因，面板显示「OAuth 支持未安装 + 原因」。
 * 静默失败是这类补丁最坏的结局：用户看到一个按钮，点它永远不会成功。
 */

/** 补丁状态的进程级标记。用 `Symbol.for` 是为了 HMR 重载后仍能找到上一次的补丁。 */
const PATCH_KEY = Symbol.for('dsh-skills-mcp-panel.oauth.transportPatch')

/** 注入到 transport 上的 provider 用同一个标记，避免反复覆盖。 */
const INJECTED_KEY = Symbol.for('dsh-skills-mcp-panel.oauth.injected')

/** 补丁安装失败的原因取值。 */
export const PATCH_REASONS = Object.freeze({
  noTransportClass: 'no-transport-class',
  noStart: 'transport-start-missing',
  notExtensible: 'transport-prototype-not-extensible',
  noCommonHeaders: 'transport-common-headers-missing',
  injectFailed: 'auth-provider-injection-failed',
})

/**
 * 判断某个 transport 实例是否该被注入，以及注入什么。
 *
 * 由调用方提供（见 `src/index.js`），因为「这台服务器要不要 OAuth」是我们自己的配置，
 * 不是 SDK 的概念。
 *
 * @callback LookupProvider
 * @param {URL} url - transport 的目标地址。
 * @returns {{ provider: object, oauthProvider: object } | null} 需要注入时返回两个形态：
 *   `provider` 是极简 `{ token, onUnauthorized }`（transport 直接消费），
 *   `oauthProvider` 是完整的 `OAuthClientProvider`（供 `finishAuth` 与 403 step-up 用）。
 */

/**
 * 构造极简 `AuthProvider`。
 *
 * 这就是 SDK 未导出的 `adaptOAuthProvider()` 的等价实现 —— 它不是公开 API（实测导出表里
 * 没有），所以这里用公开导出的 `auth()` + `extractWWWAuthenticateParams()` 复刻其行为：
 *
 *   · `token()`：每请求读一次当前 access token（**这是刷新能生效的根本原因**）；
 *   · `onUnauthorized()`：收到 401 时跑一次 `auth()`，它内部会先用 refresh_token 续期，
 *     没有 refresh_token 才走完整授权；返回 `AUTHORIZED` 后 transport 自动重试一次。
 *
 * `REDIRECT` 不是一个「失败」，它是「需要用户去授权」的正常分支：此时把 URL 交出去
 * （provider 的 `redirectToAuthorization` 已经记下），然后抛一个可辨识的错误让
 * 客户端停止重试 —— 继续重试只会把 10 次预算耗尽，然后显示「已放弃重试」。
 */
export function makeAuthProvider({ sdk, oauthProvider, log, serverName, prepareAuth }) {
  const { auth, extractWWWAuthenticateParams } = sdk
  return {
    async token() {
      const tokens = await oauthProvider.tokens()
      return typeof tokens?.access_token === 'string' && tokens.access_token !== '' ? tokens.access_token : undefined
    },
    async onUnauthorized(ctx) {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response)
      /**
       * 明文端点需要先自己换一次令牌。
       *
       * `auth()` 在存在 refresh_token 时**无条件**走 SDK 的刷新，而那一处的 TLS 检查会
       * 直接抛 InsecureTokenEndpointError 并且**不吞掉**。对 transport 这条路径来说刷新
       * 才是对的动作（用户不该因为令牌过期被弹一次登录），所以让 flow 先用自己的实现
       * 换新令牌；成功了这次重试就会带上有效令牌。
       *
       * `prepareAuth` 返回：
       *   · `{ done: true }`            —— 已经换好令牌，直接返回让连接重试；
       *   · `{ forceReauthorization }` —— 换不了，跳过 SDK 刷新去走授权码流程；
       *   · `null` / 未提供             —— 安全端点，维持 SDK 原有行为。
       */
      const plan = typeof prepareAuth === 'function' ? await prepareAuth() : null
      if (plan?.done === true) return
      const result = await auth(oauthProvider, {
        serverUrl: ctx.serverUrl,
        resourceMetadataUrl,
        scope,
        ...(plan?.forceReauthorization === true ? { forceReauthorization: true } : {}),
        fetchFn: ctx.fetchFn,
      })
      if (result === 'AUTHORIZED') return
      // REDIRECT：授权链接已经交给面板（见 provider.redirectToAuthorization）。
      log?.warn?.(`dsh-skills-mcp-manager: ${serverName} 需要用户完成一次授权，已把授权链接交给面板`)
      const error = new Error(`${serverName} 需要授权：请在 MCP 面板里点「授权」完成一次登录`)
      error.code = 'OAUTH_REDIRECT_REQUIRED'
      throw error
    },
  }
}

/**
 * 安装补丁。
 *
 * HMR 幂等：原型是全局对象，重载会再次调用本函数。用 `Symbol.for` 找上一次的补丁，
 * 只**替换 lookup**，不再叠一层 wrapper（叠层会让同一次 start 注入多次，
 * 并让卸载变得不可能）。
 *
 * @param options.sdk - `sdk.js` 返回的已加载 SDK。
 * @param options.lookup - {@link LookupProvider}。
 * @param options.log - `{ warn }`。
 * @returns `{ installed, reason, detail, verify, uninstall }`。
 */
export function installTransportPatch({ sdk, lookup, log } = {}) {
  const T = sdk?.StreamableHTTPClientTransport
  if (typeof T !== 'function') {
    return { installed: false, reason: PATCH_REASONS.noTransportClass, detail: typeof T }
  }
  const proto = T.prototype
  if (proto === null || proto === undefined) {
    return { installed: false, reason: PATCH_REASONS.noTransportClass, detail: 'prototype' }
  }
  // 已经打过：只换 lookup，不叠 wrapper。
  const existing = proto[PATCH_KEY]
  if (existing !== undefined) {
    existing.lookup = lookup
    existing.sdk = sdk ?? existing.sdk
    return { installed: true, reason: '', detail: 'already-installed', verify: existing.verify, uninstall: existing.uninstall, reused: true }
  }
  if (typeof proto.start !== 'function') {
    return { installed: false, reason: PATCH_REASONS.noStart, detail: typeof proto.start }
  }
  if (typeof proto._commonHeaders !== 'function') {
    return { installed: false, reason: PATCH_REASONS.noCommonHeaders, detail: typeof proto._commonHeaders }
  }
  if (Object.isExtensible(proto) !== true) {
    return { installed: false, reason: PATCH_REASONS.notExtensible, detail: 'prototype frozen' }
  }

  const originalStart = proto.start
  const state = { lookup, sdk, version: 1 }

  const patched = async function patchedStart(...args) {
    // 已经注过就不重复（同一个实例 start 只会被调一次，但 HMR/重连可能复用）。
    if (this[INJECTED_KEY] !== true && (this._authProvider === undefined || this._authProvider === null) && (this._oauthProvider === undefined || this._oauthProvider === null)) {
      let picked = null
      try {
        picked = state.lookup?.(this._url) ?? null
      } catch (error) {
        log?.warn?.(`dsh-skills-mcp-manager: 查询 OAuth 配置失败（本次按无凭据连接）：${String(error?.message ?? error)}`)
        picked = null
      }
      if (picked !== null && picked !== undefined) {
        try {
          this._authProvider = picked.provider
          // `_oauthProvider` 只在 SDK 自己判定为 `OAuthClientProvider` 时才有值。
          // 我们直接同时挂上：`finishAuth()` 与 403 `insufficient_scope` step-up 都要求它，
          // 缺了它那两条路径会抛「requires an OAuthClientProvider」，而报错点离原因很远。
          this._oauthProvider = picked.oauthProvider
          this[INJECTED_KEY] = true
        } catch (error) {
          // 实例被 seal 住的情况：记录下来，让面板能看到「补丁没生效」，而不是假装成功。
          state.injectError = String(error?.message ?? error)
          log?.warn?.(`dsh-skills-mcp-manager: 无法给 transport 注入 OAuth provider：${state.injectError}`)
        }
      }
    }
    return originalStart.apply(this, args)
  }

  proto.start = patched

  /**
   * 用真实例验证补丁确实生效。
   *
   * 这不是形式主义：SDK 换实现时，上面每一步都可能「成功」而最终 `_commonHeaders()` 不带
   * `Authorization`。这里构造一个真实例、注入一个返回固定 token 的假 provider、
   * 然后读头 —— 唯一能证明「按钮点了会有用」的证据。
   *
   * @param probeUrl - 随便一个 URL；不会真的发请求。
   * @returns `{ ok, reason, detail }`。
   */
  const verify = async (probeUrl = 'https://oauth-verify.invalid/mcp') => {
    try {
      const instance = new T(new URL(probeUrl))
      instance._authProvider = { token: async () => 'patch-verify-token' }
      const headers = await instance._commonHeaders()
      const value = headers?.get?.('authorization') ?? ''
      if (!String(value).includes('patch-verify-token')) {
        return { ok: false, reason: PATCH_REASONS.injectFailed, detail: `authorization=${String(value)}` }
      }
      // 恢复：这个实例是临时的，不留引用即可。
      instance._authProvider = undefined
      return { ok: true, reason: '', detail: '' }
    } catch (error) {
      return { ok: false, reason: PATCH_REASONS.injectFailed, detail: String(error?.message ?? error) }
    }
  }

  const uninstall = () => {
    try {
      if (proto.start === patched) proto.start = originalStart
    } catch (error) {
      log?.warn?.(`dsh-skills-mcp-manager: 还原 transport 补丁失败：${String(error?.message ?? error)}`)
    }
    delete proto[PATCH_KEY]
  }

  state.verify = verify
  state.uninstall = uninstall
  proto[PATCH_KEY] = state

  return { installed: true, reason: '', detail: '', verify, uninstall, reused: false }
}

/** 补丁不可用时的中文说明。缺什么就说什么，不给一句泛泛的「不支持」。 */
export function patchReasonText(reason) {
  switch (reason) {
    case PATCH_REASONS.noTransportClass:
      return 'MCP SDK 里没有 StreamableHTTPClientTransport，OAuth 不可用'
    case PATCH_REASONS.noStart:
      return 'MCP SDK 的 transport 结构与预期不同（start 缺失），OAuth 不可用'
    case PATCH_REASONS.noCommonHeaders:
      return 'MCP SDK 的 transport 结构与预期不同（请求头构造缺失），OAuth 不可用'
    case PATCH_REASONS.notExtensible:
      return 'MCP SDK 的 transport 原型不可扩展，OAuth 不可用'
    case PATCH_REASONS.injectFailed:
      return 'OAuth provider 注入后验证失败（SDK 版本可能已变），OAuth 不可用'
    default:
      return 'OAuth 支持未安装'
  }
}
