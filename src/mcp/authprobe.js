/**
 * 鉴权挑战的**探测**：向服务器发一次轻量 HTTP 请求，看它是否在要求授权。
 *
 * ## 为什么不能复用现有的连接探测
 *
 * `src/mcp/probe.js` 走的是 `mcpResources.request()`，而客户端在未连接时会在**发出请求前**
 * 就抛 "server is disconnected" —— 连 HTTP 层都到不了，自然看不到 401。所以识别鉴权挑战
 * 必须自己发一次请求。
 *
 * ## 为什么用 POST + `initialize` 探，而不是随便 GET 一下
 *
 * Streamable HTTP 的 MCP 端点对 GET/HEAD 的回答五花八门（405、404、SSE 流），拿它判鉴权
 * 会把「不支持 GET」误读成「需要授权」。MCP 规定鉴权发生在**协议层之前**：服务器必须先
 * 通过鉴权，才谈得上处理 `initialize`。所以发一个合法的 `initialize` 才是能稳定拿到
 * 401/403 的探法 —— 也正是 SDK 自己在版本协商探测阶段做的事（它把 401 归类为
 * `ClientHttpAuthentication`，并把「无 authProvider 时的 401」记成
 * "the server requires authorization (HTTP 401)"）。
 *
 * ## 边界
 *
 * · 只对 `streamable-http` 有意义；stdio 没有 HTTP 状态码，直接返回 null。
 * · **绝不抛错**：任何异常都收敛成 null（= 没观测到挑战），让面板回落到原本的重试推导。
 *   一个探测器的 bug 不该变成界面上的一句假话。
 * · 超时短（默认 6s）：这是给状态标签用的，不能拖住 publish。
 * · 不发送任何凭据之外的东西；`headers` 来自用户自己的配置（那里可能就是 Authorization）。
 */

import { classifyAuthChallenge } from './auth.js'

/** 探测默认超时：够慢服务器回一次话，又不至于拖住状态标签。 */
const DEFAULT_AUTH_PROBE_TIMEOUT_MS = 6000

/** 一次 `initialize` 请求的最小合法形状。 */
function initializeBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'dsh-skills-mcp-manager-auth-probe',
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-skills-mcp-manager', version: '0' },
    },
  })
}

/**
 * 建一个鉴权探测器。
 *
 * @param log - `{ warn }`，用于必须上报而不是抛出的路径。
 * @returns `{ probe }`；`probe()` 永不抛错。
 */
export function createAuthProbe(log) {
  return {
    /**
     * 问一次「这台服务器是不是在要求授权」。
     *
     * @param server - `{ transport, url, headers }`；`headers` 是 KEY=VALUE 的行文本。
     * @param options.timeoutMs - 超时。
     * @param options.fetchImpl - 注入的 fetch（测试用）。
     * @returns `{ kind, scope, resourceMetadataUrl, error, errorDescription }` 或 null。
     *   null 同时表示「不是鉴权问题」与「没能判断」—— 两者在界面上都回落成原本的推导，
     *   所以不需要再分一层；真正需要区分的是「确定要授权」，那才单独给状态。
     */
    probe: async (server, options = {}) => {
      const transport = String(server?.transport ?? '')
      const url = String(server?.url ?? '')
      // stdio 没有 HTTP 状态码；空 URL 也无从探起。
      if (transport !== 'streamable-http' || url === '') return null
      let endpoint
      try {
        endpoint = new URL(url)
      } catch {
        return null
      }
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return null
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_AUTH_PROBE_TIMEOUT_MS
      const fetchImpl = options.fetchImpl ?? globalThis.fetch
      if (typeof fetchImpl !== 'function') return null
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
        response = await fetchImpl(endpoint, {
          method: 'POST',
          // Built with a case-insensitive merge: HTTP header names are case-insensitive, so
          // emitting both `accept` and `Accept` (a user who capitalises it) hands fetch two
          // conflicting values whose winner depends on iteration order. User configuration
          // wins over the defaults — it is what the real connection sends.
          headers: mergeHeaders(
            {
              'content-type': 'application/json',
              // MCP requires the client to accept both, or a server may legitimately refuse.
              accept: 'application/json, text/event-stream',
            },
            server?.headers,
          ),
          body: initializeBody(),
          signal,
        })
      } catch (error) {
        // 网络错误／超时／被中止：都没有状态码可判，如实收敛成「没观测到」。
        log?.warn?.(`dsh-skills-mcp-manager: auth probe of ${String(server?.serverName ?? url)} failed: ${String(error?.message ?? error)}`)
        return null
      }
      const status = response?.status
      const wwwAuthenticate = typeof response?.headers?.get === 'function'
        ? response.headers.get('WWW-Authenticate')
        : null
      const challenge = classifyAuthChallenge({ status, wwwAuthenticate })
      // 不管结果如何都要把响应体读掉，否则连接不会释放（Node 的 fetch 会保持连接）。
      try {
        await response?.body?.cancel?.()
      } catch {
        // 取消失败不影响结论。
      }
      return challenge
    },
  }
}

/**
 * Defaults plus the user's KEY=VALUE header lines, merged case-insensitively.
 *
 * HTTP header names are case-insensitive, so a plain object spread is wrong: a user who
 * writes `Accept=text/plain` would produce both `accept` and `Accept` in the same request,
 * and which one the server sees depends on iteration order. The user's value wins, because
 * it is what the configured connection actually sends; malformed lines are skipped rather
 * than throwing.
 */
function mergeHeaders(defaults, text) {
  const out = { ...defaults }
  const written = new Map(Object.keys(defaults).map((key) => [key.toLowerCase(), key]))
  if (typeof text !== 'string' || text.trim() === '') return out
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (key === '') continue
    const lower = key.toLowerCase()
    const previous = written.get(lower)
    // Replace the earlier spelling rather than adding a second key for the same header.
    if (previous !== undefined && previous !== key) delete out[previous]
    written.set(lower, key)
    out[key] = value
  }
  return out
}
