/**
 * 「需要授权」的识别：把 HTTP 401/403 的鉴权挑战读成一个状态，而不是一次故障。
 *
 * ## 为什么必须单独识别
 *
 * 受 OAuth 保护的 MCP 服务器在未授权时**拒绝连接**，这是协议规定的正常行为，
 * 不是服务器坏了。但 `@deepseek-ai/dsh-mcp-client` 完全没有 OAuth 支持
 * （整份 lib/index.js 里没有任何 `authProvider`／`oauth` 字样，`createTransport`
 * 只传 `requestInit.headers`），于是 SDK 的 401 处理分支
 * （`if (response.status === 401 && this._authProvider)`）永远不成立，
 * 直接落到 `throw new UnauthorizedError()`（streamable-http 路径见
 * `@modelcontextprotocol/client/dist/index.mjs` 的 `_send`）。客户端随后按普通网络
 * 故障重试、预算耗尽后**永久放弃** —— 面板上只会显示「未连接 · 重试中」→「已放弃重试」，
 * 把「你去授权一下就好」说成了「这台服务器坏了」。
 *
 * ## 信号从哪来
 *
 * 会话协议（MCP 2025-06-18 起，配合 RFC 9728）要求资源服务器在 401 上带
 * `WWW-Authenticate: Bearer ...` 挑战，并可用 `resource_metadata` 指向受保护资源元数据、
 * 用 `scope` 声明所需范围。`insufficient_scope` 的 403 是同一族语义（已授权但范围不够）。
 * 这些字段是**协议级的**，所以不依赖客户端实现，直接读 HTTP 响应即可。
 *
 * 探测走的是 `mcpResources`（见 probe.js），而它在客户端未连接时会在**发出请求前**就抛
 * "server is disconnected" —— 也就是说 401 根本到不了那一层。因此识别必须自己发一次
 * 轻量 HTTP 请求（见 src/index.js 的 refreshAuthProbe），这里只做纯粹的解析与判定。
 *
 * ## 判定方向
 *
 * 只认「明确的鉴权挑战」：401 + Bearer 挑战，或 403 + `error="insufficient_scope"`。
 * 其它一切（405、404、超时、网络错误、非 Bearer 的挑战）都返回 null —— 即不下结论，
 * 面板回落到原本的重试/放弃推导。这样即使探测方式对某台服务器不适用，最坏结果也只是
 * 维持现状，而不会凭空给一台真故障的服务器贴上「需要授权」。
 *
 * 纯函数、不 import 宿主，便于直接单测。
 */

/** 两类鉴权挑战。语义不同，但对用户的动作都是「去补授权」。 */
export const AUTH_KIND = Object.freeze({
  /** 401 + Bearer 挑战：尚未授权（或凭据失效）。 */
  required: 'required',
  /** 403 + `error="insufficient_scope"`：已授权但范围不够，需要 step-up。 */
  insufficientScope: 'insufficient-scope',
})

/**
 * 解析 `WWW-Authenticate` 挑战头。
 *
 * 逐字对齐 `@modelcontextprotocol/client` 的 `extractWWWAuthenticateParams`：
 * 只认 `Bearer`（大小写不敏感）且必须带 scheme 参数；字段值允许带引号或不带引号。
 * 认不出的头返回 null，而不是一个空壳对象 —— 调用方据此区分「没有挑战」与「挑战不完整」。
 *
 * @param value - `WWW-Authenticate` 头的原始值（可能为 null）。
 * @returns `{ scheme, resourceMetadataUrl, scope, error, errorDescription }` 或 null。
 */
export function parseWwwAuthenticate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const [type, scheme] = value.trim().split(/\s+/)
  if (String(type ?? '').toLowerCase() !== 'bearer' || !scheme) return null
  const field = (name) => {
    const match = value.match(new RegExp(`${name}=(?:"([^"]+)"|([^\\s,]+))`))
    const result = match?.[1] || match?.[2]
    return typeof result === 'string' && result !== '' ? result : ''
  }
  const resourceMetadataUrl = field('resource_metadata')
  return {
    scheme: String(scheme),
    resourceMetadataUrl,
    scope: field('scope'),
    error: field('error'),
    errorDescription: field('error_description'),
  }
}

/**
 * 把一次 HTTP 响应判成鉴权挑战。
 *
 * @param input.status - HTTP 状态码（任何非数字都视为「不是挑战」）。
 * @param input.wwwAuthenticate - `WWW-Authenticate` 头（可能为 null）。
 * @returns `{ kind, scope, resourceMetadataUrl, error, errorDescription }` 或 null。
 */
export function classifyAuthChallenge(input) {
  const status = Number(input?.status)
  const challenge = parseWwwAuthenticate(input?.wwwAuthenticate)
  if (status === 401) {
    // 401 而没有可解析的 Bearer 挑战：仍然是一次鉴权拒绝，但拿不到 scope/元数据。
    // 保留为 required，因为状态码本身已经是协议级的明确信号。
    return {
      kind: AUTH_KIND.required,
      scope: challenge?.scope ?? '',
      resourceMetadataUrl: challenge?.resourceMetadataUrl ?? '',
      error: challenge?.error ?? '',
      errorDescription: challenge?.errorDescription ?? '',
    }
  }
  // 注意 `insufficient_scope` 是**下划线**的协议取值，而 {@link AUTH_KIND} 用连字符做面板
  // 取值；两者不能混用，所以这里比对协议原文，转换只发生在返回的结构里。
  if (status === 403 && challenge?.error === 'insufficient_scope') {
    return {
      kind: AUTH_KIND.insufficientScope,
      scope: challenge.scope,
      resourceMetadataUrl: challenge.resourceMetadataUrl,
      error: challenge.error,
      errorDescription: challenge.errorDescription,
    }
  }
  return null
}

/**
 * 给用户看的一句话说明。
 *
 * 措辞必须把「这不是故障」说出来：用户看到标签时的默认假设是「服务器坏了」，
 * 而这里要传达的恰恰相反 —— 补一次授权就能恢复。
 *
 * @param kind - {@link AUTH_KIND} 之一。
 * @param info - `{ scope, errorDescription }`，可选。
 * @returns 中文说明文本。
 */
export function authDetailText(kind, info) {
  const scope = typeof info?.scope === 'string' && info.scope !== '' ? info.scope : ''
  const described = typeof info?.errorDescription === 'string' && info.errorDescription !== '' ? info.errorDescription : ''
  if (kind === AUTH_KIND.insufficientScope) {
    const base = '已连接但授权范围不足，需要补充授权（不是故障）'
    if (described !== '') return `${base}：${described}`
    return scope === '' ? base : `${base}：需要 ${scope}`
  }
  const base = '服务器要求先授权（OAuth）才能连接，这不是故障'
  if (described !== '') return `${base}：${described}`
  return scope === '' ? base : `${base}：需要 ${scope} 范围`
}
