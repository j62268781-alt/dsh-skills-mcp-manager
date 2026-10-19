/**
 * mcp/oauth/flow 与 callback：发起/完成授权、回调参数的判定。
 *
 * 用假 SDK 驱动整条流程 —— 真 SDK 的 OAuth 编排在 CI 上装不到，而且我们要钉的是
 * **适配层**：两段式调用（发起 / 完成）、`REDIRECT` 被当成正常结果、`state` 一次性、
 * 以及「回调路由不能要求 DSH 会话 cookie」这条安全前提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOAuthStore, emptyRecord } from '../src/mcp/oauth/store.js'
import { createOAuthProvider } from '../src/mcp/oauth/provider.js'
import { FLOW_ERRORS, createOAuthFlow, flowReasonText } from '../src/mcp/oauth/flow.js'
import { CALLBACK_PATH, escapeHtml, registerOAuthCallback } from '../src/mcp/oauth/callback.js'

const noopLog = { warn: () => {}, info: () => {} }

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'smp-oauth-flow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A fake SDK that models the two-leg shape of the real `auth()`.
 *
 * `auth()` with no `authorizationCode` → the "begin" leg: it calls
 * `provider.redirectToAuthorization()` then returns `'REDIRECT'`.
 * `auth()` with a code → the "complete" leg: it saves tokens and returns `'AUTHORIZED'`.
 *
 * The state that must survive between the two legs (`codeVerifier`, `discoveryState`) lives
 * in the provider, which is exactly the property being tested.
 */
function fakeSdk({ beginKind = 'redirect', failBegin = null, failComplete = null } = {}) {
  const calls = []
  return {
    calls,
    sdk: {
      async auth(provider, options) {
        calls.push({ hasCode: typeof options.authorizationCode === 'string', serverUrl: String(options.serverUrl) })
        if (typeof options.authorizationCode === 'string') {
          if (failComplete !== null) throw failComplete
          await provider.saveTokens({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' })
          return 'AUTHORIZED'
        }
        if (failBegin !== null) throw failBegin
        if (beginKind === 'authorized') {
          await provider.saveTokens({ access_token: 'cached', token_type: 'Bearer' })
          return 'AUTHORIZED'
        }
        // Real SDK order: state() → startAuthorization → saveCodeVerifier → redirectToAuthorization
        await provider.state()
        await provider.saveCodeVerifier('verifier-from-sdk')
        await provider.redirectToAuthorization(new URL('https://as.example.com/authorize?client_id=cid&state=s'))
        return 'REDIRECT'
      },
    },
  }
}

function makeFlow({ home, sdk, t, onRedirect }) {
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({
      store, serverName, url, redirectUri: 'http://127.0.0.1:1/dsh-skills-mcp-manager/oauth/callback', onRedirect, log: noopLog,
    }),
    log: noopLog,
  })
  return { store, flow }
}

test('begin：REDIRECT 是正常结果，返回授权 URL', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  const result = await flow.begin('github', 'https://api.example.com/mcp')
  assert.equal(result.kind, 'redirect', JSON.stringify(result))
  assert.equal(result.authorizeUrl, 'https://as.example.com/authorize?client_id=cid&state=s')
  assert.equal(result.ok, undefined, 'begin 的结果用 kind 表达，不混用 ok')
})

test('begin：已有可用令牌时直接 authorized，不打扰用户', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk({ beginKind: 'authorized' })
  const { flow } = makeFlow({ home, sdk, t })
  const result = await flow.begin('github', 'https://api.example.com/mcp')
  assert.equal(result.kind, 'authorized')
  assert.equal(result.present, true)
})

test('begin：SDK 不可用时返回 noSdk 与原因，不抛错', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({ store, getSdk: () => ({ ok: false, reason: 'x', detail: 'no sdk' }), makeProvider: () => ({}), log: noopLog })
  const result = await flow.begin('github', 'https://api.example.com/mcp')
  assert.equal(result.kind, 'error')
  assert.equal(result.reason, FLOW_ERRORS.noSdk)
  assert.match(result.text, /OAuth 支持未安装/)
})

test('begin：非 http(s) 与空 URL 被拒（stdio 没有 HTTP 状态码）', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  for (const [url, reason] of [['', FLOW_ERRORS.noUrl], ['not a url', FLOW_ERRORS.noUrl], ['stdio://x', FLOW_ERRORS.notHttp]]) {
    const result = await flow.begin('github', url)
    assert.equal(result.kind, 'error', url)
    assert.equal(result.reason, reason, url)
  }
})

