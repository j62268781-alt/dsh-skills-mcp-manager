/**
 * mcp/oauth/store + provider：凭据落盘与 `OAuthClientProvider` 契约。
 *
 * 这两块是整条 OAuth 链路上**唯一不依赖 SDK** 的部分，所以也是唯一能在 CI 上被完整
 * 驱动的地方（CI 没有宿主 `node_modules`，`@modelcontextprotocol/client` 根本装不到）。
 *
 * 测试重心：
 *   · **凭据不能丢**。一份坏文件只该影响它自己那台服务器，而不是让全部授权一起消失；
 *   · **权限是安全属性**。`refresh_token` 长命，文件必须 0600；
 *   · **SDK 的契约细节**。`tokens()` 会被无参调用（每请求），`redirectUrl`/`clientMetadata`
 *     是 getter 而不是方法 —— 这两条抄错都不抛错，只是静默失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STORE_VERSION,
  createOAuthStore,
  emptyRecord,
  isValidServerName,
  normalizeRecord,
  oauthDir,
  oauthFile,
} from '../src/mcp/oauth/store.js'
import { createOAuthProvider, defaultClientMetadata, pendingIsFresh, randomState, tokenStatus } from '../src/mcp/oauth/provider.js'

/** A throwaway `$DSH_HOME`; `t.after` cleans it up so a failure cannot leave files behind. */
async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'smp-oauth-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('isValidServerName：路径分隔符与非常规字符一律拒绝', () => {
  for (const name of ['github', 'my-server_1', 'a.b-c']) assert.equal(isValidServerName(name), true, name)
  // 名字会进文件名，`../` 是目录穿越。
  for (const name of ['', '../evil', 'a/b', 'a\\b', '.', '..', 'a b', 'x'.repeat(65), null, 42]) {
    assert.equal(isValidServerName(name), false, `不该接受 ${String(name)}`)
  }
})

test('oauthFile：非法名字返回空串，而不是拼出一个危险路径', () => {
  assert.equal(oauthFile('/home/u/.dsh', '../evil'), '')
  assert.equal(oauthFile('/home/u/.dsh', 'ok'), join('/home/u/.dsh/dsh-skills-mcp-manager/oauth/ok.json'))
  assert.equal(oauthDir('/home/u/.dsh'), join('/home/u/.dsh/dsh-skills-mcp-manager/oauth'))
})

test('normalizeRecord：形状不对的字段逐个丢掉，整份不作废', () => {
  const raw = {
    version: STORE_VERSION,
    tokens: { access_token: 'a', token_type: 'Bearer' },
    // 这些都会被丢掉：不是对象 / 不是字符串
    clientInformation: 'nope',
    discoveryState: [1, 2, 3],
    codeVerifier: 42,
    pending: 'x',
  }
  const record = normalizeRecord(raw, 'github', 'https://api.example.com/mcp')
  assert.deepEqual(record.tokens, { access_token: 'a', token_type: 'Bearer' })
  assert.equal(record.clientInformation, null)
  assert.equal(record.discoveryState, null)
  assert.equal(record.codeVerifier, '')
  assert.equal(record.pending, null)
  assert.equal(record.url, 'https://api.example.com/mcp')
})

test('normalizeRecord：版本不认识时当作空记录（不猜结构）', () => {
  const future = normalizeRecord({ version: 999, tokens: { access_token: 'leak' } }, 'github', 'https://x/mcp')
  assert.equal(future.tokens, null)
  assert.equal(future.version, STORE_VERSION)
})

test('normalizeRecord：行里的 URL 优先于文件里记的旧 URL', () => {
  const moved = normalizeRecord({ version: STORE_VERSION, url: 'https://old.example.com/mcp' }, 'github', 'https://new.example.com/mcp')
  assert.equal(moved.url, 'https://new.example.com/mcp', 'URL 变了，旧凭据可能已经不对，以行为准')
})

test('store：写入的文件权限是 0600，目录是 0700', { skip: process.platform === 'win32' ? 'Windows 不实现 POSIX 权限位' : false }, async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  await store.write('github', { ...emptyRecord('github', 'https://x/mcp'), tokens: { access_token: 'secret' } })
  const file = oauthFile(home, 'github')
  const fileMode = (await stat(file)).mode & 0o777
  assert.equal(fileMode, 0o600, `凭据文件必须 0600，实际 ${fileMode.toString(8)}`)
  const dirMode = (await stat(oauthDir(home))).mode & 0o777
  assert.equal(dirMode, 0o700, `凭据目录必须 0700，实际 ${dirMode.toString(8)}`)
})

test('store：读不存在的记录返回空基线，不抛错', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const record = await store.read('never-authorized', 'https://x/mcp')
  assert.equal(record.tokens, null)
  assert.equal(record.url, 'https://x/mcp')
  assert.equal(record.version, STORE_VERSION)
})

