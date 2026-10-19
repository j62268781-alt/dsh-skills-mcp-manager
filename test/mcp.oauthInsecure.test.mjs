/**
 * mcp/oauth/insecure：明文 token 端点的例外。
 *
 * 这个模块是整条 OAuth 链路上**唯一会主动降低安全性**的地方，所以测试的重心全在边界上：
 *
 *   · 默认必须是拒绝 —— 一份没有这个字段的旧配置绝不能意外打开它；
 *   · **只**对非 https 且非回环的端点生效 —— https 端点走 SDK 自己的路径，
 *     回环地址本来就被 SDK 豁免（RFC 8252 §7.3，本机开发用）；
 *   · 每次明文请求都要留痕 —— 那是用户日后唯一能查到自己开过什么的证据；
 *   · 令牌响应要收敛，不能把服务器返回的任意字段一路写进凭据文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN_EXCHANGE_ERRORS,
  exchangeInsecureToken,
  insecureTokenEndpoint,
  isLoopbackHost,
  tokenExchangeErrorText,
  validateTokens,
} from '../src/mcp/oauth/insecure.js'

test('isLoopbackHost：与 SDK 的豁免名单逐字一致', () => {
  // 这份名单必须与 `@modelcontextprotocol/client` 的 `isLoopbackHost` 相同：
  // 多认一个主机名 = 我们自己去连一个 SDK 认为不安全的地方。
  for (const host of ['localhost', 'foo.localhost', '127.0.0.1', '[::1]', '::1']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  for (const host of ['127.0.0.2', 'sz-00575123-01', 'example.com', 'localhost.evil.com', '10.0.0.1', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})

test('insecureTokenEndpoint：只对非 https 且非回环判为明文', () => {
  // https 一律安全，哪怕是内网主机名。
  for (const url of ['https://sz-00575123-01/oauth/token', 'https://example.com/token']) {
    assert.equal(insecureTokenEndpoint(url).insecure, false, url)
  }
  // 回环的 http 被 SDK 豁免，也不算「需要例外」。
  for (const url of ['http://127.0.0.1:8791/token', 'http://localhost:3000/token', 'http://[::1]/token']) {
    assert.equal(insecureTokenEndpoint(url).insecure, false, url)
  }
  // 内网明文：这才是需要例外的情况。
  const flagged = insecureTokenEndpoint('http://sz-00575123-01/oauth/token')
  assert.equal(flagged.insecure, true)
  assert.equal(flagged.host, 'sz-00575123-01')
  assert.equal(flagged.protocol, 'http:')
})

test('insecureTokenEndpoint：解析不了的地址不判为明文（交给下游报错）', () => {
  for (const bad of ['', 'not a url', null, undefined, 'ftp://x/token']) {
    assert.equal(insecureTokenEndpoint(bad).insecure, false, String(bad))
  }
})

test('exchangeInsecureToken：拒绝非明文端点（防止它变成第二条 HTTPS 实现）', async () => {
  // https 与回环都不该走这里 —— 它们走 SDK。两条实现会漂移，这个仓库已经吃过一次亏。
  for (const endpoint of ['https://example.com/token', 'http://127.0.0.1:8791/token']) {
    let called = false
    const result = await exchangeInsecureToken({
      tokenEndpoint: endpoint,
      params: { grant_type: 'authorization_code' },
      clientId: 'cid',
      fetchImpl: async () => { called = true; return new Response('{}') },
      log: { warn: () => {} },
    })
    assert.equal(result.ok, false, endpoint)
    assert.equal(result.reason, TOKEN_EXCHANGE_ERRORS.badEndpoint, endpoint)
    assert.equal(called, false, `${endpoint} 不该发出请求`)
  }
})

test('exchangeInsecureToken：明文端点会发请求，并且**必须**留下 warning', async () => {
  const warnings = []
  let seen = null
  const result = await exchangeInsecureToken({
    tokenEndpoint: 'http://sz-00575123-01/oauth/token',
    params: { grant_type: 'authorization_code', code: 'c1', code_verifier: 'v1', redirect_uri: 'http://127.0.0.1:1/cb' },
    clientId: 'cid-1',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init }
      return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref' }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    log: { warn: (message) => warnings.push(message) },
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.tokens.access_token, 'tok')
  assert.equal(result.tokens.refresh_token, 'ref')
  // 请求形态：form-urlencoded 的 POST，这是 RFC 6749 §4.1.3 要求的。
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['content-type'], 'application/x-www-form-urlencoded')
  const body = new URLSearchParams(seen.init.body)
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('code'), 'c1')
  assert.equal(body.get('code_verifier'), 'v1')
  assert.equal(body.get('client_id'), 'cid-1', '公共客户端：client_id 走表单体')
  // 留痕是开启这个例外的前提条件，不是装饰。
  assert.equal(warnings.length, 1, '每次明文请求都要记一条 warning')
  assert.match(warnings[0], /明文/)
  assert.match(warnings[0], /sz-00575123-01/)
})

test('exchangeInsecureToken：token 端点返回错误时给出可读原因与 OAuth 错误码', async () => {
  const result = await exchangeInsecureToken({
    tokenEndpoint: 'http://sz-00575123-01/oauth/token',
    params: { grant_type: 'authorization_code', code: 'bad' },
    clientId: 'cid',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }), { status: 400, headers: { 'content-type': 'application/json' } }),
    log: { warn: () => {} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, TOKEN_EXCHANGE_ERRORS.http)
  assert.match(result.detail, /invalid_grant/)
  assert.match(result.detail, /code expired/)
  assert.match(result.text, /token 端点拒绝了/)
})

test('exchangeInsecureToken：网络错误与超时都收敛成原因，不抛错', async () => {
  const result = await exchangeInsecureToken({
    tokenEndpoint: 'http://sz-00575123-01/oauth/token',
    params: {},
    clientId: 'cid',
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
    log: { warn: () => {} },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, TOKEN_EXCHANGE_ERRORS.network)
  assert.match(result.detail, /ECONNREFUSED/)
})

test('exchangeInsecureToken：非 JSON 响应按状态码分类，不谎报成功', async () => {
  const html = await exchangeInsecureToken({
    tokenEndpoint: 'http://sz-00575123-01/oauth/token',
    params: {},
    clientId: 'cid',
    fetchImpl: async () => new Response('<html>login</html>', { status: 401, headers: { 'content-type': 'text/html' } }),
    log: { warn: () => {} },
  })
  assert.equal(html.ok, false)
  assert.equal(html.reason, TOKEN_EXCHANGE_ERRORS.http, '有状态码就用状态码')

  const garbage = await exchangeInsecureToken({
    tokenEndpoint: 'http://sz-00575123-01/oauth/token',
    params: {},
    clientId: 'cid',
    fetchImpl: async () => new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    log: { warn: () => {} },
  })
  assert.equal(garbage.ok, false)
  assert.equal(garbage.reason, TOKEN_EXCHANGE_ERRORS.badBody, '200 但不是 JSON：不能当成功')
})

test('validateTokens：只保留 SDK 认识的字段，丢掉未知内容', () => {
  const tokens = validateTokens({
    access_token: 'a',
    token_type: 'Bearer',
    refresh_token: 'r',
    expires_in: 3600,
    scope: 'read write',
    issuer: 'http://x',
    // 服务器多给的、不属于令牌的东西，不该被写进凭据文件
    evil: { deeply: 'nested' },
    user: 'someone',
  })
  assert.deepEqual(Object.keys(tokens).sort(), ['access_token', 'expires_in', 'issuer', 'refresh_token', 'scope', 'token_type'])
})

test('validateTokens：access_token 缺失或非字符串时返回 null', () => {
  for (const body of [null, undefined, [], {}, { access_token: '' }, { access_token: 123 }, 'string']) {
    assert.equal(validateTokens(body), null, JSON.stringify(body))
  }
})

test('validateTokens：expires_in 收字符串数字，非法值直接丢掉', () => {
  assert.equal(validateTokens({ access_token: 'a', expires_in: '3600' }).expires_in, 3600, '有些服务器把数字发成字符串')
  assert.equal('expires_in' in validateTokens({ access_token: 'a', expires_in: 'soon' }), false)
  assert.equal('expires_in' in validateTokens({ access_token: 'a', expires_in: 0 }), false, '0 秒等于立即过期，不如不写')
  assert.equal('expires_in' in validateTokens({ access_token: 'a', expires_in: -5 }), false)
})

test('validateTokens：token_type 缺失时按 Bearer，空串不当真', () => {
  assert.equal(validateTokens({ access_token: 'a' }).token_type, 'Bearer')
  assert.equal(validateTokens({ access_token: 'a', token_type: '' }).token_type, 'Bearer')
  assert.equal(validateTokens({ access_token: 'a', token_type: 'DPoP' }).token_type, 'DPoP')
})

test('tokenExchangeErrorText：每种原因都有人话，且都能看出下一步', () => {
  for (const reason of Object.values(TOKEN_EXCHANGE_ERRORS)) {
    const text = tokenExchangeErrorText(reason, 'detail-here')
    assert.notEqual(text, '', reason)
    assert.match(text, /detail-here/, `${reason} 要带上细节`)
  }
  // 默认关闭这条必须把「去哪打开」说出来，否则用户只看到失败
  assert.match(tokenExchangeErrorText(TOKEN_EXCHANGE_ERRORS.notAllowed), /允许明文 token 端点/)
  assert.equal(typeof tokenExchangeErrorText('unknown'), 'string')
})