test('begin：SDK 抛错收敛成 beginFailed，附带原文', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk({ failBegin: Object.assign(new Error('registration missing'), { code: 'invalid_client' }) })
  const { flow } = makeFlow({ home, sdk, t })
  const result = await flow.begin('github', 'https://api.example.com/mcp')
  assert.equal(result.kind, 'error')
  assert.equal(result.reason, FLOW_ERRORS.beginFailed)
  assert.match(result.detail, /registration missing/)
  assert.match(result.detail, /invalid_client/, '错误码要留下，否则排查只能靠猜')
})

test('begin → complete：两段式能跑通，令牌落盘', async (t) => {
  const home = await tempHome(t)
  const { sdk, calls } = fakeSdk()
  const { flow, store } = makeFlow({ home, sdk, t })
  const begun = await flow.begin('github', 'https://api.example.com/mcp')
  assert.equal(begun.kind, 'redirect')
  // 回调腿：先校验 state（从磁盘里读），再用 code 完成
  const record = await store.read('github')
  const checked = await flow.checkCallback('github', record.pending.state, 'code-abc')
  assert.equal(checked.ok, true, JSON.stringify(checked))
  const done = await flow.complete('github', 'https://api.example.com/mcp', checked.code)
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.present, true)
  assert.equal(done.refreshable, true)
  // 两段都真的调了 SDK，且第二次带 code
  assert.equal(calls.length, 2)
  assert.equal(calls[0].hasCode, false)
  assert.equal(calls[1].hasCode, true)
  // 令牌真的落盘了
  const saved = await store.read('github')
  assert.equal(saved.tokens.access_token, 'access-1')
  assert.equal(saved.tokens.refresh_token, 'refresh-1')
  assert.equal(saved.pending, null, '完成后要清掉一次性状态')
})

test('checkCallback：state 不匹配时拒绝（伪造回调）', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  await flow.begin('github', 'https://api.example.com/mcp')
  const wrong = await flow.checkCallback('github', 'not-the-state', 'code-abc')
  assert.equal(wrong.ok, false)
  assert.equal(wrong.reason, FLOW_ERRORS.stateMismatch)
})

test('checkCallback：没有进行中的授权时拒绝', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  const result = await flow.checkCallback('github', 'anything', 'code')
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.noPending)
})

test('checkCallback：超过 10 分钟的授权请求算过期', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow, store } = makeFlow({ home, sdk, t })
  await flow.begin('github', 'https://api.example.com/mcp')
  const record = await store.read('github')
  const wayLater = Date.now() + 11 * 60 * 1000
  const result = await flow.checkCallback('github', record.pending.state, 'code', wayLater)
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.expired)
})

test('checkCallback：缺 code 或 state 时拒绝', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow, store } = makeFlow({ home, sdk, t })
  await flow.begin('github', 'https://api.example.com/mcp')
  const record = await store.read('github')
  assert.equal((await flow.checkCallback('github', record.pending.state, '')).reason, FLOW_ERRORS.completeFailed)
  assert.equal((await flow.checkCallback('github', '', 'code')).reason, FLOW_ERRORS.stateMismatch)
})

test('complete：PKCE code_verifier 必须在两段之间存活', async (t) => {
  // 这条钉的是「完成时必须复用同一个 provider 实例」。新建一个 provider 就读不到
  // code_verifier，SDK 会报「没有保存 code_verifier」——真实错误信息离原因很远。
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow, store } = makeFlow({ home, sdk, t })
  await flow.begin('github', 'https://api.example.com/mcp')
  const record = await store.read('github')
  assert.equal(record.codeVerifier, 'verifier-from-sdk', 'code_verifier 必须落在磁盘上')
  const done = await flow.complete('github', 'https://api.example.com/mcp', 'code-abc')
  assert.equal(done.ok, true, JSON.stringify(done))
})

test('complete：SDK 抛错收敛成 completeFailed，带上错误码', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk({ failComplete: Object.assign(new Error('bad verifier'), { code: 'invalid_grant' }) })
  const { flow } = makeFlow({ home, sdk, t })
  const result = await flow.complete('github', 'https://api.example.com/mcp', 'code-abc')
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.completeFailed)
  assert.match(result.detail, /bad verifier/)
  assert.match(result.detail, /invalid_grant/)
})

