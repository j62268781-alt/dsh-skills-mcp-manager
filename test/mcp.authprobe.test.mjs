/**
 * mcp/authprobe 接口测试。
 *
 * 这个模块是唯一会**主动发网络请求**的状态探测器，所以测试钉住的是它的两条边界：
 *
 *   1. 只探该探的：stdio 没有 HTTP 状态码、空 URL / 非 http(s) 协议无从探起 ——
 *      这些必须直接返回 null，而不是发一个必然失败的请求。
 *   2. 绝不抛错：网络错误、超时、坏 headers 文本都收敛成 null（= 没观测到挑战），
 *      让面板回落到原本的重试推导。一个探测器的 bug 不该变成界面上的一句假话。
 *
 * 用注入的 fetch 替身，不发真实请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTH_KIND } from '../src/mcp/auth.js'
import { createAuthProbe } from '../src/mcp/authprobe.js'

/** 一个只记录调用、返回预设响应的 fetch 替身。 */
function fakeFetch(response, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init })
    if (response instanceof Error) throw response
    return {
      status: response.status,
      headers: { get: (name) => (name.toLowerCase() === 'www-authenticate' ? response.wwwAuthenticate ?? null : null) },
      body: { cancel: async () => {} },
    }
  }
}

test('authprobe：401 挑战被识别为「需要授权」', async () => {
  const calls = []
  const probe = createAuthProbe()
  const result = await probe.probe(
    { serverName: 'protected', transport: 'streamable-http', url: 'https://api.example.com/mcp', headers: '' },
    {
      fetchImpl: fakeFetch({
        status: 401,
        wwwAuthenticate: 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="files:read"',
      }, calls),
    },
  )
  assert.equal(result.kind, AUTH_KIND.required)
  assert.equal(result.scope, 'files:read')
  // 探测必须真的发出了一次请求，否则「没挑战」和「没探」分不开
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.com/mcp')
  // 必须是 POST + initialize：GET/HEAD 在 Streamable HTTP 上回答五花八门，
  // 拿它判鉴权会把「不支持 GET」误读成「需要授权」。
  assert.equal(calls[0].init.method, 'POST')
  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.method, 'initialize')
  assert.equal(calls[0].init.headers.accept, 'application/json, text/event-stream')
})

test('authprobe：403 insufficient_scope 是「范围不足」', async () => {
  const probe = createAuthProbe()
  const result = await probe.probe(
    { serverName: 'protected', transport: 'streamable-http', url: 'https://api.example.com/mcp', headers: '' },
    { fetchImpl: fakeFetch({ status: 403, wwwAuthenticate: 'Bearer error="insufficient_scope", scope="files:write"' }) },
  )
  assert.equal(result.kind, AUTH_KIND.insufficientScope)
  assert.equal(result.scope, 'files:write')
})

test('authprobe：正常服务器返回 null，不能凭空报需要授权', async () => {
  const probe = createAuthProbe()
  for (const status of [200, 202, 400, 404, 405, 500, 503]) {
    const result = await probe.probe(
      { serverName: 'healthy', transport: 'streamable-http', url: 'https://api.example.com/mcp', headers: '' },
      { fetchImpl: fakeFetch({ status }) },
    )
    assert.equal(result, null, `status=${status} 不该被当成鉴权挑战`)
  }
})

test('authprobe：stdio / 坏 URL / 坏协议一概不探，直接返回 null', async () => {
  const calls = []
  const probe = createAuthProbe()
  const cases = [
    { serverName: 'a', transport: 'stdio', url: 'https://x/mcp', headers: '' },
    { serverName: 'b', transport: 'streamable-http', url: '', headers: '' },
    { serverName: 'c', transport: 'streamable-http', url: 'not a url', headers: '' },
    { serverName: 'd', transport: 'streamable-http', url: 'ftp://x/mcp', headers: '' },
    { serverName: 'e', transport: '', url: 'https://x/mcp', headers: '' },
    null,
  ]
  for (const server of cases) {
    const result = await probe.probe(server, { fetchImpl: fakeFetch({ status: 401 }, calls) })
    assert.equal(result, null, `${JSON.stringify(server)} 不该被探测`)
  }
  // 一次网络请求都不该发出
  assert.equal(calls.length, 0)
})

