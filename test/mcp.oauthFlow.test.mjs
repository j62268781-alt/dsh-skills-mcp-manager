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
