/**
 * OAuth 回调路由：`GET /<name>/oauth/callback?code=…&state=…`。
 *
 * ## 为什么挂在 `webServer` 上而不是自己起 http 服务
 *
 * 自己 `createServer` 就得挑端口、处理占用（Pi 的实现在固定端口模式下 EADDRINUSE 直接
 * 硬失败）、再操心进程退出。DSH 的 `webServer` 已经在监听，`register()` 给的是
 * `(req, res)` 直通 —— DSH 自己的账号平台就是这么跑完整 PKCE 授权的
 * （`dsh-deepseek-account-platform/lib/index.js:991`，路由 `/oauth/callback`）。
 *
 * 另一个好处是**同源**：`redirect_uri` 就是 `http://127.0.0.1:<webServer 端口>/…`，
 * 与面板同源，浏览器里的回调页可以直接提示「回到 DSH 面板」。
 *
 * ## 安全
 *
 * 这条路由**不需要 `connection.requestRejection`**，也不该要：OAuth 的 `redirect_uri`
 * 会带上授权服务器发回来的一次性 `code`，浏览器跳转过来时**不会**带 DSH 的浏览器鉴权
 * cookie（那是应用自己的会话，不是浏览器会话的通用凭据）。加了那道检查，唯一结果就是
 * 每次回调都被 401 掉，授权永远完不成。
 *
 * 因此安全边界完全落在 `state` 上（见 `state.js`）：定长比较 + 一次性 + 10 分钟超时。
 * 另外三条也被钉住：
 *   · **只接受 GET**（授权码流程规定的是 302 跳转）；
 *   · `state` 与 `code` 必须**各自恰好出现一次** —— 重复参数是绕过「取第一个」这类
 *     实现的经典手法；
 *   · 永远不会把 `code` 或任何令牌写进响应体或日志。
 */
import { NAME } from '../../identity.js'
import { AUTH_CHANNEL, AUTH_DONE } from './channel.js'
import { flowReasonText } from './flow.js'
import { singleParams } from './state.js'

/** 回调路径。`redirect_uri` 由 Host 用 `webServer.getOrigin()` + 它拼出。 */
export const CALLBACK_PATH = `/${NAME}/oauth/callback`

/** 回调页的极小内联样式：不引外部资源，离线也能看。 */
const PAGE_STYLE = 'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:48px;color:#1f2328;background:#fff}' +
  'h1{font-size:18px;margin:0 0 12px}p{margin:0 0 8px;color:#57606a}code{background:#f6f8fa;padding:2px 6px;border-radius:4px}'

/**
 * 渲染一个中性的结果页。永远不把 code/令牌放进页面。
 *
 * @param script - 可选的内联脚本（只有成功页用它：广播一声「授权完成了」）。
 *   刻意不给错误页 —— 失败时说「成功了」会让面板白刷一次。
 */
function page(title, message, script = '') {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    `<title>${title}</title><style>${PAGE_STYLE}</style></head><body>` +
    `<h1>${title}</h1>${message}${script}</body></html>`
}

/**
 * 通知面板「授权完成了」。
 *
 * 回调页和面板是**同源**的（同一个 webServer），所以 `BroadcastChannel` 可以直接把
 * 面板从 5 秒的轮询里叫醒。没有它的话，用户在浏览器里点完同意、切回面板，卡片还会
 * 停在「需要授权」上最多 5 秒 —— 那几秒里什么都没发生，看起来就像没生效。
 *
 * `BroadcastChannel` 不存在时（老浏览器）静默跳过：面板的轮询仍然会把状态带到正确值，
 * 这只是把「快」加上去，不该成为正确性的前提。
 */
const NOTIFY_SCRIPT = '<script>(function(){try{' +
  `var c=new BroadcastChannel(${JSON.stringify(AUTH_CHANNEL)});` +
  `c.postMessage(${JSON.stringify(AUTH_DONE)});c.close();` +
  '}catch(e){}})();</script>'

function sendHtml(res, status, title, message, script = '') {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  // `no-store`：回调整页可能带着一次性 code，不能被任何缓存留下。
  res.setHeader('cache-control', 'no-store')
  res.end(page(title, message, script))
}

/**
 * 注册回调路由。
 *
 * @param ctx - 带 `webServer` 的 cordis 上下文。
 * @param options.path - 回调路径（默认 {@link CALLBACK_PATH}）。
 * @param options.servers - `() => [{ serverName, transport, url }]`，当前所有
 *   streamable-http 服务器。回调里**没有**服务器名，所以要用 `state` 反查是哪一台：
 *   做法是逐个比对（每台的 `pending.state` 都是独立随机值，定长比较，不会泄漏）。
 * @param options.flow - `createOAuthFlow()` 的返回值。
 * @param options.onAuthorized - 授权成功后的回调，宿主用它刷新状态/重建连接。
 * @param options.snapshot - `() => Map<serverName, { ... }>`，把结果留给面板显示。
 * @param options.log - `{ warn }`。
 * @returns `{ installed, reason }`，装不上时如实说。
 */