test('providerFor：同一台服务器只给一个实例（两份缓存会让授权静默失效）', async (t) => {
  // 这条钉的是一个真出过的 bug：宿主侧 oauthLookup 曾经自己 makeProvider 一个新的，
  // 而 flow 用的是它 Map 里的另一个。于是授权完成后 flow.complete() 把令牌写进它那份缓存，
  // transport 仍在读自己那份「没有令牌」的快照 —— 服务器永远 401，而面板显示「已授权」。
  // 失败无声、现象矛盾，是最难查的一类。
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  const first = flow.providerFor('github', 'https://api.example.com/mcp')
  const second = flow.providerFor('github', 'https://api.example.com/mcp')
  assert.equal(first, second, '同一 (serverName, url) 必须返回同一个实例')
  assert.equal(first.provider, second.provider, 'provider 本身也要是同一个')

  // URL 变了要给新实例：旧凭据可能属于旧服务器。
  const moved = flow.providerFor('github', 'https://other.example.com/mcp')
  assert.notEqual(moved, first, 'URL 变更必须换实例')

  // 通过一个实例写入的令牌，另一个读得到（因为它们本来就是同一个）。
  await first.provider.saveTokens({ access_token: 'shared-token', token_type: 'Bearer' })
  const tokens = await second.provider.tokens()
  assert.equal(tokens.access_token, 'shared-token', '共享实例才能让 transport 看到 flow 写下的令牌')
})

test('providerFor：forget 只丢内存实例；真正的登出还必须删盘上的凭据', async (t) => {
  // 两个动作是分开的，这里把区别钉住：
  //   · `forget()` 只丢内存缓存 —— 新实例会从磁盘重新读，所以**令牌仍在**，这是对的：
  //     它的用途是「凭据可能变了，重新读一次」，不是登出。
  //   · `logout()` 才删磁盘文件，此后新实例读不到任何东西。
  // 曾经想过让 forget 就清空令牌，那样会让一次普通的缓存失效变成静默登出。
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  const before = flow.providerFor('github', 'https://api.example.com/mcp')
  await before.provider.saveTokens({ access_token: 'persisted', token_type: 'Bearer' })

  flow.forget('github')
  const reloaded = flow.providerFor('github', 'https://api.example.com/mcp')
  assert.notEqual(reloaded, before, 'forget 之后必须是新实例')
  assert.equal((await reloaded.provider.tokens()).access_token, 'persisted', '磁盘上的凭据还在，新实例应该读得到')

  await flow.logout('github')
  const afterLogout = flow.providerFor('github', 'https://api.example.com/mcp')
  assert.equal(await afterLogout.provider.tokens(), undefined, 'logout 删了盘上的凭据，之后读到 undefined')
})

test('complete：非回环 http 端点且未开例外时，给出明确原因而不是 SDK 的晦涩报错', async (t) => {
  // 这条钉住的是「用户看得懂」。SDK 抛的是 InsecureTokenEndpointError（一句话，
  // 且不提我们自己的开关）；这里要给出「哪个开关、在哪台服务器上」。
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => false,
    log: noopLog,
  })
  // 先造一份 discoveryState，把 token_endpoint 指向内网明文地址（真实流程里由发现阶段写入）
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.clientInformation = { client_id: 'cid', redirect_uris: ['http://127.0.0.1:1/cb'] }
    record.codeVerifier = 'verifier'
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
  })
  const result = await flow.complete('gitnexus', 'http://sz-00575123-01/mcp/coding', 'the-code')
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.insecureNotAllowed)
  assert.match(result.text, /允许明文 token 端点/, '要指出是哪个开关，否则用户不知道去哪找')
  assert.match(result.detail, /oauth\/token/, '要把出问题的端点写出来')
})

