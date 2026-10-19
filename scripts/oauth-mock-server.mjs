#!/usr/bin/env node
/**
 * 一个**真的要求 OAuth** 的 MCP 服务器，仅供本机验证用。
 *
 * ## 它存在的理由
 *
 * 本机现有的 4 台 MCP 服务器（context7 / deepwiki / gitnexus / framelink-figma）当前都
 * 直接返回 200，没有 401 挑战，所以面板上不会出现「需要授权」—— 这是**正确**行为，但也
 * 意味着整条 OAuth 链路一条都跑不到。要证明方案有效，需要一个确实会 401 的服务器。
 *
 * 而内网的 `http://` 端点过不了 SDK 的 TLS 检查（`assertSecureTokenEndpoint` 只豁免回环
 * 地址），所以内网那两台即便开了 OAuth 也会在换令牌那一步抛 `InsecureTokenEndpointError`。
 * 回环地址是**协议层面允许**的测试路径（RFC 8252 §7.3），因此这个 mock 挂在 127.0.0.1 上，
 * 能完整走通「发现 → 动态注册 → PKCE 授权 → 换令牌 → 带 Bearer 连上」。
 *
 * ## 它实现了什么
 *
 *   · `POST /mcp`                      MCP 端点：没有有效 Bearer 就 401 + `WWW-Authenticate`
 *   · `GET  /.well-known/oauth-protected-resource`  受保护资源元数据（RFC 9728）
 *   · `GET  /.well-known/oauth-authorization-server` 授权服务器元数据（RFC 8414）
 *   · `POST /register`                 动态客户端注册（RFC 7591）
 *   · `GET  /authorize`                授权端点：**自动同意**并 302 回回调（不弹登录页）
 *   · `POST /token`                    令牌端点：授权码 + PKCE 换令牌，也支持 refresh_token
 *
 * ## 它明确**不是**生产实现
 *
 * 没有用户登录、不校验 scope、令牌存在内存里、`/authorize` 无条件同意。它只用来回答一个问题：
 * **这条链路在本机能不能跑通。**
 *
 * 用法：
 *   node scripts/oauth-mock-server.mjs             # 默认端口 8791
 *   node scripts/oauth-mock-server.mjs 9000        # 指定端口
 *   MOCK_PORT=9000 node scripts/oauth-mock-server.mjs
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 8791)
const HOST = '127.0.0.1'
const ORIGIN = `http://${HOST}:${String(PORT)}`
const MCP_PATH = '/mcp'
const RESOURCE = `${ORIGIN}${MCP_PATH}`

/** 已注册的客户端（DCR 写入这里）。 */
const clients = new Map()
/** 尚未兑换的授权码。 */
const codes = new Map()
/** 有效令牌 → `{ clientId, expiresAt, refreshToken }`。 */
const accessTokens = new Map()
/** refresh_token → `{ clientId }`。 */
const refreshTokens = new Map()

const base64url = (buffer) => Buffer.from(buffer).toString('base64url')
const now = () => Date.now()

/** 读一个 JSON 请求体。 */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/** 读一个 form 请求体。 */
function readForm(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
  })
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

/** 挑战头：让客户端知道「去哪个元数据文档找授权服务器」（RFC 9728）。 */
function challenge(res) {
  res.writeHead(401, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    // 必须带 `resource_metadata`，否则 SDK 只能靠默认的 `/.well-known/...` 猜。
    'www-authenticate': `Bearer realm="mock-mcp", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="mcp"`,
  })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'authorization required' }, id: null }))
}

/** 从 Authorization 头里取出并校验令牌。 */
function bearerOk(req) {
  const raw = String(req.headers.authorization ?? '')
  const match = /^Bearer\s+(.+)$/iu.exec(raw)
  if (match === null) return false
  const entry = accessTokens.get(match[1])
  if (entry === undefined) return false
  if (entry.expiresAt <= now()) {
    accessTokens.delete(match[1])
    return false
  }
  return true
}

