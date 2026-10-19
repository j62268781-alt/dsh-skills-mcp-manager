/**
 * OAuth 流程编排：发现 → 动态注册 → PKCE → 换令牌 → 刷新。
 *
 * ## 为什么不自己拼这些步骤
 *
 * SDK 导出的 `auth(provider, options)` 已经是一台完整的编排机（实测 `index.mjs:642`）：
 * 它会依次做受保护资源元数据发现（RFC 9728）、授权服务器元数据发现（RFC 8414）、
 * 动态客户端注册（RFC 7591，`registerClient`）、选 resource 指示器（RFC 8707）、
 * 选 scope、用 refresh_token 续期、以及 PKCE 授权码换令牌。每一步都按规范处理了
 * 「缓存了 discoveryState 就复用」「issuer 不匹配就拒绝」这类细节。
 *
 * 自己重写一遍的唯一后果是**比 SDK 更不完整**，而且每次 SDK 修 bug 都要跟一遍。
 * 所以这里只做三件 SDK 不做的事：
 *
 *   1. **两段式**。`auth()` 是同步编排的：首次调用走到 `redirectToAuthorization` 就返回
 *      `REDIRECT`，拿不到 code。而我们的 code 是通过 HTTP 回调**异步**进来的。
 *      所以「发起」与「完成」必须是两次独立调用，中间隔着一次用户操作。
 *   2. **把 REDIRECT 变成一个正常结果**。transport 那条链路上 `REDIRECT` 会被当成
 *      未授权错误（客户端随后重试到放弃），而面板这条链路上它是**成功发起**。
 *   3. **人话错误**。SDK 的报错是给开发者看的；面板要告诉用户下一步做什么。
 *
 * ## 不 import SDK
 *
 * SDK 由调用方注入（`sdk.js` 负责加载）。这样 flow 的逻辑可以在 CI 上用一个假 SDK
 * 完整测试 —— 而 SDK 的 OAuth 实现本身在 CI 上根本装不到。
 */
import { tokenStatus, pendingIsFresh } from './provider.js'
import { stateMatches } from './state.js'
import { exchangeInsecureToken, insecureTokenEndpoint, tokenExchangeErrorText } from './insecure.js'

/** 发起授权的失败原因。 */
export const FLOW_ERRORS = Object.freeze({
  noSdk: 'oauth-sdk-unavailable',
  noUrl: 'server-has-no-url',
  notHttp: 'server-is-not-http',
  beginFailed: 'authorization-could-not-start',
  stateMismatch: 'oauth-state-mismatch',
  noPending: 'no-authorization-in-progress',
  expired: 'authorization-expired',
  completeFailed: 'authorization-could-not-complete',
  /** 非 https 且非回环的 token 端点，且这台服务器没有勾选明文例外。 */
  insecureNotAllowed: 'insecure-token-endpoint-not-allowed',
  /** 没有 refresh_token，只能让用户重新授权。 */
  notRefreshable: 'no-refresh-token',
  /** 刷新被授权服务器拒绝（refresh_token 过期/被撤销）。 */
  refreshFailed: 'refresh-rejected',
})

/** 失败原因的中文说明。面板直接展示，所以要说「下一步做什么」。 */
export function flowReasonText(reason) {
  switch (reason) {
    case FLOW_ERRORS.noSdk:
      return 'OAuth 支持未安装（找不到 MCP SDK），无法发起授权'
    case FLOW_ERRORS.noUrl:
      return '这台服务器没有可用的 URL，无法走 OAuth'
    case FLOW_ERRORS.notHttp:
      return '只有 http(s) 服务器能走 OAuth；stdio 服务器请改用环境变量或请求头传凭据'
    case FLOW_ERRORS.beginFailed:
      return '发起授权失败'
    case FLOW_ERRORS.stateMismatch:
      return '回调校验失败（state 不匹配），可能是伪造的回调或本轮授权已作废，请重新点「授权」'
    case FLOW_ERRORS.noPending:
      return '没有正在进行的授权：请先点「授权」，再在浏览器里完成登录'
    case FLOW_ERRORS.expired:
      return '这次授权已经超时（超过 10 分钟），请重新点「授权」'
    case FLOW_ERRORS.completeFailed:
      return '完成授权失败'
    case FLOW_ERRORS.insecureNotAllowed:
      return 'token 端点不是 https，而「允许明文 token 端点」没有为这台服务器打开。明文传输令牌会把凭据暴露给同网段，因此默认拒绝'
    case FLOW_ERRORS.notRefreshable:
      return '这份凭据没有 refresh_token，刷新不了；需要重新授权一次'
    case FLOW_ERRORS.refreshFailed:
      return '刷新令牌被授权服务器拒绝（refresh_token 可能已过期或被撤销），需要重新授权'
    default:
      return '授权失败'
  }
}

