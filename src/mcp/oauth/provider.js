/**
 * `OAuthClientProvider` 的实现 —— SDK 与本次落盘之间的适配层。
 *
 * ## 它解决的是什么问题
 *
 * `@modelcontextprotocol/client` 的 `StreamableHTTPClientTransport` 接受
 * `authProvider`（2.0.0 起），SDK 用它做三件事：每次请求前取 access token、
 * 401 时回调 `onUnauthorized` 触发刷新、`auth()` 编排里逐步读写中间状态。
 * 而 `dsh-mcp-client` 构造 transport 时**只传 `requestInit.headers`**，从不传
 * `authProvider` —— 于是 SDK 的 401 分支永不成立，客户端按普通网络故障重试到放弃。
 *
 * 本模块就是那个缺失的 provider。它不发起任何流程（那是 `flow.js` 的事），
 * 只回答 SDK 的读写问题。
 *
 * ## 与 SDK 的契约要点
 *
 * · **`tokens()` 会被无参调用**（transport 每请求取一次）。SDK 的文档明确要求这种情况
 *   返回「最近保存的那一份」，而不是 `undefined`。凭据按服务器隔离，所以这里天然满足。
 * · `redirectUrl` / `clientMetadata` 是 **getter**，不是方法。写成方法的话 SDK 读到的是
 *   函数对象，OAuth 请求会带上错误的 `redirect_uri`，且不会抛错。
 * · `state()` / `codeVerifier()` 必须回放 `auth()` 之前存下的值，否则回调腿校验失败。
 * · `saveDiscoveryState()` / `discoveryState()` 是可选的，但**强烈建议实现**：
 *   SDK 在回调腿用它做授权服务器绑定校验（SEP-2352），缺失时只会打一条 warning，
 *   然后放弃这道防线。我们实现它，是为了让那道校验真的生效。
 *
 * ## 不 import SDK
 *
 * 值的形状（`StoredOAuthTokens` 等）都是普通 JSON，SDK 不导出运行时校验函数需要的东西。
 * 保持这个模块无依赖，才能在 CI 上单测（CI 没有宿主 `node_modules`）。
 */

/** 授权等待中的状态：在 `store` 的 `pending` 字段里往返。 */
const PENDING_TTL_MS = 10 * 60 * 1000

/** `clientMetadata` 的默认值。DCR 会拿它注册，所以字段要保守、不要声明不需要的能力。 */
export function defaultClientMetadata(redirectUri) {
  return {
    client_name: 'DSH Skills & MCP Manager',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    // 没有 clientMetadataUrl：那是「用 HTTPS URL 当 client_id」的 CIMD 路径，
    // 需要公网可访问的文档，桌面插件无法提供。DCR 是唯一现实的自动化路径。
  }
}

/**
 * 建一个 provider。
 *
 * @param options.store - `createOAuthStore()` 的返回值。
 * @param options.serverName - 服务器名，凭据按它隔离。
 * @param options.url - 这台服务器的 MCP 端点；`redirectUrl` 的模板由它派生。
 * @param options.redirectUri - 回调地址（由 webServer 的 origin 拼出）。
 * @param options.onRedirect - 收到授权 URL 时调用。`flow.js` 用它把 URL 交给面板，
 *   而不是真的去开浏览器（DSH 官方登录也是「复制链接」而不是自动拉起浏览器）。
 * @param options.log - `{ warn }`。
 * @returns 一个满足 `OAuthClientProvider` 的对象。
 */