export function registerOAuthCallback(ctx, options = {}) {
  const {
    path = CALLBACK_PATH,
    servers,
    flow,
    onAuthorized,
    snapshot,
    log,
  } = options
  const record = snapshot?.()
  const remember = (serverName, result) => {
    if (record === undefined || record === null) return
    try {
      record.set(serverName, result)
    } catch {
      // 记不住不影响授权本身。
    }
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        let url
        try {
          url = new URL(req.url ?? '/', 'http://127.0.0.1')
        } catch {
          sendHtml(res, 400, '回调地址不正确', '<p>无法解析这个地址。</p>')
          return
        }
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.setHeader('cache-control', 'no-store')
          res.end()
          return
        }
        const params = singleParams(url.searchParams)
        if (params.error !== '') {
          // 授权服务器拒绝了（用户点了取消，或 scope 不被接受）。如实展示原因。
          const reason = params.errorDescription === '' ? params.error : `${params.error}：${params.errorDescription}`
          sendHtml(res, 400, '授权未完成', `<p>授权服务器返回了错误：</p><p><code>${escapeHtml(reason)}</code></p><p>可以回到 DSH 面板重试。</p>`)
          return
        }
        if (params.ok !== true) {
          sendHtml(res, 400, '回调地址不正确', '<p>缺少 <code>code</code> 或 <code>state</code>，或者参数重复。</p>')
          return
        }

        // 反查是哪台服务器发起的：state 是各服务器独立的随机值。
        const candidates = typeof servers === 'function' ? servers() : []
        let matched = null
        let lastReason = ''
        for (const server of candidates) {
          if (String(server?.transport ?? '') !== 'streamable-http') continue
          const serverName = String(server?.serverName ?? '')
          if (serverName === '') continue
          const checked = await flow.checkCallback(serverName, params.state, params.code)
          if (checked.ok === true) {
            matched = { server, code: checked.code }
            break
          }
          // 记住最后一个「有进行中的授权但 state 不符」，用于给出最贴近事实的一句提示。
          if (checked.reason !== 'no-authorization-in-progress') lastReason = String(checked.reason ?? '')
        }
        if (matched === null) {
          const text = flowReasonText(lastReason === '' ? 'no-authorization-in-progress' : lastReason)
          sendHtml(res, 400, '授权未完成', `<p>${escapeHtml(text)}</p>`)
          return
        }

        const serverName = String(matched.server.serverName)
        const done = await flow.complete(serverName, String(matched.server.url ?? ''), matched.code)
        if (done.ok !== true) {
          remember(serverName, { ok: false, reason: done.reason, text: done.text, detail: done.detail, at: new Date().toISOString() })
          log?.warn?.(`dsh-skills-mcp-manager: ${serverName} 的授权回调无法完成：${String(done.detail || done.reason)}`)
          sendHtml(res, 502, '授权未完成', `<p>${escapeHtml(done.text)}</p>` +
            (done.detail === '' ? '' : `<p><code>${escapeHtml(done.detail)}</code></p>`))
          return
        }

        remember(serverName, { ok: true, reason: '', text: '授权完成', detail: '', at: new Date().toISOString(), ...done })
        /**
         * 文案已经不需要「点一次重连」了：Host 现在会自动重连（见 onAuthorized），
         * 面板也会被下面那个广播叫醒。留着一句用户不必做的指令，只会让人以为坏了。
         */
        sendHtml(res, 200, '授权完成', `<p><strong>${escapeHtml(serverName)}</strong> 已授权，正在回到 DSH 建立连接。</p>` +
          '<p>可以关闭这个页面了。</p>', NOTIFY_SCRIPT)
        try {
          await onAuthorized?.(serverName)
        } catch (error) {
          // 刷新失败不该把一次成功的授权标成失败。
          log?.warn?.(`dsh-skills-mcp-manager: 授权成功后刷新状态失败：${String(error?.message ?? error)}`)
        }
      },
    }), 'dsh-skills-mcp-manager.oauth.callback')

    return { installed: true, reason: '' }
  } catch (error) {
    // `webServer.register` 对重复 (kind, path) 抛错。HMR 重载时旧 effect 会先被释放，
    // 正常不会撞；真撞上就如实上报，而不是让插件加载失败。
    const reason = String(error?.message ?? error)
    log?.warn?.(`dsh-skills-mcp-manager: 注册 OAuth 回调路由失败：${reason}`)
    return { installed: false, reason }
  }
}

/** 极小的 HTML 转义：页面里出现的都是服务器名与错误文本，必须挡住注入。 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