/**
 * 用回调拿到的 `code`，在**明文** token 端点上完成交换。
 *
 * 与 SDK 那条路径的区别只有「谁发这个 POST」。其余状态（PKCE verifier、client_id、
 * discoveryState、落盘、清理 pending）都来自同一个 provider 记录，所以两条路径不会分叉出
 * 两套凭据语义 —— 那是本仓库已经踩过一次的坑（两处实现必然漂移）。
 *
 * @param options.serverName - 服务器名（日志与错误文案用）。
 * @param options.record - 当前凭据记录（含 `clientInformation` / `discoveryState` / `codeVerifier`）。
 * @param options.tokenEndpoint - 授权服务器元数据里的 `token_endpoint`。
 * @param options.code - 回调带来的授权码。
 */
async function completeInsecure({ serverName, provider, record, tokenEndpoint, code, forget, snapshot, log }) {
  const clientId = String(record?.clientInformation?.client_id ?? '')
  if (clientId === '') {
    return {
      ok: false,
      reason: FLOW_ERRORS.completeFailed,
      detail: '缺少 client_id：明文例外要求先用动态注册（或手填）拿到客户端信息',
      text: flowReasonText(FLOW_ERRORS.completeFailed),
    }
  }
  const verifier = String(record?.codeVerifier ?? '')
  if (verifier === '') {
    return {
      ok: false,
      reason: FLOW_ERRORS.completeFailed,
      detail: '缺少 PKCE code_verifier：授权流程可能已过期，请重新点一次「授权」',
      text: flowReasonText(FLOW_ERRORS.completeFailed),
    }
  }
  const redirectUri = String(record?.clientInformation?.redirect_uris?.[0] ?? '')
  const resource = String(record?.resourceUrl ?? '')
  const exchanged = await exchangeInsecureToken({
    tokenEndpoint,
    clientId,
    log,
    params: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      // RFC 6749 §4.1.3: `redirect_uri` must be repeated when it was in the authorization
      // request. Some servers ignore it; omitting it when required fails with invalid_grant.
      redirect_uri: redirectUri,
      resource,
    },
  })
  if (exchanged.ok !== true) {
    return { ok: false, reason: exchanged.reason, detail: exchanged.detail, text: exchanged.text ?? tokenExchangeErrorText(exchanged.reason) }
  }
  // 落盘走 provider 的 saveTokens：它同时记下 tokensSavedAt 并清掉 pending / codeVerifier，
  // 与 SDK 路径完全一致 —— 两条路径共用同一个写入点，才不会分叉出两套凭据语义。
  try {
    await provider.saveTokens({ ...exchanged.tokens, issuer: String(record?.discoveryState?.authorizationServerUrl ?? '') })
  } catch (error) {
    return {
      ok: false,
      reason: FLOW_ERRORS.completeFailed,
      detail: String(error?.message ?? error),
      text: flowReasonText(FLOW_ERRORS.completeFailed),
    }
  }
  const saved = await snapshot()
  forget(serverName)
  return { ok: true, reason: '', detail: '', text: '授权完成（明文 token 端点）', ...tokenStatus(saved) }
}

/** 从 SDK 抛出的错误里取一段**能贴到面板上**的文字。 */
export function describeFlowError(error) {
  const message = String(error?.message ?? error ?? '')
  if (message === '') return '未知错误'
  // SDK 的 OAuth 错误带 code（invalid_client / invalid_grant …），对用户没有意义，
  // 但对我们排查有意义，所以拼成一句短的。
  const code = typeof error?.code === 'string' ? error.code : ''
  const base = message.length > 300 ? `${message.slice(0, 300)}…` : message
  return code === '' ? base : `${base}（${code}）`
}

