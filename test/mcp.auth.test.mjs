/**
 * mcp/auth 接口测试。
 *
 * 这个模块存在的唯一理由是**别把「需要授权」说成「坏了」**，所以测试的重心在
 * 「不下结论」的那一侧：任何拿不准的响应都必须返回 null，让面板回落到原本的
 * 重试/放弃推导。误报（给一台真故障的服务器贴「需要授权」）比漏报更糟 ——
 * 用户会去补一个根本不需要的授权，然后发现问题还在。
 *
 * 另一条被钉住的是协议字段的**大小写与拼写**：`insufficient_scope` 是下划线，
 * 而面板取值用连字符；`WWW-Authenticate` 的 scheme 判定要大小写不敏感。
 * 这些细节抄错不会抛错，只会静默失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTH_KIND, authDetailText, classifyAuthChallenge, parseWwwAuthenticate } from '../src/mcp/auth.js'

test('parseWwwAuthenticate：只认 Bearer，字段带引号或不带都能读', () => {
  const full = parseWwwAuthenticate(
    'Bearer realm="mcp", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="files:read files:write"',
  )
  // `scheme` 就叫「第二个空白分隔的 token」—— 这是 SDK 自己的做法（`split(" ")[1]`），
  // 所以当挑战的第一个参数是 `realm=` 时它读到的就是 `realm="mcp",` 而不是认证方案名。
  // 我们逐字对齐 SDK 而不是「修正」它：这个值我们并不消费（只用于确认它是 Bearer），
  // 自作聪明地改语义会让两边对同一个头给出不同解释。
  assert.equal(full.scheme, 'realm="mcp",')
  assert.equal(full.resourceMetadataUrl, 'https://api.example.com/.well-known/oauth-protected-resource')
  assert.equal(full.scope, 'files:read files:write')
  // 常见的第二种形状：token68 直接跟在 scheme 后面
  assert.equal(parseWwwAuthenticate('Bearer abc123 scope="read"').scheme, 'abc123')
  assert.equal(parseWwwAuthenticate('Bearer abc123 scope="read"').scope, 'read')
  // 不加引号是合法的，SDK 自己也两种都收
  assert.equal(parseWwwAuthenticate('Bearer scope=files:read').scope, 'files:read')
  // scheme 大小写不敏感
  assert.equal(parseWwwAuthenticate('bearer scope=a').scope, 'a')
  assert.equal(parseWwwAuthenticate('BEARER scope=a').scope, 'a')
  // 逗号是字段分隔符，不够聪明地切分会把下一个字段吃进来
  assert.equal(parseWwwAuthenticate('Bearer error="insufficient_scope", scope="read"').error, 'insufficient_scope')
  assert.equal(parseWwwAuthenticate('Bearer error="insufficient_scope", scope="read"').scope, 'read')
})

test('parseWwwAuthenticate：认不出的头返回 null，而不是空壳', () => {
  // 「没有挑战」与「挑战不完整」必须能分开，否则调用方会把 Basic 当成 Bearer
  for (const value of [null, undefined, '', '   ', 'Basic realm="x"', 'Bearer', 'Negotiate']) {
    assert.equal(parseWwwAuthenticate(value), null, `不该认成 Bearer：${String(value)}`)
  }
})

test('classifyAuthChallenge：401 是「需要授权」，有没有挑战头都算', () => {
  const withChallenge = classifyAuthChallenge({
    status: 401,
    wwwAuthenticate: 'Bearer resource_metadata="https://a/.well-known/oauth-protected-resource", scope="read"',
  })
  assert.equal(withChallenge.kind, AUTH_KIND.required)
  assert.equal(withChallenge.scope, 'read')
  assert.equal(withChallenge.resourceMetadataUrl, 'https://a/.well-known/oauth-protected-resource')
  // 401 本身就是协议级的明确信号，没有头也仍然是鉴权拒绝
  assert.equal(classifyAuthChallenge({ status: 401 }).kind, AUTH_KIND.required)
  assert.equal(classifyAuthChallenge({ status: 401, wwwAuthenticate: 'Basic realm="x"' }).kind, AUTH_KIND.required)
})

test('classifyAuthChallenge：403 只在 insufficient_scope 时才算授权问题', () => {
  const stepUp = classifyAuthChallenge({
    status: 403,
    wwwAuthenticate: 'Bearer error="insufficient_scope", scope="files:write", error_description="needs write scope"',
  })
  assert.equal(stepUp.kind, AUTH_KIND.insufficientScope)
  assert.equal(stepUp.scope, 'files:write')
  assert.equal(stepUp.errorDescription, 'needs write scope')
  // 403 但原因不是范围不足（例如被策略拒绝）→ 不下结论，那是另一类问题
  assert.equal(classifyAuthChallenge({ status: 403, wwwAuthenticate: 'Bearer error="invalid_token"' }), null)
  assert.equal(classifyAuthChallenge({ status: 403 }), null)
})

test('classifyAuthChallenge：其它一切都返回 null（宁漏报不误报）', () => {
  for (const status of [200, 204, 301, 404, 405, 408, 429, 500, 502, 503, NaN, undefined, null, 'abc']) {
    assert.equal(
      classifyAuthChallenge({ status, wwwAuthenticate: 'Bearer scope="read"' }), null,
      `status=${String(status)} 不该被当成鉴权挑战`,
    )
  }
})

test('authDetailText：措辞必须点明「不是故障」', () => {
  const required = authDetailText(AUTH_KIND.required, { scope: 'files:read' })
  assert.match(required, /不是故障/)
  assert.match(required, /files:read/)
  // 有 error_description 时优先转述服务器自己的说法
  assert.match(authDetailText(AUTH_KIND.required, { errorDescription: 'token expired' }), /token expired/)
  const stepUp = authDetailText(AUTH_KIND.insufficientScope, { scope: 'files:write' })
  assert.match(stepUp, /不是故障/)
  assert.match(stepUp, /files:write/)
  // 什么都不给也不能崩、不能出现空占位
  assert.ok(authDetailText(AUTH_KIND.required, {}).length > 0)
  assert.ok(authDetailText(AUTH_KIND.insufficientScope, undefined).length > 0)
  assert.ok(!authDetailText(AUTH_KIND.required, {}).includes('undefined'))
  assert.ok(!authDetailText(AUTH_KIND.insufficientScope, {}).includes('：'))
})
