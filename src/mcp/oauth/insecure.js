/**
 * 内网明文 token 端点：一个**默认关闭、必须显式勾选**的例外。
 *
 * ## 为什么需要它
 *
 * SDK 的 `executeTokenRequest` 里有一道无条件的检查：
 *
 * ```js
 * function assertSecureTokenEndpoint(tokenEndpoint) {
 *   const url = new URL(String(tokenEndpoint));
 *   if (url.protocol !== "https:" && !isLoopbackHost(url.hostname))
 *     throw new InsecureTokenEndpointError(url.href);
 * }
 * ```
 *
 * 这是 MCP 授权规范的要求，也是对的：明文 HTTP 上交换令牌等于把 `refresh_token`
 * 广播给同网段任何能嗅探的设备。所以本模块**不修改那道检查**，也不 patch SDK ——
 * SDK 的编排（发现、DCR、PKCE、刷新）继续服务所有 HTTPS 服务器，一行不动。
 *
 * 对于显式勾选「允许明文 token 端点」的服务器，本模块**自己完成最后一步**：
 * 按 RFC 6749 §4.1.3 发一个 `application/x-www-form-urlencoded` 的 POST。
 * 那是整个 OAuth 里最简单的一步（一个表单），自己写比 patch 一个没有公开扩展点的
 * 私有实现更好维护，也让「我们在明文上做了什么」变得可读、可测、可审计。
 *
 * ## 安全边界（三条，缺一不可）
 *
 * 1. **默认关闭**。`allowInsecureTokenEndpoint` 为 `false` 时本模块完全不被调用。
 * 2. **只对显式勾选的服务器生效**。它是每台服务器自己的字段，不存在「全局打开」。
 * 3. **每次明文请求都记一条 warning**。用户可以事后在日志里查到自己开了什么。
 *
 * 它还**不做**这些事（刻意的）：
 *   · 不放宽 SSRF 保护（只影响 token 交换这一个请求）；
 *   · 不影响发现、DCR、authorize —— 那些仍然走 SDK，仍然受它自己的策略约束；
 *   · 不缓存令牌到额外的地方（落盘仍由 `store.js` 负责，权限同样 0600）。
 *
 * ## 不 import 宿主、不 import SDK
 *
 * 纯 `fetch` + 字符串处理，所以能在 CI 上完整单测（CI 上没有宿主 node_modules）。
 */

/** 哪些 token 端点会被 SDK 拒绝？只按 SDK 的判定复刻，不自己发明规则。 */
export function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/**
 * 这个 token 端点会被 SDK 拒绝吗？
 *
 * @param tokenEndpoint - 要检查的 URL 字符串。
 * @returns `{ insecure: true, host }` 当且仅当非 https 且非回环；否则 `{ insecure: false }`。
 *   解析失败也算 `insecure: false`（交给下游按它自己的错误处理，本模块不猜）。
 */
export function insecureTokenEndpoint(tokenEndpoint) {
  let url
  try {
    url = new URL(String(tokenEndpoint))
  } catch {
    return { insecure: false }
  }
  if (url.protocol === 'https:') return { insecure: false }
  // Only http can be "insecure HTTP". A URL like `ftp://…` is not a token endpoint at all,
  // and reporting it as "plaintext http" would hand the caller a wrong reason (it would then
  // offer the user a checkbox that cannot help). Let the network layer reject it instead.
  if (url.protocol !== 'http:') return { insecure: false }
  if (isLoopbackHost(url.hostname)) return { insecure: false }
  return { insecure: true, host: url.host, protocol: url.protocol }
}

/** 换令牌失败的原因取值。 */
export const TOKEN_EXCHANGE_ERRORS = Object.freeze({
  notAllowed: 'insecure-token-endpoint-not-allowed',
  badEndpoint: 'token-endpoint-unresolvable',
  network: 'token-request-failed',
  http: 'token-endpoint-rejected',
  badBody: 'token-response-invalid',
})

/** 人话错误。面板直接展示。 */
export function tokenExchangeErrorText(reason, detail) {
  const tail = typeof detail === 'string' && detail !== '' ? `：${detail}` : ''
  switch (reason) {
    case TOKEN_EXCHANGE_ERRORS.notAllowed:
      return `这台服务器的 token 端点不是 https，而「允许明文 token 端点」没有打开。明文传输令牌会把凭据暴露给同网段，因此默认拒绝${tail}`
    case TOKEN_EXCHANGE_ERRORS.badEndpoint:
      return `拿不到可用的 token 端点地址${tail}`
    case TOKEN_EXCHANGE_ERRORS.network:
      return `请求 token 端点失败${tail}`
    case TOKEN_EXCHANGE_ERRORS.http:
      return `token 端点拒绝了这次请求${tail}`
    case TOKEN_EXCHANGE_ERRORS.badBody:
      return `token 端点返回的内容不是合法令牌${tail}`
    default:
      return `换令牌失败${tail}`
  }
}

/** 把 OAuth 错误响应体里的 `error` / `error_description` 拼成一句可读的话。 */
function describeOAuthError(body) {
  if (body === null || typeof body !== 'object') return ''
  const error = typeof body.error === 'string' ? body.error : ''
  const description = typeof body.error_description === 'string' ? body.error_description : ''
  if (error === '' && description === '') return ''
  if (description === '') return error
  return error === '' ? description : `${error}：${description}`
}

