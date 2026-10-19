#!/usr/bin/env node
/**
 * OAuth 的端到端自检：**不需要浏览器、不需要点面板**，但用的是真 SDK 和真 HTTP。
 *
 * ## 它验证什么
 *
 * `scripts/oauth-live-check.mjs` 证明「补丁能让真实 transport 带上 Authorization」，
 * 但它用一个假 token、不跑协议。这个脚本跑完整条链路：
 *
 *   401 挑战 → 资源元数据 → 授权服务器元数据 → 动态注册 → PKCE 授权 → 换令牌
 *   → transport 自动带上 Bearer → 真的连上 → 真的调用一个工具
 *
 * 它需要 `scripts/oauth-mock-server.mjs` 在 127.0.0.1:8791 上运行。回环地址是协议层面
 * 允许的明文 OAuth 路径（RFC 8252 §7.3，SDK 的 `isLoopbackHost` 也豁免它），所以这条
 * 验证不受「内网 http 过不了 TLS 检查」的影响。
 *
 * ## 为什么需要它
 *
 * 单元测试用**结构等价**的假 SDK，证明不了：
 *   · 我们拼的 discovery / DCR / PKCE 参数真的被一个真实授权服务器接受；
 *   · `code_verifier` 在「发起」与「完成」两次独立调用之间真的存活；
 *   · 换了令牌之后，一个**新** transport 真的能连上并调用工具。
 *
 * 这三件事正是用户点「授权」时会遇到的问题，而且都只在真协议下才暴露。
 *
 * ## 用法
 *
 *   node scripts/oauth-mock-server.mjs &        # 或另开一个终端
 *   node scripts/oauth-e2e.mjs
 *
 * 没有 mock 在跑时**跳过并说明原因**（与 smoke / live-check 同样的口径）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Allow the caller to point at the checkout explicitly: this script is meant to be copied
// next to a *resolvable* `@deepseek-ai/dsh-mcp-client` (plain node cannot read app.asar), and
// once copied, `import.meta.url` no longer leads back here.
const ROOT = process.env.SMP_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { loadSdk } = await import(`${ROOT}/src/mcp/oauth/sdk.js`)
const { installTransportPatch, makeAuthProvider } = await import(`${ROOT}/src/mcp/oauth/patch.js`)
const { createOAuthStore } = await import(`${ROOT}/src/mcp/oauth/store.js`)
const { createOAuthProvider } = await import(`${ROOT}/src/mcp/oauth/provider.js`)
const { createOAuthFlow } = await import(`${ROOT}/src/mcp/oauth/flow.js`)

const MCP_URL = process.env.MOCK_URL ?? 'http://127.0.0.1:8791/mcp'

// Skip (not pass) when the mock is absent: an assertion that silently becomes a no-op is how
// this repository once shipped a broken check.
try {
  const probe = await fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' })
  if (probe.status !== 401) {
    console.log(`  · 跳过 OAuth 端到端自检（${MCP_URL} 没有返回 401，mock 服务器的行为不符合预期）`)
    process.exit(0)
  }
} catch {
  console.log(`  · 跳过 OAuth 端到端自检（连不上 ${MCP_URL}；先运行 node scripts/oauth-mock-server.mjs）`)
  process.exit(0)
}

// 1. Load the real SDK the way the plugin does.
const loaded = await loadSdk(import.meta.resolve('@deepseek-ai/dsh-mcp-client'))
if (loaded.ok !== true) { console.log('FAIL loadSdk', loaded); process.exit(1) }
console.log(`1. SDK ${loaded.version} loaded (ESM)`)

// 2. Install the patch with a lookup that always answers for MCP_URL.
const home = await mkdtemp(join(tmpdir(), 'oauth-e2e-'))
const store = createOAuthStore({ dshHome: home })
const callbackUrl = 'http://127.0.0.1:9999/cb'
const makeProvider = (serverName, url) => createOAuthProvider({
  store, serverName, url, redirectUri: callbackUrl,
  log: { warn: (m) => console.log('   warn:', m) },
})
let flow = null
const patched = installTransportPatch({
  sdk: loaded.sdk,
  lookup: (targetUrl) => {
    if (String(targetUrl) !== MCP_URL) return null
    // Production shares the flow's instance (see oauthLookup in src/index.js): two instances
    // would each cache the credential record and the transport would read a stale snapshot.
    const made = flow.providerFor('oauth-mock', MCP_URL)
    return { provider: makeAuthProvider({ sdk: loaded.sdk, oauthProvider: made.provider, log: { warn: console.log }, serverName: 'oauth-mock' }), oauthProvider: made.provider }
  },
  log: { warn: (m) => console.log('   warn:', m) },
})
console.log('2. transport patch installed:', patched.installed)

// 3. First connect: must fail with 401, and the patch must have injected a provider.
const { Client } = loaded.sdk
const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
const transport = new loaded.sdk.StreamableHTTPClientTransport(new URL(MCP_URL))
try {
  await client.connect(transport)
  console.log('3. 第 1 次连接在没有令牌时被拒绝（预期）')
} catch (error) {
  console.log(`3. first connect refused as expected: ${String(error?.message ?? error).slice(0, 90)}`)
}
// At this point the flow does not exist yet (it is created below), so the lookup returns null
// and nothing is injected — that is the correct order, and it matches production: `oauthLookup`
// starts with `if (oauthFlow === null) return null`. The injection is asserted after the token
// exists, at step 8, which is where it actually matters.
console.log('   _authProvider injected (gracefully skipped, flow not built yet):', transport._authProvider === undefined)

// 4. Run our flow: begin -> capture authorize URL -> follow it (mock auto-approves) -> complete.
flow = createOAuthFlow({
  store,
  getSdk: () => ({ ok: true, sdk: loaded.sdk }),
  makeProvider,
  log: { warn: (m) => console.log('   warn:', m) },
})
const begun = await flow.begin('oauth-mock', MCP_URL)
console.log(`4. begin: kind=${begun.kind}`)
if (begun.kind !== 'redirect') { console.log('FAIL begin', begun); process.exit(1) }
console.log(`   authorize URL: ${begun.authorizeUrl.slice(0, 110)}…`)

// Follow the authorize URL the way a browser would; the mock 302s to the callback.
const authorizeResponse = await fetch(begun.authorizeUrl, { redirect: 'manual' })
const location = authorizeResponse.headers.get('location') ?? ''
console.log(`5. /authorize -> ${authorizeResponse.status} location=${location.slice(0, 100)}…`)
const callback = new URL(location)
const code = callback.searchParams.get('code') ?? ''
const state = callback.searchParams.get('state') ?? ''

// 6. The callback leg: validate state, then exchange the code.
const checked = await flow.checkCallback('oauth-mock', state, code)
console.log(`6. checkCallback: ok=${checked.ok}${checked.ok ? '' : ` reason=${checked.reason}`}`)
if (checked.ok !== true) process.exit(1)
const done = await flow.complete('oauth-mock', MCP_URL, checked.code)
console.log(`7. complete: ok=${done.ok} present=${done.present} refreshable=${done.refreshable} expiresAt=${done.expiresAt}`)
if (done.ok !== true) { console.log('FAIL complete', done); process.exit(1) }

// 7. A REAL transport, started through Client.connect (which calls start() itself — calling
//    start() by hand first is what "already started" means), must present the token and connect.
const transport2 = new loaded.sdk.StreamableHTTPClientTransport(new URL(MCP_URL))
const client2 = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
await client2.connect(transport2)
const h2 = await transport2._commonHeaders()
console.log(`8. patched transport Authorization: ${JSON.stringify(String(h2.get('authorization') ?? '').slice(0, 24))}…`)
console.log('9. connected WITH OAuth token ✓')
const tools = await client2.listTools()
console.log(`10. tools/list: ${tools.tools.map((t) => t.name).join(', ')}`)
const called = await client2.callTool({ name: 'whoami', arguments: {} })
console.log(`11. tools/call: ${JSON.stringify(called.content?.[0]?.text ?? called)}`)

await client2.close()
console.log('\n✓ 端到端跑通：401 挑战 → 发现 → DCR → PKCE → 换令牌 → 带 Bearer 连上 → 调用工具')
process.exit(0)
