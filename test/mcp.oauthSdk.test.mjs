/**
 * mcp/oauth/sdk：从宿主包位置反推到 SDK 的 ESM 入口。
 *
 * 这段路径推导是整条 OAuth 链路的**第一块多米诺**：推错了就 import 不到 SDK，
 * 而失败表现是「OAuth 支持未安装」——一句正确但对排查没有帮助的话。所以测试直接钉住
 * 每个组成环节，并钉住**必须命中 ESM 入口**这一条（命中 CJS 会让原型补丁静默失效）。
 *
 * 不 import 宿主包：`hostUrl` 由调用方传进来，所以 CI 上也能跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_SDK_MAJOR, OAUTH_SDK_REASONS, loadSdk, oauthSdkReasonText, resolveSdkEsmEntry, runtimeNodeModulesFrom } from '../src/mcp/oauth/sdk.js'

/** The real runtime layout, expressed as paths only (no files are touched). */
const HOST_URL = 'file:///Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js'

test('runtimeNodeModulesFrom：从宿主包 URL 反推进 node_modules 根', { skip: process.platform === 'win32' ? '路径形态是 POSIX；Windows 由 fileURLToPath 转成盘符路径' : false }, () => {
  const root = runtimeNodeModulesFrom(HOST_URL)
  assert.equal(root.ok, true)
  assert.equal(root.nodeModules, '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules')
  assert.equal(root.pkgDir, '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-mcp-client')
})

test('runtimeNodeModulesFrom：非 file: URL 与空值都如实失败', () => {
  for (const bad of ['', null, undefined, 'node:fs', 'data:text/javascript,1']) {
    const result = runtimeNodeModulesFrom(bad)
    assert.equal(result.ok, false, String(bad))
    assert.ok([OAUTH_SDK_REASONS.noHostUrl, OAUTH_SDK_REASONS.notFileUrl].includes(result.reason), String(result.reason))
  }
})

test('resolveSdkEsmEntry：路径推导不到时返回原因，而不是抛错', { skip: process.platform === 'win32' ? 'POSIX 绝对路径夹具；Windows 上 file URL 会先被转成盘符路径' : false }, () => {
  // 一个不存在的运行时目录：createRequire 会失败，函数必须把失败收敛成 reason。
  const result = resolveSdkEsmEntry('file:///nonexistent-runtime/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js')
  assert.equal(result.ok, false)
  assert.equal(result.reason, OAUTH_SDK_REASONS.sdkMissing)
})

test('MIN_SDK_MAJOR：authProvider 在 2.x 就有，门槛不高于它', () => {
  // 这条一旦被改成 3，「2.2.0 上明明有 authProvider 却说版本过旧」就会重演。
  assert.equal(MIN_SDK_MAJOR, 2)
})

test('loadSdk：解析失败时不调用 import，且不抛错', async () => {
  let imported = 0
  const result = await loadSdk('', { importModule: async () => { imported += 1; return {} } })
  assert.equal(result.ok, false)
  assert.equal(imported, 0, '解析都没成功就不该去 import')
})

test('loadSdk：缺少必需导出时如实报告缺了哪个', async () => {
  // 用一个真实存在、但不是 SDK 的包目录来模拟「import 成功但导出不对」。
  const entry = resolveSdkEsmEntry(HOST_URL)
  if (entry.ok !== true) return // CI 上没有宿主运行时：这条路径本就无从验证
  const result = await loadSdk(HOST_URL, { importModule: async () => ({ StreamableHTTPClientTransport: function T() {} }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, OAUTH_SDK_REASONS.missingExport)
  assert.match(result.detail, /auth/)
  assert.match(result.detail, /extractWWWAuthenticateParams/)
})

test('loadSdk：import 抛错时收敛成原因，不冒泡', async () => {
  const entry = resolveSdkEsmEntry(HOST_URL)
  if (entry.ok !== true) return
  const result = await loadSdk(HOST_URL, { importModule: async () => { throw new Error('boom') } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, OAUTH_SDK_REASONS.importFailed)
  assert.match(result.detail, /boom/)
})

test('oauthSdkReasonText：每种原因都有人话，且都提到不可用', () => {
  for (const reason of Object.values(OAUTH_SDK_REASONS)) {
    const text = oauthSdkReasonText({ reason, detail: '2.0.0' })
    assert.equal(typeof text, 'string')
    assert.notEqual(text, '', reason)
    assert.match(text, /不可用/, reason)
  }
  // 未知原因也要有兜底句子，不能是 undefined
  assert.equal(typeof oauthSdkReasonText({}), 'string')
})