test('complete：开了例外就走自己的交换，令牌落盘且带 refresh_token', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: (serverName) => serverName === 'gitnexus',
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.clientInformation = { client_id: 'cid-intranet', redirect_uris: ['http://127.0.0.1:1/cb'] }
    record.codeVerifier = 'the-verifier'
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.pending = { url: 'http://x', state: 'st', at: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }
  })
  // 用真实 HTTP：起一个只回令牌的本地服务器会绕过「明文」判定（127.0.0.1 是回环），
  // 所以这里断言的是「它确实走到了自己的交换路径」，而不是真的发出去。
  // 交换本身由 test/mcp.oauthInsecure.test.mjs 用注入的 fetch 完整覆盖。
  const result = await flow.complete('gitnexus', 'http://sz-00575123-01/mcp/coding', 'the-code')
  // 真实网络到不了内网地址时，结果是 network 错误 —— 关键是它**没有**报 insecureNotAllowed，
  // 也没有抛错。
  assert.notEqual(result.reason, FLOW_ERRORS.insecureNotAllowed, '开了例外就不该再拒绝')
  assert.equal(typeof result.text, 'string')
})

test('logout：删掉凭据并让内存 provider 失效', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow, store } = makeFlow({ home, sdk, t })
  await flow.begin('github', 'https://api.example.com/mcp')
  await flow.complete('github', 'https://api.example.com/mcp', 'code-abc')
  assert.equal((await flow.status('github', 'https://api.example.com/mcp')).present, true)
  const out = await flow.logout('github')
  assert.equal(out.ok, true)
  assert.equal(out.removed, true)
  assert.equal((await store.read('github')).tokens, null)
  assert.equal((await flow.status('github', 'https://api.example.com/mcp')).present, false)
})

test('status：反映令牌、等待授权与过期三种状态', async (t) => {
  const home = await tempHome(t)
  const { sdk } = fakeSdk()
  const { flow } = makeFlow({ home, sdk, t })
  const fresh = await flow.status('github', 'https://api.example.com/mcp')
  assert.equal(fresh.present, false)
  assert.equal(fresh.waiting, false)

  const begun = await flow.begin('github', 'https://api.example.com/mcp')
  assert.equal(begun.kind, 'redirect')
  const waiting = await flow.status('github', 'https://api.example.com/mcp')
  assert.equal(waiting.waiting, true, '刚发起、还没回调：面板要能显示「等你授权」')
  assert.equal(waiting.authorizeUrl, 'https://as.example.com/authorize?client_id=cid&state=s')

  await flow.complete('github', 'https://api.example.com/mcp', 'code-abc')
  const authorized = await flow.status('github', 'https://api.example.com/mcp')
  assert.equal(authorized.present, true)
  assert.equal(authorized.waiting, false)
  assert.equal(authorized.expiresAt !== '', true, 'expires_in 要被换算成绝对时间')
})

test('flowReasonText：每种原因都有人话', () => {
  for (const reason of Object.values(FLOW_ERRORS)) {
    const text = flowReasonText(reason)
    assert.notEqual(text, '', reason)
  }
  assert.equal(typeof flowReasonText('unknown'), 'string')
})

// ── callback ───────────────────────────────────────────────────────────────────────

/** A tiny fake `webServer` that records the single registered route. */
function fakeCtx() {
  const routes = []
  const effects = []
  return {
    routes,
    webServer: {
      register(route) {
        if (routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
          throw new Error(`duplicate ${route.kind} route "${route.path}"`)
        }
        routes.push(route)
        return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) }
      },
    },
    effect(fn, label) {
      effects.push({ label, fn })
      // Cordis runs the effect immediately and keeps its disposer.
      return fn()
    },
    logger: { warn: () => {} },
  }
}

/** Drive one HTTP request through the registered handler and capture the response. */
async function callRoute(route, { method = 'GET', url = '/' } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); return this },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); this.ended = true; return this },
  }
  await route.handler({ method, url, headers: {} }, response)
  return response
}

test('callback：路由路径带插件前缀，且只接受 GET', async (t) => {
  const ctx = fakeCtx()
  const registered = registerOAuthCallback(ctx, {
    servers: () => [],
    flow: { checkCallback: async () => ({ ok: false, reason: 'no-authorization-in-progress' }), complete: async () => ({ ok: false }) },
    snapshot: () => new Map(),
    log: noopLog,
  })
  assert.equal(registered.installed, true)
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].kind, 'exact')
  assert.equal(ctx.routes[0].path, CALLBACK_PATH)
  assert.match(CALLBACK_PATH, /^\/dsh-skills-mcp-manager\/oauth\/callback$/)

  const posted = await callRoute(ctx.routes[0], { method: 'POST', url: `${CALLBACK_PATH}?code=c&state=s` })
  assert.equal(posted.statusCode, 405)
  assert.equal(posted.headers.allow, 'GET')
  // 回调整页带着一次性 code，绝不能被缓存。
  assert.equal(posted.headers['cache-control'], 'no-store')
})