/** 发一个令牌对。 */
function issueTokens({ clientId, scope = 'mcp' }) {
  const access = base64url(randomBytes(24))
  const refresh = base64url(randomBytes(24))
  accessTokens.set(access, { clientId, expiresAt: now() + 3600 * 1000, refreshToken: refresh })
  refreshTokens.set(refresh, { clientId })
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope,
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN)
  const path = url.pathname

  // ── RFC 9728：受保护资源元数据 ─────────────────────────────────────────────────
  if (path === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
    return json(res, 200, {
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_name: 'Mock OAuth MCP Server',
    })
  }

  // ── RFC 8414：授权服务器元数据 ────────────────────────────────────────────────
  if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
    return json(res, 200, {
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // 公共客户端：没有 client_secret，所以只声明 none。
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    })
  }

  // ── RFC 7591：动态客户端注册 ───────────────────────────────────────────────────
  if (path === '/register' && req.method === 'POST') {
    const metadata = await readJson(req)
    const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : []
    if (redirectUris.length === 0) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' })
    }
    const clientId = base64url(randomBytes(12))
    clients.set(clientId, { redirectUris, metadata })
    console.log(`  ← 动态注册：client_id=${clientId} redirect_uris=${JSON.stringify(redirectUris)}`)
    return json(res, 201, {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: metadata.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: metadata.response_types ?? ['code'],
      client_name: metadata.client_name ?? '',
    })
  }

  // ── 授权端点：自动同意并 302 回回调 ────────────────────────────────────────────
  if (path === '/authorize' && req.method === 'GET') {
    const clientId = String(url.searchParams.get('client_id') ?? '')
    const redirectUri = String(url.searchParams.get('redirect_uri') ?? '')
    const state = String(url.searchParams.get('state') ?? '')
    const challengeValue = String(url.searchParams.get('code_challenge') ?? '')
    const method = String(url.searchParams.get('code_challenge_method') ?? '')
    const scope = String(url.searchParams.get('scope') ?? 'mcp')
    const resource = String(url.searchParams.get('resource') ?? '')
    const client = clients.get(clientId)
    if (client === undefined) return json(res, 400, { error: 'invalid_client', error_description: `unknown client_id ${clientId}` })
    if (!client.redirectUris.includes(redirectUri)) {
      return json(res, 400, { error: 'invalid_request', error_description: `redirect_uri not registered: ${redirectUri}` })
    }
    if (method !== 'S256' || challengeValue === '') {
      // 本 mock 只支持 PKCE S256：非 PKCE 的授权码流程会被攻击者重放。
      return json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 is required' })
    }
    const code = base64url(randomBytes(18))
    codes.set(code, { clientId, redirectUri, codeChallenge: challengeValue, scope, resource, createdAt: now() })
    console.log(`  ← 授权同意：client_id=${clientId} scope=${scope} resource=${resource || '(none)'}`)
    const location = new URL(redirectUri)
    location.searchParams.set('code', code)
    if (state !== '') location.searchParams.set('state', state)
    res.writeHead(302, { location: location.href, 'cache-control': 'no-store' })
    res.end()
    return
  }

  // ── 令牌端点：授权码 / refresh_token ──────────────────────────────────────────
  if (path === '/token' && req.method === 'POST') {
    const form = await readForm(req)
    const grantType = String(form.get('grant_type') ?? '')
    const clientId = String(form.get('client_id') ?? '')
    const client = clients.get(clientId)
    if (client === undefined) return json(res, 401, { error: 'invalid_client', error_description: `unknown client_id ${clientId}` })

    if (grantType === 'authorization_code') {
      const code = String(form.get('code') ?? '')
      const verifier = String(form.get('code_verifier') ?? '')
      const stored = codes.get(code)
      if (stored === undefined) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown or already used code' })
      codes.delete(code) // 一次性
      if (stored.clientId !== clientId) return json(res, 400, { error: 'invalid_grant', error_description: 'code was issued to another client' })
      const computed = base64url(createHash('sha256').update(verifier).digest())
      if (computed !== stored.codeChallenge) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      }
      const tokens = issueTokens({ clientId, scope: stored.scope })
      console.log(`  ← 换令牌成功（authorization_code）access_token=${tokens.access_token.slice(0, 8)}…`)
      return json(res, 200, tokens)
    }

    if (grantType === 'refresh_token') {
      const refresh = String(form.get('refresh_token') ?? '')
      if (refreshTokens.get(refresh)?.clientId !== clientId) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh_token' })
      }
      const tokens = issueTokens({ clientId })
      console.log(`  ← 刷新令牌成功 access_token=${tokens.access_token.slice(0, 8)}…`)
      return json(res, 200, tokens)
    }

    return json(res, 400, { error: 'unsupported_grant_type', error_description: grantType })
  }

  // ── MCP 端点 ──────────────────────────────────────────────────────────────────
  if (path === MCP_PATH) {
    if (!bearerOk(req)) {
      console.log('  ← /mcp 无有效令牌 → 401 挑战')
      return challenge(res)
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const body = await readJson(req)
    const id = body.id ?? null
    const method = String(body.method ?? '')
    // 一个极小的 MCP 实现：够客户端完成 initialize / tools/list / tools/call。
    const reply = (result) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', result, id })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(payload)
    }
    if (method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'oauth-mock', version: '0.1.0' },
      })
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    if (method === 'tools/list') {
      return reply({
        tools: [{
          name: 'whoami',
          description: 'Returns the authenticated session identity recorded by the mock server.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      })
    }
    if (method === 'tools/call') {
      const raw = String(req.headers.authorization ?? '').replace(/^Bearer\s+/iu, '')
      const entry = accessTokens.get(raw)
      return reply({
        content: [{ type: 'text', text: `authenticated via OAuth; token issued for client ${String(entry?.clientId ?? '?')}` }],
        structuredContent: { clientId: String(entry?.clientId ?? '') },
      })
    }
    return reply({})
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found\n')
})

server.listen(PORT, HOST, () => {
  console.log('')
  console.log('  ✓ 需要 OAuth 的 mock MCP 服务器已启动')
  console.log('')
  console.log(`    MCP 端点 : ${RESOURCE}`)
  console.log(`    授权服务器: ${ORIGIN}`)
  console.log('')
  console.log('  在 DSH 的 MCP 面板里添加一台 streamable-http 服务器：')
  console.log(`    名称: oauth-mock`)
  console.log(`    URL : ${RESOURCE}`)
  console.log('')
  console.log('  保存后卡片应显示「需要授权」，点「授权」→ 复制链接到浏览器（会自动同意）')
  console.log('  → 回调完成后回到面板点一次「重连」。')
  console.log('')
  console.log('  Ctrl+C 退出。')
  console.log('')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  · 关闭 mock 服务器')
    server.close(() => process.exit(0))
  })
}