test('authprobe：网络错误与超时收敛成 null，绝不抛错', async () => {
  const probe = createAuthProbe()
  const result = await probe.probe(
    { serverName: 'down', transport: 'streamable-http', url: 'https://api.example.com/mcp', headers: '' },
    { fetchImpl: fakeFetch(new Error('ECONNREFUSED')) },
  )
  assert.equal(result, null)
})

test('authprobe：headers 文本按 KEY=VALUE 解析，坏行忽略、凭据透传', async () => {
  const calls = []
  const probe = createAuthProbe()
  await probe.probe(
    {
      serverName: 'protected',
      transport: 'streamable-http',
      url: 'https://api.example.com/mcp',
      // 用户实际会写的样子：带注释、空行、坏行，以及一个真的 Authorization
      headers: '# 注释\nAuthorization=Bearer secret-token\n\n坏行没有等号\nX-Trace = abc \n=semkey\n',
    },
    { fetchImpl: fakeFetch({ status: 401 }, calls) },
  )
  const sent = calls[0].init.headers
  assert.equal(sent.Authorization, 'Bearer secret-token')
  assert.equal(sent['X-Trace'], 'abc')
  assert.ok(!('坏行没有等号' in sent))
  assert.ok(!('' in sent))
  // 默认头必须仍在，不能被用户头覆盖掉
  assert.equal(sent['content-type'], 'application/json')
  assert.equal(sent.accept, 'application/json, text/event-stream')
})

test('authprobe：用户自己的 Authorization 不会被默认头挤掉', async () => {
  const calls = []
  const probe = createAuthProbe()
  await probe.probe(
    { serverName: 'x', transport: 'streamable-http', url: 'https://x/mcp', headers: 'authorization=Bearer t\ncontent-type=application/json' },
    { fetchImpl: fakeFetch({ status: 200 }, calls) },
  )
  assert.equal(calls[0].init.headers.authorization, 'Bearer t')
})

test('authprobe：header 名大小写不敏感，不能同时发出 accept 和 Accept', async () => {
  const calls = []
  const probe = createAuthProbe()
  await probe.probe(
    { serverName: 'x', transport: 'streamable-http', url: 'https://x/mcp', headers: 'Accept=text/plain\nContent-Type=text/plain' },
    { fetchImpl: fakeFetch({ status: 200 }, calls) },
  )
  const keys = Object.keys(calls[0].init.headers)
  const lowers = keys.map((key) => key.toLowerCase())
  // 同一个头出现两次时，服务器看到哪个取决于迭代顺序 —— 那是不可复现的行为
  assert.equal(new Set(lowers).size, lowers.length, `重复的头：${keys.join(', ')}`)
  // 用户配置优先：他写的就是真实连接会发的东西
  assert.equal(calls[0].init.headers.Accept, 'text/plain')
  assert.equal(calls[0].init.headers['Content-Type'], 'text/plain')
  assert.ok(!('accept' in calls[0].init.headers))
  assert.ok(!('content-type' in calls[0].init.headers))
})

test('authprobe：没有 fetch 可用时返回 null 而不是崩', async () => {
  const probe = createAuthProbe()
  const result = await probe.probe(
    { serverName: 'x', transport: 'streamable-http', url: 'https://x/mcp', headers: '' },
    { fetchImpl: null },
  )
  assert.equal(result, null)
})

test('authprobe：探测失败会留下告警（不能静默）', async () => {
  const warnings = []
  const probe = createAuthProbe({ warn: (message) => warnings.push(message) })
  await probe.probe(
    { serverName: 'down', transport: 'streamable-http', url: 'https://x/mcp', headers: '' },
    { fetchImpl: fakeFetch(new Error('boom')) },
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /auth probe/)
  assert.match(warnings[0], /boom/)
})