test('store：一个坏文件只影响它自己，不波及其它服务器', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  await store.write('good', { ...emptyRecord('good', 'https://good/mcp'), tokens: { access_token: 'keep-me' } })
  // 手工写坏另一台
  await writeFile(oauthFile(home, 'bad'), '{ this is not json', 'utf8')
  const good = await store.read('good', 'https://good/mcp')
  assert.equal(good.tokens.access_token, 'keep-me')
  const bad = await store.read('bad', 'https://bad/mcp')
  assert.equal(bad.tokens, null, '坏文件退化成空记录，而不是抛错')
})

test('store：update 读到写回，且保留未触碰的字段', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  await store.write('github', { ...emptyRecord('github', 'https://x/mcp'), codeVerifier: 'verifier-1' })
  await store.update('github', 'https://x/mcp', (record) => {
    record.tokens = { access_token: 'tok' }
    record.tokensSavedAt = '2026-01-01T00:00:00.000Z'
  })
  const record = await store.read('github', 'https://x/mcp')
  assert.equal(record.codeVerifier, 'verifier-1', '没改的字段必须留下')
  assert.equal(record.tokens.access_token, 'tok')
  assert.equal(record.tokensSavedAt, '2026-01-01T00:00:00.000Z')
  // 落盘的是合法 JSON，且不含临时文件名残留
  const raw = await readFile(oauthFile(home, 'github'), 'utf8')
  assert.doesNotThrow(() => JSON.parse(raw))
})

test('store：remove 删掉凭据，重复调用返回 false 而不是抛错', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  await store.write('github', emptyRecord('github', 'https://x/mcp'))
  assert.equal(await store.remove('github'), true)
  assert.equal(await store.remove('github'), false)
  assert.equal(await store.remove('../evil'), false)
})

test('provider：redirectUrl 与 clientMetadata 是 getter，不是方法', () => {
  // SDK 用 `provider.redirectUrl` 直接读值；写成方法会得到一个函数对象，
  // OAuth 请求会带上错误的 redirect_uri，而且不会抛错。
  const { provider } = createOAuthProvider({
    store: createOAuthStore({ dshHome: '/tmp/does-not-matter' }),
    serverName: 'github',
    url: 'https://api.example.com/mcp',
    redirectUri: 'http://127.0.0.1:3080/dsh-skills-mcp-manager/oauth/callback',
  })
  assert.equal(typeof provider.redirectUrl, 'string')
  assert.equal(provider.redirectUrl, 'http://127.0.0.1:3080/dsh-skills-mcp-manager/oauth/callback')
  const metadata = provider.clientMetadata
  assert.equal(typeof metadata, 'object')
  assert.deepEqual(metadata.redirect_uris, [provider.redirectUrl])
  assert.equal(metadata.token_endpoint_auth_method, 'none', '公共客户端：没有 client_secret')
})

test('defaultClientMetadata：不声明 CIMD 所需的 clientMetadataUrl', () => {
  const metadata = defaultClientMetadata('http://127.0.0.1:1/cb')
  // CIMD（用 HTTPS URL 当 client_id）需要公网可访问的文档，桌面插件提供不了；
  // 声明了它会让 SDK 走那条路，然后在注册阶段失败。
  assert.equal('client_metadata_url' in metadata, false)
  assert.equal('clientMetadataUrl' in metadata, false)
})

test('provider：state() 每轮新生成，且与随后存进 pending 的值一致', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const { provider, snapshot } = createOAuthProvider({ store, serverName: 'github', url: 'https://x/mcp', redirectUri: 'http://127.0.0.1:1/cb' })
  const first = await provider.state()
  const second = await provider.state()
  assert.notEqual(first, second, '每轮必须新 state，复用会让重放成立')
  assert.match(first, /^[A-Za-z0-9_-]+$/)
  // redirectToAuthorization 是 SDK 记录 state 的时机（那时才知道授权 URL）
  await provider.redirectToAuthorization(new URL('https://as.example.com/authorize?x=1'))
  const record = await snapshot()
  assert.equal(record.pending.state, second, 'state 必须落在 pending 里，回调才好比')
  assert.equal(record.pending.url, 'https://as.example.com/authorize?x=1')
})

test('provider：redirectToAuthorization 不阻塞、把 URL 交给上层', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const seen = []
  const { provider } = createOAuthProvider({
    store, serverName: 'github', url: 'https://x/mcp', redirectUri: 'http://127.0.0.1:1/cb',
    onRedirect: async (url) => { seen.push(url) },
  })
  await provider.redirectToAuthorization(new URL('https://as.example.com/a?b=1'))
  assert.deepEqual(seen, ['https://as.example.com/a?b=1'])
})