test('callback：重复注册如实失败，不让插件加载失败', async (t) => {
  const ctx = fakeCtx()
  ctx.webServer.register = () => { throw new Error('duplicate exact route "/x"') }
  const registered = registerOAuthCallback(ctx, {
    servers: () => [], flow: { checkCallback: async () => ({ ok: false }), complete: async () => ({ ok: false }) },
    snapshot: () => new Map(), log: noopLog,
  })
  assert.equal(registered.installed, false)
  assert.match(registered.reason, /duplicate/)
})

test('callback：授权服务器返回 error 时如实展示原因', async (t) => {
  const ctx = fakeCtx()
  registerOAuthCallback(ctx, {
    servers: () => [], flow: { checkCallback: async () => ({ ok: false }), complete: async () => ({ ok: false }) },
    snapshot: () => new Map(), log: noopLog,
  })
  const response = await callRoute(ctx.routes[0], { url: `${CALLBACK_PATH}?error=access_denied&error_description=User+said+no` })
  assert.equal(response.statusCode, 400)
  assert.match(response.body, /access_denied/)
  assert.match(response.body, /User said no/)
})

test('callback：参数重复一律拒绝（不取第一个）', async (t) => {
  const ctx = fakeCtx()
  let checked = 0
  registerOAuthCallback(ctx, {
    servers: () => [{ serverName: 'github', transport: 'streamable-http', url: 'https://x/mcp' }],
    flow: {
      checkCallback: async () => { checked += 1; return { ok: true, code: 'c' } },
      complete: async () => ({ ok: true }),
    },
    snapshot: () => new Map(),
    log: noopLog,
  })
  const response = await callRoute(ctx.routes[0], { url: `${CALLBACK_PATH}?code=c&code=c2&state=s&state=s2` })
  assert.equal(response.statusCode, 400)
  assert.equal(checked, 0, '参数不合格时不该去问任何服务器')
})

test('callback：state 匹配后完成授权并记住结果', async (t) => {
  const ctx = fakeCtx()
  const remembered = new Map()
  const authorized = []
  registerOAuthCallback(ctx, {
    servers: () => [
      { serverName: 'context7', transport: 'streamable-http', url: 'https://mcp.context7.com/mcp' },
      { serverName: 'github', transport: 'streamable-http', url: 'https://api.example.com/mcp' },
      { serverName: 'local', transport: 'stdio', url: '' },
    ],
    flow: {
      checkCallback: async (serverName, state) => (serverName === 'github' && state === 'good-state' ? { ok: true, code: 'the-code' } : { ok: false, reason: 'oauth-state-mismatch' }),
      complete: async (serverName, url, code) => {
        assert.equal(serverName, 'github')
        assert.equal(url, 'https://api.example.com/mcp')
        assert.equal(code, 'the-code')
        return { ok: true, reason: '', detail: '', text: '授权完成', present: true, refreshable: true }
      },
    },
    onAuthorized: async (serverName) => { authorized.push(serverName) },
    snapshot: () => remembered,
    log: noopLog,
  })
  const response = await callRoute(ctx.routes[0], { url: `${CALLBACK_PATH}?code=the-code&state=good-state` })
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /授权完成/)
  /**
   * 成功页要**叫醒面板**：授权是在另一个标签页里做的，面板没有别的办法知道用户什么时候
   * 回来。回调页与面板同源，所以用一个 BroadcastChannel 广播一次就够了 —— 没有它，卡片
   * 会在「需要授权」上再停最多 5 秒（下一个轮询），那几秒里什么都没发生，看着就像没生效。
   */
  assert.match(response.body, /BroadcastChannel/, '成功页要广播「授权完成」，好让面板立刻刷新')
  assert.match(response.body, /dsh-skills-mcp-manager\/oauth/, '频道名必须与面板一致')
  // 文案里不该再让用户去点「重连」——Host 现在会自动重连
  assert.doesNotMatch(response.body, /点一次「重连」/, '自动重连之后不该再让用户手动点')
  // stdio 服务器不该被问（它没有 HTTP 状态码可挑战）——它的 url 为空，会被跳过
  assert.equal(remembered.get('github').ok, true)
  assert.deepEqual(authorized, ['github'])
})

