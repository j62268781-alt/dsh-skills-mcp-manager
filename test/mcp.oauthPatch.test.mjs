/**
 * mcp/oauth/patch：transport 原型补丁。
 *
 * 这是整个 OAuth 方案里**唯一一处依赖 SDK 私有实现**的地方（`_authProvider`、
 * `_commonHeaders`、`start`），所以测试用一个**结构等价**的假 transport 而不是真 SDK：
 *
 *   · CI 上没有宿主 `node_modules`，真 SDK 根本装不到；
 *   · 我们要钉的是「补丁的契约」，不是 SDK 的实现 —— 后者由 `verify()` 在真机上验。
 *
 * 测试重心是**补丁必须能如实失败**。这条补丁最坏的结局不是抛错，而是「装上了但没生效」：
 * 用户看到一个授权按钮，点它永远不会成功，日志里什么都没有。所以每一种「装不上」的
 * 情况都要能被检测出来并给出原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PATCH_REASONS, installTransportPatch, makeAuthProvider, patchReasonText } from '../src/mcp/oauth/patch.js'

/**
 * A minimal stand-in for `StreamableHTTPClientTransport`.
 *
 * Mirrors the 2.2.0 shape that the patch depends on:
 *   · `start()` sends no HTTP;
 *   · `_commonHeaders()` reads `_authProvider` and applies `headers.set('Authorization', …)`;
 *   · `_authProvider` / `_oauthProvider` are own, writable instance properties.
 */
class FakeTransport {
  constructor(url) {
    this._url = url instanceof URL ? url : new URL(String(url))
    this._requestInit = undefined
    this._authProvider = undefined
    this._oauthProvider = undefined
  }

  async start() {
    this._started = true
  }

  async _commonHeaders() {
    const headers = new Headers(this._requestInit?.headers ?? undefined)
    const token = await this._authProvider?.token?.()
    if (typeof token === 'string' && token !== '') headers.set('Authorization', `Bearer ${token}`)
    return headers
  }
}

/** A fresh "SDK" per test: the patch keys state off `Symbol.for`, so the prototype must be fresh. */
function freshSdk() {
  return { StreamableHTTPClientTransport: class extends FakeTransport {} }
}

const noopLog = { warn: () => {} }

test('installTransportPatch：装上后 start() 会把 provider 注入实例', async () => {
  const sdk = freshSdk()
  const injected = { token: async () => 'tok-1' }
  const oauthProvider = { tokens: async () => ({ access_token: 'tok-1' }) }
  const patched = installTransportPatch({
    sdk,
    lookup: () => ({ provider: injected, oauthProvider }),
    log: noopLog,
  })
  assert.equal(patched.installed, true)
  const transport = new sdk.StreamableHTTPClientTransport('https://api.example.com/mcp')
  await transport.start()
  assert.equal(transport._authProvider, injected)
  assert.equal(transport._oauthProvider, oauthProvider, 'finishAuth / 403 step-up 都要求 _oauthProvider')
  const headers = await transport._commonHeaders()
  assert.equal(headers.get('authorization'), 'Bearer tok-1')
})

test('installTransportPatch：lookup 返回 null 时不注入（无凭据的服务器行为不变）', async () => {
  const sdk = freshSdk()
  const patched = installTransportPatch({ sdk, lookup: () => null, log: noopLog })
  assert.equal(patched.installed, true)
  const transport = new sdk.StreamableHTTPClientTransport('https://api.example.com/mcp')
  await transport.start()
  assert.equal(transport._authProvider, undefined)
  assert.equal((await transport._commonHeaders()).get('authorization'), null)
})

test('installTransportPatch：lookup 抛错时不影响连接，只是不注入', async () => {
  const sdk = freshSdk()
  const warnings = []
  const patched = installTransportPatch({
    sdk,
    lookup: () => { throw new Error('lookup exploded') },
    log: { warn: (message) => warnings.push(message) },
  })
  assert.equal(patched.installed, true)
  const transport = new sdk.StreamableHTTPClientTransport('https://api.example.com/mcp')
  // 不抛：一次 lookup 的 bug 不该让服务器连不上。
  await assert.doesNotReject(() => transport.start())
  assert.equal(transport._authProvider, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /lookup exploded/)
})