/**
 * 直接向明文 token 端点换令牌。
 *
 * @param options.tokenEndpoint - 授权服务器元数据里的 `token_endpoint`。
 * @param options.params - 要发送的表单字段（已包含 grant_type 等）。
 * @param options.clientId - 公共客户端的 `client_id`（`token_endpoint_auth_method: none`）。
 * @param options.fetchImpl - 注入的 fetch（测试用）。
 * @param options.timeoutMs - 超时，默认 20s。
 * @param options.log - `{ warn }`：**每次调用都要留痕**，这是这个例外的前提条件。
 * @returns `{ ok: true, tokens }` 或 `{ ok: false, reason, detail, text }`。永不抛错。
 */
export async function exchangeInsecureToken({
  tokenEndpoint,
  params,
  clientId,
  fetchImpl,
  timeoutMs = 20000,
  log,
} = {}) {
  let url
  try {
    url = new URL(String(tokenEndpoint))
  } catch (error) {
    return { ok: false, reason: TOKEN_EXCHANGE_ERRORS.badEndpoint, detail: String(error?.message ?? error), text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.badEndpoint) }
  }
  const gate = insecureTokenEndpoint(url.href)
  if (gate.insecure !== true) {
    // Not an insecure endpoint: the caller should have used the SDK's own path. Refusing
    // here keeps this module from silently becoming a second, divergent token implementation
    // for HTTPS servers (two implementations drift; that has already cost this repo once).
    return {
      ok: false,
      reason: TOKEN_EXCHANGE_ERRORS.badEndpoint,
      detail: `该端点不需要明文例外（${url.href}）`,
      text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.badEndpoint),
    }
  }

  // The audit line. This is not decoration: it is the only way a user can find out later
  // that credentials for this server travelled in cleartext.
  log?.warn?.(`dsh-skills-mcp-manager: 正在向**明文** token 端点发送凭据（${url.origin}）—— 这台服务器勾选了「允许明文 token 端点」`)

  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue
    form.set(key, String(value))
  }
  // Public client: no secret, so `client_id` rides the form body (RFC 6749 §2.3.1 allows
  // this for clients that cannot keep a secret).
  if (typeof clientId === 'string' && clientId !== '') form.set('client_id', clientId)

  const fetchToUse = fetchImpl ?? globalThis.fetch
  if (typeof fetchToUse !== 'function') {
    return { ok: false, reason: TOKEN_EXCHANGE_ERRORS.network, detail: 'no fetch available', text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.network) }
  }
  let signal
  try {
    signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined
  } catch {
    signal = undefined
  }

  let response
  try {
    response = await fetchToUse(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      signal,
    })
  } catch (error) {
    return { ok: false, reason: TOKEN_EXCHANGE_ERRORS.network, detail: String(error?.message ?? error), text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.network) }
  }

  let body = null
  try {
    body = await response.json()
  } catch (error) {
    // A non-JSON body is a protocol violation, but the HTTP status still carries meaning.
    if (!response.ok) {
      return {
        ok: false,
        reason: TOKEN_EXCHANGE_ERRORS.http,
        detail: `HTTP ${response.status}`,
        text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.http, `HTTP ${response.status}`),
      }
    }
    return { ok: false, reason: TOKEN_EXCHANGE_ERRORS.badBody, detail: String(error?.message ?? error), text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.badBody) }
  }

  if (!response.ok) {
    const reason = describeOAuthError(body)
    const detail = reason === '' ? `HTTP ${response.status}` : `HTTP ${response.status} ${reason}`
    return { ok: false, reason: TOKEN_EXCHANGE_ERRORS.http, detail, text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.http, detail) }
  }

  const tokens = validateTokens(body)
  if (tokens === null) {
    return { ok: false, reason: TOKEN_EXCHANGE_ERRORS.badBody, detail: 'access_token 缺失或不是字符串', text: tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.badBody) }
  }
  return { ok: true, tokens }
}

/**
 * 把令牌响应收敛成 SDK 期望的形状。
 *
 * 只保留 SDK 的 `OAuthTokensSchema` 认识、且我们确实要用的字段 —— 抛掉未知字段，避免
 * 把服务器返回的意外内容一路写进凭据文件。
 *
 * @param body - 解析后的 JSON。
 * @returns 令牌对象，或 null（不是合法令牌）。
 */
export function validateTokens(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const accessToken = body.access_token
  if (typeof accessToken !== 'string' || accessToken === '') return null
  const tokens = {
    access_token: accessToken,
    token_type: typeof body.token_type === 'string' && body.token_type !== '' ? body.token_type : 'Bearer',
  }
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') tokens.refresh_token = body.refresh_token
  if (typeof body.scope === 'string' && body.scope !== '') tokens.scope = body.scope
  // `expires_in` 是**相对秒数**（SDK 的 schema 就是这么定义的）。字符串数字也收，
  // 有些服务器会把 JSON 数字发成字符串。
  const expiresIn = Number(body.expires_in)
  if (Number.isFinite(expiresIn) && expiresIn > 0) tokens.expires_in = expiresIn
  if (typeof body.issuer === 'string' && body.issuer !== '') tokens.issuer = body.issuer
  return tokens
}