test('callback：没有一台匹配时给出「请先点授权」而不是假装成功', async (t) => {
  const ctx = fakeCtx()
  registerOAuthCallback(ctx, {
    servers: () => [{ serverName: 'github', transport: 'streamable-http', url: 'https://x/mcp' }],
    flow: { checkCallback: async () => ({ ok: false, reason: 'no-authorization-in-progress' }), complete: async () => ({ ok: true }) },
    snapshot: () => new Map(),
    log: noopLog,
  })
  const response = await callRoute(ctx.routes[0], { url: `${CALLBACK_PATH}?code=c&state=s` })
  assert.equal(response.statusCode, 400)
  assert.match(response.body, /请先点「授权」/)
})

test('callback：完成失败时返回 502 并带上原因', async (t) => {
  const ctx = fakeCtx()
  registerOAuthCallback(ctx, {
    servers: () => [{ serverName: 'github', transport: 'streamable-http', url: 'https://x/mcp' }],
    flow: {
      checkCallback: async () => ({ ok: true, code: 'c' }),
      complete: async () => ({ ok: false, reason: 'authorization-could-not-complete', detail: 'invalid_grant', text: '完成授权失败' }),
    },
    snapshot: () => new Map(),
    log: noopLog,
  })
  const response = await callRoute(ctx.routes[0], { url: `${CALLBACK_PATH}?code=c&state=s` })
  assert.equal(response.statusCode, 502)
  assert.match(response.body, /完成授权失败/)
  assert.match(response.body, /invalid_grant/)
})

test('escapeHtml：服务器名与错误文本不能注入页面', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(escapeHtml('a & b'), 'a &amp; b')
  assert.equal(escapeHtml(`"'`), '&quot;&#39;')
})

test('refresh：没有 refresh_token 时如实说「需要重新授权」', async (t) => {
  // 不能拿一个空 refresh_token 去请求 —— 那会换来服务器的 invalid_grant，然后把
  // 「这份凭据本来就不支持刷新」说成「服务器拒绝了刷新」，指错方向。
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: fakeSdk().sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'a', token_type: 'Bearer' }
  })
  const result = await flow.refresh('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.notRefreshable)
  assert.match(result.text, /重新授权/)
})

test('refresh：明文端点未开例外时拒绝，并指出是哪个开关', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: fakeSdk().sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => false,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.clientInformation = { client_id: 'cid' }
  })
  const result = await flow.refresh('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.insecureNotAllowed)
  assert.match(result.text, /允许明文 token 端点/)
})