test('installTransportPatch：已有 authProvider 的 transport 不被覆盖', async () => {
  const sdk = freshSdk()
  const patched = installTransportPatch({ sdk, lookup: () => ({ provider: { token: async () => 'injected' }, oauthProvider: {} }), log: noopLog })
  assert.equal(patched.installed, true)
  const transport = new sdk.StreamableHTTPClientTransport('https://api.example.com/mcp')
  const own = { token: async () => 'mine' }
  transport._authProvider = own
  await transport.start()
  assert.equal(transport._authProvider, own, '调用方自己给的 provider 优先')
  assert.equal((await transport._commonHeaders()).get('authorization'), 'Bearer mine')
})

test('installTransportPatch：HMR 重载只换 lookup，不叠 wrapper', async () => {
  const sdk = freshSdk()
  const first = installTransportPatch({ sdk, lookup: () => ({ provider: { token: async () => 'one' }, oauthProvider: {} }), log: noopLog })
  assert.equal(first.installed, true)
  const patchedStart = sdk.StreamableHTTPClientTransport.prototype.start
  const second = installTransportPatch({ sdk, lookup: () => ({ provider: { token: async () => 'two' }, oauthProvider: {} }), log: noopLog })
  assert.equal(second.installed, true)
  assert.equal(second.reused, true, '第二次必须是复用，不是新装')
  assert.equal(sdk.StreamableHTTPClientTransport.prototype.start, patchedStart, '不能叠加 wrapper')
  const transport = new sdk.StreamableHTTPClientTransport('https://api.example.com/mcp')
  await transport.start()
  assert.equal((await transport._commonHeaders()).get('authorization'), 'Bearer two', 'lookup 必须被换成新的')
})

test('installTransportPatch：没有 StreamableHTTPClientTransport 时如实失败', () => {
  for (const sdk of [undefined, {}, { StreamableHTTPClientTransport: 'nope' }]) {
    const result = installTransportPatch({ sdk, lookup: () => null, log: noopLog })
    assert.equal(result.installed, false)
    assert.equal(result.reason, PATCH_REASONS.noTransportClass)
  }
})

test('installTransportPatch：start 缺失或请求头构造缺失时如实失败', () => {
  // SDK 升级把 start 改名是最可能的破坏；必须被检测到，而不是打上一个没用的补丁。
  class NoStart { async _commonHeaders() { return new Headers() } }
  const noStart = installTransportPatch({ sdk: { StreamableHTTPClientTransport: NoStart }, lookup: () => null, log: noopLog })
  assert.equal(noStart.installed, false)
  assert.equal(noStart.reason, PATCH_REASONS.noStart)

  class NoHeaders { async start() {} }
  const noHeaders = installTransportPatch({ sdk: { StreamableHTTPClientTransport: NoHeaders }, lookup: () => null, log: noopLog })
  assert.equal(noHeaders.installed, false)
  assert.equal(noHeaders.reason, PATCH_REASONS.noCommonHeaders)
})

test('installTransportPatch：冻结的原型如实失败而不是静默不生效', () => {
  class Frozen { async start() {} async _commonHeaders() { return new Headers() } }
  Object.freeze(Frozen.prototype)
  const result = installTransportPatch({ sdk: { StreamableHTTPClientTransport: Frozen }, lookup: () => null, log: noopLog })
  assert.equal(result.installed, false)
  assert.equal(result.reason, PATCH_REASONS.notExtensible)
})

test('verify：真的构造一个实例并检查 Authorization 出现', async () => {
  const sdk = freshSdk()
  const patched = installTransportPatch({ sdk, lookup: () => null, log: noopLog })
  assert.equal(patched.installed, true)
  const verified = await patched.verify('https://verify.example.com/mcp')
  assert.equal(verified.ok, true, JSON.stringify(verified))
})