export function createOAuthProvider({
  store,
  serverName,
  url = '',
  redirectUri = '',
  onRedirect,
  log,
} = {}) {
  /** 本次进程内缓存一份记录，避免每个请求都读盘 —— transport 每请求都会问一次 token。 */
  let cache = null
  let loading = null
  /** `state()` 刚发出、尚未随授权 URL 一起落盘的值。 */
  let issuedState = ''

  const load = async () => {
    if (cache !== null) return cache
    if (loading !== null) return loading
    loading = store.read(serverName, url).then((record) => {
      cache = record
      loading = null
      return record
    })
    return loading
  }

  /** 写回并同步内存副本。 */
  const persist = async (mutate) => {
    const current = await load()
    const next = { ...current }
    const result = (await mutate(next)) ?? next
    cache = result
    try {
      await store.write(serverName, result)
    } catch (error) {
      // 写盘失败不该把一次已经成功的授权变成失败：内存里已经有 token，本次会话仍可用。
      // 但必须留痕 —— 用户下次重启会重新需要授权。
      log?.warn?.(`dsh-skills-mcp-manager: 保存 ${serverName} 的 OAuth 凭据失败：${String(error?.message ?? error)}`)
    }
    return result
  }

  /** 给外部（flow.js / 面板）读当前记录用。 */
  const snapshot = async () => ({ ...(await load()) })

  /** 外部改了记录（例如后台刷新成功）后让缓存失效。 */
  const invalidate = () => {
    cache = null
    loading = null
  }

  const provider = {
    /**
     * 回调地址。
     *
     * 返回 `undefined` 会让 SDK 认为这是一条**非交互**流程（`client_credentials` 等），
     * 从而跳过整个授权码分支 —— 那正是我们要走的路径，所以这里必须是有值的。
     */
    get redirectUrl() {
      return redirectUri
    },

    /** DCR 注册用的元数据。 */
    get clientMetadata() {
      const current = cache
      // redirect_uris 必须与本次实际使用的回调地址一致，否则 AS 会拒绝（RFC 6749 §3.1.2）。
      const redirects = redirectUri === '' ? [] : [redirectUri]
      if (redirects.length === 0 && Array.isArray(current?.clientInformation?.redirect_uris)) {
        return { ...defaultClientMetadata(''), redirect_uris: current.clientInformation.redirect_uris }
      }
      return defaultClientMetadata(redirectUri)
    },

    /**
     * CSRF 用的 `state`。
     *
     * 每轮新生成。SDK 的调用顺序是 `state()` → `startAuthorization()` →
     * `saveCodeVerifier()` → `redirectToAuthorization()`，所以这里先生成并**记在闭包里**，
     * 等 `redirectToAuthorization()` 再落盘 —— 那时才知道授权 URL，两者要一起存。
     * 若在 `state()` 就落盘，一次失败的授权会留下一个 state，下一轮要覆盖它，中间有一小段
     * 窗口里回调能对上一条已经作废的记录。
     */
    state() {
      issuedState = randomState()
      return issuedState
    },

    async clientInformation() {
      const record = await load()
      return record.clientInformation ?? undefined
    },

    async saveClientInformation(clientInformation) {
      await persist((record) => {
        record.clientInformation = clientInformation ?? null
      })
    },

    /**
     * 当前令牌。
     *
     * transport 每发一个请求都调它一次（**无参**），所以这条路径必须便宜：
     * 命中内存缓存的返回值，不碰磁盘、不做时间判断。过期与否交给
     * `onUnauthorized` 的 401 触发 —— 那才是权威信号，猜时间只会提前失效。
     */
    async tokens() {
      const record = await load()
      return record.tokens ?? undefined
    },

    async saveTokens(tokens) {
      await persist((record) => {
        // SDK 的 `OAuthTokensSchema`（实测 `@modelcontextprotocol/core`）是
        // `{ access_token, id_token?, token_type, expires_in?, scope?, refresh_token?, issuer? }`
        // —— **只有相对秒数 `expires_in`，没有绝对时间**。所以要自己记下「什么时候存的」，
        // 否则面板无法回答「这份令牌还有多久过期」，只能每次都显示「有令牌」。
        record.tokens = tokens ?? null
        record.tokensSavedAt = new Date().toISOString()
        // 拿到新令牌就意味着这轮授权结束，一次性状态要清掉，否则重放会拿到旧 state。
        record.pending = null
        record.codeVerifier = ''
      })
    },

    /**
     * SDK 要求「把用户带到这个 URL」。
     *
     * 我们**不**开浏览器，也不阻塞：DSH 官方登录同样是「复制登录链接 → 用户自己打开」，
     * 而这里若真的去 spawn `open`，在无头/远程场景下会静默失败且无从诊断。
     * 因此只把 URL 交给上层，由面板展示。`flow.js` 负责把 `pending` 记录下来，
     * 以便回调腿校验与超时清理。
     */
    async redirectToAuthorization(authorizationUrl) {
      const href = String(authorizationUrl)
      await persist((record) => {
        record.pending = {
          url: href,
          // `state` 必须与授权 URL 存在同一条记录里：回调腿拿到的 `state` 要跟它比。
          // 分两处存就会出现「URL 存了、state 还是上一轮的」这种最难查的不一致。
          state: issuedState,
          at: new Date().toISOString(),
          expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
        }
      })
      try {
        await onRedirect?.(href)
      } catch (error) {
        log?.warn?.(`dsh-skills-mcp-manager: 记录 ${serverName} 的授权链接失败：${String(error?.message ?? error)}`)
      }
    },

    async saveCodeVerifier(codeVerifier) {
      await persist((record) => {
        record.codeVerifier = typeof codeVerifier === 'string' ? codeVerifier : ''
      })
    },

    async codeVerifier() {
      const record = await load()
      if (record.codeVerifier === '') {
        // SDK 会把这个 message 直接抛给用户，所以写人话：这不是服务器的错。
        throw new Error(`没有为 ${serverName} 保存 PKCE code_verifier —— 授权流程可能已过期，请重新点一次「授权」`)
      }
      return record.codeVerifier
    },

    async saveDiscoveryState(state) {
      await persist((record) => {
        record.discoveryState = state ?? null
      })
    },

    async discoveryState() {
      const record = await load()
      return record.discoveryState ?? undefined
    },

    async saveResourceUrl(resource) {
      await persist((record) => {
        record.resourceUrl = typeof resource === 'string' ? resource : ''
      })
    },
  }

  return { provider, snapshot, invalidate }
}