test('refresh：明文端点开了例外就换新令牌并落盘', async (t) => {
  /**
   * 这条覆盖「到期前主动刷新」真正会走的那段：不是 SDK 的编排，而是我们自己发的那个
   * refresh_token 表单。落盘必须走 provider.saveTokens —— 两条路径写出来的凭据语义
   * 一致，才不会出现「刷新成功了但下一次连接读不到」。
   */
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: fakeSdk().sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'old', token_type: 'Bearer', refresh_token: 'r1', expires_in: 60 }
    record.tokensSavedAt = new Date(Date.now() - 3600_000).toISOString()
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.clientInformation = { client_id: 'cid' }
  })

  const originalFetch = globalThis.fetch
  let seenBody = null
  globalThis.fetch = async (_url, init) => {
    seenBody = new URLSearchParams(String(init.body))
    return new Response(JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r2' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await flow.refresh('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(seenBody.get('grant_type'), 'refresh_token', '必须用 refresh_token grant')
  assert.equal(seenBody.get('refresh_token'), 'r1')
  assert.equal(seenBody.get('client_id'), 'cid')

  const saved = await store.read('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(saved.tokens.access_token, 'new', '新令牌必须落盘')
  assert.equal(saved.tokens.refresh_token, 'r2', '轮换后的 refresh_token 也要存下来')
})

test('refresh：服务器拒绝刷新时给出 refreshFailed 而不是谎报成功', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: fakeSdk().sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.clientInformation = { client_id: 'cid' }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await flow.refresh('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.ok, false)
  assert.equal(result.reason, FLOW_ERRORS.refreshFailed)
  assert.match(result.detail, /invalid_grant/)
  // 旧令牌不能被清掉：清掉等于让用户立刻失去连接，而重新授权本来也还要走一遍。
  const saved = await store.read('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(saved.tokens.access_token, 'a')
})

test('begin：回调地址变了就丢掉旧 client 重新注册（端口每次启动都变）', async (t) => {
  /**
   * 桌面版把 `--port 0` 写死在启动参数里，所以 DSH 每次重启端口都不同；而动态注册得到
   * 的 client_id 与注册时的 redirect_uri 绑定。拿旧 client 去授权只会得到一句难懂的
   * `invalid_client`，用户不可能自己联想到「因为我重启过 DSH」。
   *
   * 这里钉住：地址不一致 → 清掉 clientInformation → SDK 拿到的是空客户端（于是重新 DCR）。
   */
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const seen = []
  const sdk = {
    async auth(provider) {
      seen.push(await provider.clientInformation())
      await provider.redirectToAuthorization('http://as/authorize?x=1')
      return 'REDIRECT'
    },
  }
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:9999/cb', log: noopLog }),
    allowInsecure: () => true,
    currentRedirectUri: () => 'http://127.0.0.1:9999/cb',
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.clientInformation = { client_id: 'stale', redirect_uris: ['http://127.0.0.1:1111/cb'] }
  })

  const result = await flow.begin('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.kind, 'redirect')
  assert.equal(seen.length, 1)
  assert.equal(seen[0], undefined, 'SDK 应当拿到「没有客户端」，从而重新注册')

  const after = await store.read('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(after.clientInformation, null, '旧 client 必须清掉')
  assert.equal(after.pending?.url ?? '', 'http://as/authorize?x=1', '新的 pending 要写下来')
})

test('begin：回调地址没变时保留已注册的 client（不能无端重新注册）', async (t) => {
  /**
   * 每次授权都重新 DCR 会在服务器侧堆一串一次性的客户端，而且有些服务器把注册限流或
   * 要求管理员批准 —— 无端重注册会把一条本来能用的路径变慢甚至变坏。
   */
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const seen = []
  const sdk = {
    async auth(provider) {
      seen.push(await provider.clientInformation())
      await provider.redirectToAuthorization('http://as/authorize?x=2')
      return 'REDIRECT'
    },
  }
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:9999/cb', log: noopLog }),
    allowInsecure: () => true,
    currentRedirectUri: () => 'http://127.0.0.1:9999/cb',
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.clientInformation = { client_id: 'good', redirect_uris: ['http://127.0.0.1:9999/cb'] }
  })

  await flow.begin('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(seen[0]?.client_id, 'good', '地址一致时必须复用已注册的 client')
})

test('begin：拿不到当前回调地址时不去猜（不清任何凭据）', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const sdk = { async auth(provider) { await provider.redirectToAuthorization('http://as/x'); return 'REDIRECT' } }
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:9999/cb', log: noopLog }),
    allowInsecure: () => true,
    // Host 还没拿到 webServer 时就是这个状态（曾经的 redirectUri 空串 bug）。
    currentRedirectUri: () => '',
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.clientInformation = { client_id: 'keep', redirect_uris: ['http://127.0.0.1:1111/cb'] }
  })
  await flow.begin('gitnexus', 'http://sz-00575123-01/mcp/coding')
  const after = await store.read('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(after.clientInformation?.client_id, 'keep', '不知道当前地址时不该动已注册的 client')
})

test('begin：明文端点 + 已有 refresh_token 时**不**让 SDK 去刷新（那是必然抛错的路径）', async (t) => {
  /**
   * 真机报错：点「重新授权」得到
   *   authorization-could-not-start：Refusing to send credentials to non-https token endpoint…
   *
   * SDK 的 authInternal 里有这一段：
   *
   *     if (tokens?.refresh_token && !forceReauthorization) {
   *       try { newTokens = await refreshAuthorization(...) }
   *       catch (error) { if (error instanceof InsecureTokenEndpointError) throw error }
   *     }
   *
   * 也就是说：**只要存在 refresh_token 就一定会尝试刷新**（与是否过期无关），而刷新走
   * 的 executeTokenRequest 里 TLS 检查无条件执行，且这个错误被原样上抛。所以这一步必须
   * 由我们传 forceReauthorization 跳过，否则「已授权」之后就再也点不动重新授权。
   */
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const seen = []
  const sdk = {
    async auth(provider, options) {
      seen.push(options ?? {})
      await provider.redirectToAuthorization('http://as/authorize?forced=1')
      return 'REDIRECT'
    },
  }
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    currentRedirectUri: () => 'http://127.0.0.1:1/cb',
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.clientInformation = { client_id: 'cid', redirect_uris: ['http://127.0.0.1:1/cb'] }
  })

  const result = await flow.begin('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.kind, 'redirect', JSON.stringify(result))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].forceReauthorization, true, '必须让 SDK 跳过它自己的刷新')
})