/**
 * 建一套流程。
 *
 * @param options.store - `createOAuthStore()`。用于读 pending / 清理凭据。
 * @param options.getSdk - 返回 `{ ok, sdk }` 或 `{ ok:false, reason }`。由 `src/index.js`
 *   传入一个已缓存的加载器，这样面板每次请求不必重新解析模块。
 * @param options.makeProvider - `(serverName, url) => { provider, snapshot, invalidate }`，
 *   注入以便测试替换。
 * @param options.log - `{ warn, info }`。
 */
export function createOAuthFlow({ store, getSdk, makeProvider, allowInsecure, currentRedirectUri, log } = {}) {
  /** 每个服务器一个 provider 实例：内存缓存要在多次请求之间保持，否则每请求都读盘。 */
  const providers = new Map()

  /**
   * The one provider instance per server.
   *
   * **There must be exactly one.** Both the transport patch (`_authProvider.token()` on every
   * request) and this flow read through it, and each provider caches the credential record in
   * memory. Two instances means two caches: the flow saves a token, the transport keeps
   * reading its own stale "no tokens" snapshot, and the server keeps answering 401 forever
   * while the panel says 「已授权」. That is a silent, extremely confusing failure, so the
   * cache is created here and handed out — never duplicated.
   *
   * @param serverName - the server whose credentials this provider owns.
   * @param url - the MCP endpoint; a changed URL invalidates the cached instance because the
   *   saved credentials may belong to the old server.
   */
  /**
   * 丢掉绑定在**旧回调地址**上的客户端信息。
   *
   * @returns `true` 表示确实丢掉了一份过期绑定（调用方应重新取 provider）。
   */
  const dropStaleClientBinding = async ({ serverName, url, forget }) => {
    const current = String(currentRedirectUri?.() ?? '')
    if (current === '') return false
    const record = await store.read(serverName, url)
    const bound = Array.isArray(record?.clientInformation?.redirect_uris)
      ? record.clientInformation.redirect_uris
      : []
    // 没有 clientInformation（还没注册过）或它没写 redirect_uris（服务器没回）：
    // 没有可比对的东西，交给 SDK 自己处理。
    if (bound.length === 0) return false
    if (bound.includes(current)) return false
    log?.info?.(`dsh-skills-mcp-manager: ${serverName} 的 OAuth 客户端绑定在旧回调地址上（${bound.join(', ')} → ${current}），将重新注册`)
    await store.update(serverName, url, (next) => {
      // 只清「注册产物」和「与之绑定的进行中状态」：令牌不动 —— 它们可能仍然有效，
      // 清掉等于让一台本来能用的服务器掉线。
      next.clientInformation = null
      next.pending = null
      next.codeVerifier = ''
    })
    forget(serverName)
    return true
  }

  /**
   * 这台服务器是不是「明文 token 端点」情形，以及例外有没有开。
   *
   * @returns `{ applicable, allowed, hasRefresh, tokenEndpoint }`。
   *   `applicable` = 端点非 https 且非回环（SDK 会硬拒的那一类）。
   */
  const insecureGate = async (serverName, url) => {
    const record = await store.read(serverName, url)
    const tokenEndpoint = String(record?.discoveryState?.authorizationServerMetadata?.token_endpoint ?? '')
    if (tokenEndpoint === '') return { applicable: false, allowed: false, hasRefresh: false, tokenEndpoint }
    if (insecureTokenEndpoint(tokenEndpoint).insecure !== true) {
      return { applicable: false, allowed: false, hasRefresh: false, tokenEndpoint }
    }
    return {
      applicable: true,
      allowed: allowInsecure?.(serverName) === true,
      hasRefresh: String(record?.tokens?.refresh_token ?? '') !== '',
      tokenEndpoint,
    }
  }

  const providerFor = (serverName, url) => {
    const cached = providers.get(serverName)
    if (cached !== undefined && cached.url === url) return cached
    const made = makeProvider(serverName, url)
    providers.set(serverName, { url, ...made })
    return providers.get(serverName)
  }

  /** 丢掉内存里的 provider（登出、URL 变更、授权完成后的重置都走它）。 */
  const forget = (serverName) => {
    providers.delete(serverName)
  }

  const assertHttpUrl = (url) => {
    if (typeof url !== 'string' || url === '') return { ok: false, reason: FLOW_ERRORS.noUrl }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: FLOW_ERRORS.noUrl }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: FLOW_ERRORS.notHttp }
    return { ok: true, url: parsed }
  }

  /**
   * 用 refresh_token 换一份新令牌。
   *
   * `refresh`（面板主动刷新、预刷新扫描）与 `prepareAuth`（transport 撞 401 之后）共用
   * 同一份实现 —— 两条路径各写一遍必然漂移，而漂移出来的差异正是「刷新成功了但下一次
   * 连接读不到」这类最难查的 bug。
   */
  const refreshTokens = async (serverName, url) => {
  const target = assertHttpUrl(url)
  if (target.ok !== true) return { ok: false, reason: target.reason, detail: '', text: flowReasonText(target.reason) }
  const record = await store.read(serverName, target.url)
  const refreshToken = String(record?.tokens?.refresh_token ?? '')
  if (refreshToken === '') {
    return { ok: false, reason: FLOW_ERRORS.notRefreshable, detail: '', text: flowReasonText(FLOW_ERRORS.notRefreshable) }
  }
  const metadata = record?.discoveryState?.authorizationServerMetadata
  const tokenEndpoint = String(metadata?.token_endpoint ?? '')
  const asUrl = String(record?.discoveryState?.authorizationServerUrl ?? '')
  const clientId = String(record?.clientInformation?.client_id ?? '')
  const resource = String(record?.resourceUrl ?? '')
  const { provider, snapshot } = providerFor(serverName, target.url)

  const gate = tokenEndpoint === '' ? { insecure: false } : insecureTokenEndpoint(tokenEndpoint)
  if (gate.insecure === true) {
    if (allowInsecure?.(serverName) !== true) {
      return {
        ok: false,
        reason: FLOW_ERRORS.insecureNotAllowed,
        detail: tokenEndpoint,
        text: flowReasonText(FLOW_ERRORS.insecureNotAllowed),
      }
    }
    const exchanged = await exchangeInsecureToken({
      tokenEndpoint,
      clientId,
      log,
      params: { grant_type: 'refresh_token', refresh_token: refreshToken, resource },
    })
    if (exchanged.ok !== true) {
      return { ok: false, reason: FLOW_ERRORS.refreshFailed, detail: exchanged.detail, text: flowReasonText(FLOW_ERRORS.refreshFailed) }
    }
    try {
      await provider.saveTokens({ ...exchanged.tokens, issuer: asUrl })
    } catch (error) {
      return { ok: false, reason: FLOW_ERRORS.refreshFailed, detail: String(error?.message ?? error), text: flowReasonText(FLOW_ERRORS.refreshFailed) }
    }
    const saved = await snapshot()
    return { ok: true, reason: '', detail: '', text: '令牌已刷新', ...tokenStatus(saved) }
  }

  const sdkResult = getSdk()
  if (sdkResult?.ok !== true) {
    return {
      ok: false,
      reason: FLOW_ERRORS.noSdk,
      detail: String(sdkResult?.detail ?? sdkResult?.reason ?? ''),
      text: flowReasonText(FLOW_ERRORS.noSdk),
    }
  }
  const { sdk } = sdkResult
  if (typeof sdk.refreshAuthorization !== 'function') {
    return { ok: false, reason: FLOW_ERRORS.noSdk, detail: 'SDK 没有导出 refreshAuthorization', text: flowReasonText(FLOW_ERRORS.noSdk) }
  }
  try {
    const tokens = await sdk.refreshAuthorization(asUrl, {
      metadata,
      clientInformation: record?.clientInformation,
      refreshToken,
    })
    await provider.saveTokens({ ...tokens, issuer: asUrl })
    const saved = await snapshot()
    return { ok: true, reason: '', detail: '', text: '令牌已刷新', ...tokenStatus(saved) }
  } catch (error) {
    log?.warn?.(`dsh-skills-mcp-manager: 刷新 ${serverName} 的令牌失败：${String(error?.message ?? error)}`)
    return { ok: false, reason: FLOW_ERRORS.refreshFailed, detail: describeFlowError(error), text: flowReasonText(FLOW_ERRORS.refreshFailed) }
  }
  }

  return {
    forget,
    /** The shared provider for one server. See {@link providerFor} for why it must be shared. */
    providerFor,

    /** 面板读状态用：有没有令牌、会不会过期、是不是正等着用户去授权。 */
    status: async (serverName, url) => {
      const record = await store.read(serverName, url)
      const tokens = tokenStatus(record)
      const waiting = pendingIsFresh(record)
      return {
        ...tokens,
        waiting,
        authorizeUrl: waiting === true ? String(record?.pending?.url ?? '') : '',
        updatedAt: String(record.updatedAt ?? ''),
      }
    },

    /**
     * 发起授权。
     *
     * 三种结果都算「正常」，面板据此给出不同文案：
     *   · `authorized` —— 已有可用令牌 / refresh_token 直接续期成功，无需用户操作；
     *   · `redirect`   —— 拿到了一个授权 URL，要用户去浏览器完成；
     *   · `error`      —— 失败，带人话原因。
     */
    begin: async (serverName, url) => {
      const target = assertHttpUrl(url)
      if (target.ok !== true) {
        return { kind: 'error', reason: target.reason, detail: '', text: flowReasonText(target.reason) }
      }
      const sdkResult = getSdk()
      if (sdkResult?.ok !== true) {
        return {
          kind: 'error',
          reason: FLOW_ERRORS.noSdk,
          detail: String(sdkResult?.detail ?? sdkResult?.reason ?? ''),
          text: flowReasonText(FLOW_ERRORS.noSdk),
        }
      }
      const { sdk } = sdkResult
      /**
       * 明文端点必须先过这道门。
       *
       * SDK 的 `authInternal` 里有这一句：
       *
       *     if (tokens?.refresh_token && !forceReauthorization) {
       *       try { newTokens = await refreshAuthorization(...) }
       *       catch (error) { if (error instanceof InsecureTokenEndpointError) throw error }
       *     }
       *
       * 也就是说：**只要存在 refresh_token 就一定会尝试刷新**（与是否过期无关），而刷新
       * 走的 `executeTokenRequest` 里 TLS 检查是无条件的，且这个错误被原样上抛。所以
       * 「已授权 + 明文端点」点重新授权必然炸在 refresh 上，而不是走到授权链接。
       *
       * 两条出路：
       *   · 例外没开 → 直接给出可执行的说明（去开那个开关），而不是把 SDK 的英文原文
       *     丢给用户；
       *   · 例外开了 → 用 `forceReauthorization: true` 让 SDK **跳过**它自己的刷新，
       *     直接走授权码流程。用户点的是「重新授权」，本来就该拿一次新的授权。
       */
      const gate = await insecureGate(serverName, target.url)
      if (gate.applicable === true && gate.allowed !== true) {
        return {
          kind: 'error',
          reason: FLOW_ERRORS.insecureNotAllowed,
          detail: gate.tokenEndpoint,
          text: flowReasonText(FLOW_ERRORS.insecureNotAllowed),
        }
      }

      let { provider, snapshot } = providerFor(serverName, url)
      /**
       * 缓存的 client 是否还绑在当前的回调地址上。
       *
       * 桌面版把端口写死成 `--port 0`，每次启动都是新端口；而动态注册回来的
       * `client_id` 与注册时的 `redirect_uri` 绑定。端口一变，旧 client 就作废了 ——
       * 继续用它只会得到一句难以理解的 `invalid_client`。这里主动比对：不一致就丢掉
       * 缓存的 client，让 SDK 重新注册一次（DCR 本来就是为这种场景设计的）。
       *
       * 只在**已知**当前回调地址、且记录里**确实有**一份绑定的情况下动手：拿不到当前
       * 地址时不该无端清掉一份可用的凭据。
       */
      const boundRedirect = await dropStaleClientBinding({ serverName, url: target.url, forget })
      if (boundRedirect === true) ({ provider, snapshot } = providerFor(serverName, url))
      try {
        const result = await sdk.auth(provider, {
          serverUrl: target.url,
          // 明文端点：跳过 SDK 内部那次必然抛错的刷新（见上面 gate 的注释）。
          ...(gate.applicable === true ? { forceReauthorization: true } : {}),
        })
        if (result === 'AUTHORIZED') {
          const record = await snapshot()
          // 内存实例里的缓存是「授权前」那份；丢掉它，下一次请求重新读盘才看得到新令牌。
          forget(serverName)
          return { kind: 'authorized', reason: '', detail: '', text: '已授权（用已有的 refresh_token 续期，无需重新登录）', ...tokenStatus(record) }
        }
        // REDIRECT：URL 由 provider.redirectToAuthorization 存进了 pending。
        const record = await snapshot()
        const authorizeUrl = String(record?.pending?.url ?? '')
        if (authorizeUrl === '') {
          // 理论上不会发生（REDIRECT 必先经 redirectToAuthorization）。真发生了说明 SDK
          // 改了顺序，此时如实说「拿不到链接」，不要伪造一个。
          return {
            kind: 'error',
            reason: FLOW_ERRORS.beginFailed,
            detail: 'SDK 返回 REDIRECT 但没有交回授权 URL',
            text: flowReasonText(FLOW_ERRORS.beginFailed),
          }
        }
        return { kind: 'redirect', reason: '', detail: '', text: '请在浏览器里打开下面的链接完成登录', authorizeUrl }
      } catch (error) {
        log?.warn?.(`dsh-skills-mcp-manager: 发起 ${serverName} 的授权失败：${String(error?.message ?? error)}`)
        return {
          kind: 'error',
          reason: FLOW_ERRORS.beginFailed,
          detail: describeFlowError(error),
          text: flowReasonText(FLOW_ERRORS.beginFailed),
        }
      }
    },

    /**
     * 校验回调里的 `state`，通过则返回 `{ ok: true, code }`。
     *
     * 这里是**本插件自己的**安全边界，不能省：
     *
     *   · 回调路由挂在 DSH 自己的监听端口上，任何能访问那个端口的东西都能发过来；
     *   · `state` 是唯一能证明「这次回调属于我刚刚发起的那一轮」的证据；
     *   · 必须**定长比较**（见 `state.js`）；
     *   · 必须**一次性**：`complete()` 成功后清掉 pending，重放会落到 `noPending`。
     */
    checkCallback: async (serverName, receivedState, receivedCode, now = Date.now()) => {
      const record = await store.read(serverName)
      const pending = record?.pending
      if (pending === null || pending === undefined) return { ok: false, reason: FLOW_ERRORS.noPending }
      const expected = String(pending.state ?? '')
      if (expected === '' || typeof receivedState !== 'string' || receivedState === '') {
        return { ok: false, reason: FLOW_ERRORS.stateMismatch }
      }
      const expiresAt = Date.parse(String(pending.expiresAt ?? ''))
      if (Number.isFinite(expiresAt) && expiresAt <= now) return { ok: false, reason: FLOW_ERRORS.expired }
      if (typeof receivedCode !== 'string' || receivedCode === '') return { ok: false, reason: FLOW_ERRORS.completeFailed }
      if (!stateMatches(expected, receivedState)) return { ok: false, reason: FLOW_ERRORS.stateMismatch }
      return { ok: true, code: receivedCode }
    },

    /**
     * 用回调拿到的 code 完成授权。
     *
     * 成功之后必须**重置内存 provider**：旧实例里缓存的是「没有令牌」的那份记录，
     * 而 transport 每请求都读它。
     */
    complete: async (serverName, url, code) => {
      const target = assertHttpUrl(url)
      if (target.ok !== true) return { ok: false, reason: target.reason, detail: '', text: flowReasonText(target.reason) }
      const sdkResult = getSdk()
      if (sdkResult?.ok !== true) {
        return {
          ok: false,
          reason: FLOW_ERRORS.noSdk,
          detail: String(sdkResult?.detail ?? sdkResult?.reason ?? ''),
          text: flowReasonText(FLOW_ERRORS.noSdk),
        }
      }
      const { sdk } = sdkResult
      // 完成时**必须**用同一个 provider 实例：PKCE code_verifier 与 discoveryState 都在
      // 它的缓存里，新建一个就读不到，SDK 会报「没有保存 code_verifier」。
      const { provider, snapshot } = providerFor(serverName, url)

      /*
       * Plaintext token endpoint, explicitly allowed for this server.
       *
       * The SDK refuses this unconditionally (`assertSecureTokenEndpoint`), which is correct
       * policy — but an intranet MCPHub deployed without TLS cannot satisfy it. Rather than
       * patching the SDK, this path does the final exchange itself (one RFC 6749 §4.1.3 form
       * POST) so the SDK's code stays untouched for every HTTPS server. See `insecure.js`.
       *
       * The refusal case is checked FIRST: if the server has an insecure endpoint and the
       * exception is off, the user must get the explicit "not allowed" reason rather than the
       * SDK's opaque `InsecureTokenEndpointError` — the former tells them which checkbox to
       * look at.
       */
      const record = await snapshot()
      const tokenEndpoint = String(record?.discoveryState?.authorizationServerMetadata?.token_endpoint ?? '')
      const gate = tokenEndpoint === '' ? { insecure: false } : insecureTokenEndpoint(tokenEndpoint)
      if (gate.insecure === true) {
        const allowed = allowInsecure?.(serverName) === true
        if (!allowed) {
          return {
            ok: false,
            reason: FLOW_ERRORS.insecureNotAllowed,
            detail: `${tokenEndpoint}（${gate.protocol}//${gate.host}）`,
            text: flowReasonText(FLOW_ERRORS.insecureNotAllowed),
          }
        }
        return completeInsecure({ serverName, provider, record, tokenEndpoint, code, forget, snapshot, log })
      }

      try {
        const result = await sdk.auth(provider, { serverUrl: target.url, authorizationCode: code })
        if (result !== 'AUTHORIZED') {
          return {
            ok: false,
            reason: FLOW_ERRORS.completeFailed,
            detail: `SDK 返回 ${String(result)}`,
            text: flowReasonText(FLOW_ERRORS.completeFailed),
          }
        }
        const record = await snapshot()
        forget(serverName)
        return { ok: true, reason: '', detail: '', text: '授权完成', ...tokenStatus(record) }
      } catch (error) {
        log?.warn?.(`dsh-skills-mcp-manager: 完成 ${serverName} 的授权失败：${String(error?.message ?? error)}`)
        return {
          ok: false,
          reason: FLOW_ERRORS.completeFailed,
          detail: describeFlowError(error),
          text: flowReasonText(FLOW_ERRORS.completeFailed),
        }
      }
    },

    /** 登出：删掉凭据文件并丢掉内存缓存。 */
    /**
     * 用 refresh_token 换一份新令牌。
     *
     * 两条路径，与 `complete` 同源：https / 回环端点走 SDK 自己的 `refreshAuthorization`
     * （它的编排最成熟），非回环的明文端点走 `exchangeInsecureToken`（那一处 TLS 检查是
     * 无条件的，没法绕，只能自己发那一个表单）。落盘都走 `provider.saveTokens`，所以两种
     * 路径写出来的凭据语义完全一致。
     *
     * @param serverName - 服务器名。
     * @param url - 该服务器的 MCP 地址（定位凭据记录用）。
     * @returns `{ ok, reason, detail, text, ...tokenStatus }`。永不抛错。
     */
    /**
     * transport 在 401 上要用的「先自己刷新」判定。
     *
     * @returns `{ done: true }`（令牌已换好，直接重试）、`{ forceReauthorization: true }`
     *   （换不了，让 SDK 跳过它自己那次必然抛错的刷新），或 `null`（安全端点，不干预）。
     */
    prepareAuth: async (serverName, url) => {
      const target = assertHttpUrl(url)
      if (target.ok !== true) return null
      const gate = await insecureGate(serverName, target.url)
      if (gate.applicable !== true) return null
      // 例外没开：刷新同样会被拒，交给 complete/begin 去给出可执行的说明。
      if (gate.allowed !== true) return { forceReauthorization: true }
      // 没有 refresh_token：只能走一次新的授权。
      if (gate.hasRefresh !== true) return { forceReauthorization: true }
      // 传**原始字符串**：`assertHttpUrl` 返回的 `url` 是 URL 对象，而 refreshTokens 自己
      // 也做一次校验（要求字符串），传对象会得到 server-has-no-url。
      const refreshed = await refreshTokens(serverName, url)
      if (refreshed.ok === true) return { done: true }
      log?.warn?.(`dsh-skills-mcp-manager: ${serverName} 在 401 后自行刷新失败（${refreshed.reason}），将走一次新的授权`)
      return { forceReauthorization: true }
    },

    refresh: (serverName, url) => refreshTokens(serverName, url),

    logout: async (serverName) => {
      forget(serverName)
      const removed = await store.remove(serverName)
      return { ok: true, removed: removed === true, text: removed === true ? '已清除授权凭据' : '本来就没有保存的凭据' }
    },
  }
}