/** 32 字节的 base64url，纯随机，不依赖 crypto 的模块形态（浏览器/Node 都有 getRandomValues）。 */
export function randomState() {
  const bytes = new Uint8Array(32)
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues !== undefined) {
    cryptoApi.getRandomValues(bytes)
  } else {
    // 退化路径：只有在极端环境下才会走到。`state` 是一次性 + 服务端校验，随机性弱一点
    // 会削弱 CSRF 防护，所以留一条告警而不是悄悄继续。
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  return Buffer.from(bytes).toString('base64url')
}

/** 授权链接是否还在有效期内（面板据此决定「重新授权」还是「继续授权」）。 */
export function pendingIsFresh(record, now = Date.now()) {
  const pending = record?.pending
  if (pending === null || pending === undefined) return false
  const expiresAt = Date.parse(String(pending.expiresAt ?? ''))
  if (!Number.isFinite(expiresAt)) return false
  return expiresAt > now
}

/** 令牌的粗粒度可读状态，供面板显示。 */
export function tokenStatus(record, now = Date.now()) {
  const tokens = record?.tokens
  if (tokens === null || tokens === undefined || typeof tokens.access_token !== 'string' || tokens.access_token === '') {
    return { present: false, refreshable: false, expiresAt: '', expired: false }
  }
  const refreshable = typeof tokens.refresh_token === 'string' && tokens.refresh_token !== ''
  // SDK 只给相对秒数，绝对时间要靠「保存时刻 + expires_in」自己算。两个来源任缺一个就
  // 如实返回空字符串 —— 编一个假时间会让面板显示一个精确但错误的倒计时。
  const savedAt = Date.parse(String(record?.tokensSavedAt ?? ''))
  const expiresIn = Number(tokens.expires_in)
  if (!Number.isFinite(savedAt) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { present: true, refreshable, expiresAt: '', expired: false }
  }
  const expiresAt = savedAt + expiresIn * 1000
  return {
    present: true,
    refreshable,
    expiresAt: new Date(expiresAt).toISOString(),
    expired: expiresAt <= now,
  }
}