test('begin：明文端点但例外没开时，给出「去开哪个开关」而不是 SDK 的英文原文', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const sdk = { async auth() { throw new Error('should not be called') } }
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => false,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
  })
  const result = await flow.begin('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(result.kind, 'error')
  assert.equal(result.reason, FLOW_ERRORS.insecureNotAllowed)
  assert.match(result.text, /允许明文 token 端点/, '要指出是哪个开关')
})

test('prepareAuth：安全端点不干预（维持 SDK 原有行为）', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: { async auth() { return 'REDIRECT' } } }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    log: noopLog,
  })
  await store.update('x', 'https://as.example/mcp', (record) => {
    record.discoveryState = {
      authorizationServerUrl: 'https://as.example',
      authorizationServerMetadata: { issuer: 'https://as.example', token_endpoint: 'https://as.example/token' },
    }
  })
  assert.equal(await flow.prepareAuth('x', 'https://as.example/mcp'), null, 'https 端点交给 SDK 自己处理')
})

test('prepareAuth：明文端点先自己刷新，成功就让连接重试（不弹浏览器）', async (t) => {
  /**
   * transport 撞上 401 时，用户不该因为「令牌刚好过期」被弹一次登录页 —— 能自己换就
   * 自己换。这一步存在的意义就是把「刷新」从 SDK 那条必然抛错的路上接过来。
   */
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: { async auth() { throw new Error('不该走到 SDK 的 auth') } } }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'old', token_type: 'Bearer', refresh_token: 'r1' }
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.clientInformation = { client_id: 'cid' }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r2' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const plan = await flow.prepareAuth('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.deepEqual(plan, { done: true })
  const saved = await store.read('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.equal(saved.tokens.access_token, 'new', '新令牌要落盘，连接重试才会带上它')
})

test('prepareAuth：自己刷新也失败时，退回一次新的授权', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const flow = createOAuthFlow({
    store,
    getSdk: () => ({ ok: true, sdk: { async auth() { return 'REDIRECT' } } }),
    makeProvider: (serverName, url) => createOAuthProvider({ store, serverName, url, redirectUri: 'http://127.0.0.1:1/cb', log: noopLog }),
    allowInsecure: () => true,
    log: noopLog,
  })
  await store.update('gitnexus', 'http://sz-00575123-01/mcp/coding', (record) => {
    record.tokens = { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }
    record.discoveryState = {
      authorizationServerUrl: 'http://sz-00575123-01',
      authorizationServerMetadata: { issuer: 'http://sz-00575123-01', token_endpoint: 'http://sz-00575123-01/oauth/token' },
    }
    record.clientInformation = { client_id: 'cid' }
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })
  t.after(() => { globalThis.fetch = originalFetch })

  const plan = await flow.prepareAuth('gitnexus', 'http://sz-00575123-01/mcp/coding')
  assert.deepEqual(plan, { forceReauthorization: true })
})

test('callback：失败页**不**广播（说「完成了」会让面板白刷一次）', async (t) => {
  const ctx = fakeCtx()
  registerOAuthCallback(ctx, {
    servers: () => [{ serverName: 'github', transport: 'streamable-http', url: 'https://x/mcp' }],
    flow: {
      checkCallback: async () => ({ ok: true, code: 'c' }),
      complete: async () => ({ ok: false, reason: 'token-exchange-rejected', detail: 'invalid_grant', text: '换令牌失败' }),
    },
    log: noopLog,
  })
  const response = await callRoute(ctx.routes[0], { url: `${CALLBACK_PATH}?code=c&state=s` })
  assert.equal(response.body.includes('BroadcastChannel'), false, '失败页不该广播授权完成')
})