test('verify：请求头构造坏掉时如实失败（这是最后一道闸门）', async () => {
  // 模拟 SDK 换了实现：`_commonHeaders` 还在，但不再读 `_authProvider`。
  class IgnoresAuth extends FakeTransport {
    async _commonHeaders() { return new Headers() }
  }
  const sdk = { StreamableHTTPClientTransport: IgnoresAuth }
  const patched = installTransportPatch({ sdk, lookup: () => null, log: noopLog })
  assert.equal(patched.installed, true, '补丁本身能装上')
  const verified = await patched.verify()
  assert.equal(verified.ok, false, '但必须验出「注入了却没进请求头」')
  assert.equal(verified.reason, PATCH_REASONS.injectFailed)
})

test('uninstall：还原 start，且可以重复调用', () => {
  const sdk = freshSdk()
  const original = sdk.StreamableHTTPClientTransport.prototype.start
  const patched = installTransportPatch({ sdk, lookup: () => null, log: noopLog })
  assert.notEqual(sdk.StreamableHTTPClientTransport.prototype.start, original)
  patched.uninstall()
  assert.equal(sdk.StreamableHTTPClientTransport.prototype.start, original)
  assert.doesNotThrow(() => patched.uninstall())
})

test('patchReasonText：每种原因都有人话，且都提到不可用', () => {
  for (const reason of Object.values(PATCH_REASONS)) {
    const text = patchReasonText(reason)
    assert.notEqual(text, '', reason)
    assert.match(text, /不可用/, reason)
  }
  assert.equal(typeof patchReasonText('who-knows'), 'string')
})

// ── makeAuthProvider ────────────────────────────────────────────────────────────────

test('makeAuthProvider.token：把 access_token 直接交给 transport', async () => {
  const provider = makeAuthProvider({
    sdk: { auth: async () => 'AUTHORIZED', extractWWWAuthenticateParams: () => ({}) },
    oauthProvider: { tokens: async () => ({ access_token: 'abc' }) },
    log: noopLog,
    serverName: 'github',
  })
  assert.equal(await provider.token(), 'abc')
})

test('makeAuthProvider.token：没有令牌时返回 undefined（而不是空串）', async () => {
  // 返回空串会让 SDK 发出 `Authorization: Bearer ` —— 一个既无效又难查的头。
  const provider = makeAuthProvider({
    sdk: { auth: async () => 'AUTHORIZED', extractWWWAuthenticateParams: () => ({}) },
    oauthProvider: { tokens: async () => undefined },
    log: noopLog,
    serverName: 'github',
  })
  assert.equal(await provider.token(), undefined)
})

test('makeAuthProvider.onUnauthorized：AUTHORIZED 时静默返回（transport 会重试一次）', async () => {
  const calls = []
  const provider = makeAuthProvider({
    sdk: {
      auth: async (oauthProvider, options) => { calls.push(options); return 'AUTHORIZED' },
      extractWWWAuthenticateParams: () => ({ scope: 'files:read', resourceMetadataUrl: 'https://x/prm' }),
    },
    oauthProvider: { tokens: async () => ({}) },
    log: noopLog,
    serverName: 'github',
  })
  await assert.doesNotReject(() => provider.onUnauthorized({ response: {}, serverUrl: 'https://x/mcp', fetchFn: undefined }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].scope, 'files:read', '401 挑战里的 scope 必须透传给 SDK')
  assert.equal(calls[0].resourceMetadataUrl, 'https://x/prm')
})

test('makeAuthProvider.onUnauthorized：REDIRECT 抛一个可辨识的错误，而不是静默成功', async () => {
  // 静默返回会让 transport 立刻重试 → 继续 401 → 重试预算耗尽 → 面板显示「已放弃重试」，
  // 把一个「你去点一下授权」说成「服务器坏了」。
  const provider = makeAuthProvider({
    sdk: { auth: async () => 'REDIRECT', extractWWWAuthenticateParams: () => ({}) },
    oauthProvider: { tokens: async () => ({}) },
    log: noopLog,
    serverName: 'github',
  })
  const error = await provider.onUnauthorized({ response: {}, serverUrl: 'https://x/mcp' }).catch((caught) => caught)
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'OAUTH_REDIRECT_REQUIRED')
  assert.match(error.message, /授权/)
})