test('provider：tokens() 无参调用返回最近保存的那一份', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const { provider } = createOAuthProvider({ store, serverName: 'github', url: 'https://x/mcp', redirectUri: 'http://127.0.0.1:1/cb' })
  assert.equal(await provider.tokens(), undefined)
  await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r1' })
  // transport 每发一个请求都这样问一次。
  const tokens = await provider.tokens()
  assert.equal(tokens.access_token, 'a1')
  assert.equal(tokens.refresh_token, 'r1')
})

test('provider：saveTokens 清掉一次性状态（pending / codeVerifier）', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const { provider, snapshot } = createOAuthProvider({ store, serverName: 'github', url: 'https://x/mcp', redirectUri: 'http://127.0.0.1:1/cb' })
  await provider.state()
  await provider.saveCodeVerifier('verifier-abc')
  await provider.redirectToAuthorization(new URL('https://as.example.com/a'))
  await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer' })
  const record = await snapshot()
  assert.equal(record.pending, null, '授权完成后再留 pending 会让下一轮误以为还在等回调')
  assert.equal(record.codeVerifier, '')
})

test('provider：codeVerifier() 缺失时给出人话错误', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const { provider } = createOAuthProvider({ store, serverName: 'github', url: 'https://x/mcp', redirectUri: 'http://127.0.0.1:1/cb' })
  await assert.rejects(() => provider.codeVerifier(), /code_verifier/)
})

test('provider：clientInformation 与 discoveryState 往返', async (t) => {
  const home = await tempHome(t)
  const store = createOAuthStore({ dshHome: home })
  const { provider } = createOAuthProvider({ store, serverName: 'github', url: 'https://x/mcp', redirectUri: 'http://127.0.0.1:1/cb' })
  assert.equal(await provider.clientInformation(), undefined)
  await provider.saveClientInformation({ client_id: 'cid', issuer: 'https://as.example.com' })
  assert.deepEqual(await provider.clientInformation(), { client_id: 'cid', issuer: 'https://as.example.com' })
  assert.equal(await provider.discoveryState(), undefined)
  await provider.saveDiscoveryState({ authorizationServerUrl: 'https://as.example.com' })
  assert.equal((await provider.discoveryState()).authorizationServerUrl, 'https://as.example.com')
})

test('tokenStatus：expires_in 是相对秒数，绝对时间靠 tokensSavedAt 换算', () => {
  const savedAt = '2026-01-01T00:00:00.000Z'
  const record = { tokens: { access_token: 'a', token_type: 'Bearer', expires_in: 3600 }, tokensSavedAt: savedAt }
  const now = Date.parse(savedAt) + 1000
  const status = tokenStatus(record, now)
  assert.equal(status.present, true)
  assert.equal(status.expired, false)
  assert.equal(status.expiresAt, '2026-01-01T01:00:00.000Z')
  // 一小时零一秒之后：过期
  assert.equal(tokenStatus(record, Date.parse(savedAt) + 3601 * 1000).expired, true)
})

test('tokenStatus：没有 expires_in 时如实返回空串，不编一个时间', () => {
  const status = tokenStatus({ tokens: { access_token: 'a', token_type: 'Bearer' }, tokensSavedAt: '2026-01-01T00:00:00.000Z' })
  assert.equal(status.present, true)
  assert.equal(status.expiresAt, '')
  assert.equal(status.expired, false)
})

test('tokenStatus：没有令牌时 present=false，且不把空串当成令牌', () => {
  for (const record of [{}, { tokens: null }, { tokens: { access_token: '', token_type: 'Bearer' } }]) {
    const status = tokenStatus(record)
    assert.equal(status.present, false, JSON.stringify(record))
    assert.equal(status.refreshable, false)
  }
})

test('tokenStatus：refresh_token 决定 refreshable', () => {
  assert.equal(tokenStatus({ tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' } }).refreshable, true)
  assert.equal(tokenStatus({ tokens: { access_token: 'a', token_type: 'Bearer' } }).refreshable, false)
})

test('pendingIsFresh：过期或缺失都算「没有进行中的授权」', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  assert.equal(pendingIsFresh({ pending: { expiresAt: '2026-01-01T00:01:00.000Z' } }, now), true)
  assert.equal(pendingIsFresh({ pending: { expiresAt: '2025-12-31T23:59:00.000Z' } }, now), false)
  assert.equal(pendingIsFresh({ pending: null }, now), false)
  assert.equal(pendingIsFresh({}, now), false)
  assert.equal(pendingIsFresh({ pending: { expiresAt: 'not-a-date' } }, now), false)
})

test('randomState：base64url 且不重复', () => {
  const a = randomState()
  const b = randomState()
  assert.match(a, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(a, b)
})
