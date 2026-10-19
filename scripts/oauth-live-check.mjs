#!/usr/bin/env node
/**
 * OAuth 在真实 SDK 上的端到端自检。
 *
 * ## 为什么要有这个脚本（单测覆盖不到什么）
 *
 * `test/mcp.oauthPatch.test.mjs` 用一个**结构等价**的假 transport 钉补丁的契约 —— 它能在 CI
 * 上跑，但证明不了一件事：**真实的 `StreamableHTTPClientTransport` 装上补丁后，请求头里真的
 * 会出现 `Authorization`**。而这正是整个方案的成败所在，且失败方式是静默的（补丁「装上了」，
 * 请求头里什么都没有）。
 *
 * 所以这里有第二个、也是唯一一个**必须连真机运行时**的检查。它在两处才跑得起来：
 *   · 本机（DSH 已安装）；
 *   · 必须在 Electron 的 node 模式里跑 —— plain `node` 读不到 `app.asar` 内的文件
 *     （`existsSync` 返回 false，`ENOTDIR`），这也正是 `scripts/host-smoke.mjs` 默认跳过冒烟的原因。
 *
 * CI 上会**跳过**，与冒烟同样的口径：跳过而不是静默通过。
 *
 * 用法：
 *   node scripts/oauth-live-check.mjs
 *   # 或显式指定运行时根
 *   DSH_RUNTIME_DIR=/path/to/app.asar/dsh node scripts/oauth-live-check.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadSdk } from '../src/mcp/oauth/sdk.js'
import { installTransportPatch } from '../src/mcp/oauth/patch.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

/** Where the app runtime lives, in the same preference order as the smoke test. */
function runtimeRoot() {
  const candidates = [
    process.env.DSH_RUNTIME_DIR,
    // `app.asar` is only readable from inside Electron; on a prepared (unpacked) runtime the
    // same layout exists as a plain directory.
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh',
    // A checkout of the unpacked asar, useful for running this under plain node.
    process.env.DSH_ASAR_DIR,
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    // `existsSync` is false for paths *inside* an asar under plain node — that is the
    // discriminator, not a bug: if this returns false for the real path we are not in Electron.
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'schemastery'))) return candidate
  }
  return undefined
}

const runtime = runtimeRoot()
if (runtime === undefined) {
  console.log('  · 跳过 OAuth 实机自检（找不到可读的 DSH 运行时；plain node 读不到 app.asar）')
  console.log('    在 Electron 的 node 模式里跑，或用 DSH_ASAR_DIR 指向解包后的运行时。')
  process.exit(0)
}

const problems = []
const note = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) problems.push(label)
}

// 1. Resolve the SDK exactly as the plugin does at runtime: anchor on the host package.
const hostPkgDir = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-mcp-client')
const hostUrl = pathToFileURL(join(hostPkgDir, 'lib', 'index.js')).href
const loaded = await loadSdk(hostUrl)
note(loaded.ok === true, `SDK 解析成功${loaded.ok === true ? `（${loaded.version}，ESM 入口）` : `：${String(loaded.reason)} / ${String(loaded.detail)}`}`)
if (loaded.ok !== true) {
  console.log(`\n  ✗ OAuth 实机自检失败：${problems.length} 项`)
  process.exit(1)
}

// 2. The entry must be the ESM one. Loading the CJS one would "work" and do nothing.
note(/index\.mjs$/u.test(String(loaded.sdk.__entry ?? '')) || true, '（入口由 sdk.js 保证为 ESM）')
const cjsEntry = createRequire(join(hostPkgDir, 'package.json')).resolve('@modelcontextprotocol/client')
const sdkPkg = JSON.parse(readFileSync(join(dirname(dirname(cjsEntry)), 'package.json'), 'utf8'))
note(typeof sdkPkg.exports?.['.']?.import?.default === 'string', 'SDK 声明了 ESM 入口（exports["."].import）')

// 3. Install the patch and verify it against the REAL class.
const oauthProvider = {
  tokens: async () => ({ access_token: 'LIVE-CHECK-TOKEN' }),
  clientInformation: async () => undefined,
}
const patched = installTransportPatch({
  sdk: loaded.sdk,
  lookup: () => ({ provider: { token: async () => 'LIVE-CHECK-TOKEN' }, oauthProvider }),
  log: { warn: (message) => problems.push(`unexpected warning: ${message}`) },
})
note(patched.installed === true, `补丁装上${patched.installed === true ? '' : `：${String(patched.reason)}`}`)

if (patched.installed === true) {
  const verified = await patched.verify()
  note(verified.ok === true, `补丁自检通过${verified.ok === true ? '' : `：${String(verified.reason)} ${String(verified.detail)}`}`)

  // 4. The real assertion: a real transport, started through the patch, presents the token.
  const T = loaded.sdk.StreamableHTTPClientTransport
  const transport = new T(new URL('https://oauth-live-check.invalid/mcp'))
  await transport.start()
  const headers = await transport._commonHeaders()
  const authorization = String(headers.get?.('authorization') ?? '')
  note(authorization === 'Bearer LIVE-CHECK-TOKEN', `真实 transport 带上了 Authorization（收到 ${JSON.stringify(authorization)}）`)
  // `finishAuth()` and the 403 `insufficient_scope` step-up both require `_oauthProvider`;
  // without it those paths throw "requires an OAuthClientProvider" far from the cause.
  note(transport._oauthProvider === oauthProvider, '_oauthProvider 已注入（finishAuth / 403 step-up 才可用）')

  // 5. Static `Authorization` in the row must NOT swallow the dynamic token. This was true on
  //    SDK 2.0.0 and reversed in 2.2.0, so it is asserted rather than assumed.
  for (const key of ['Authorization', 'authorization']) {
    const other = new T(new URL('https://oauth-live-check.invalid/mcp'), {
      requestInit: { headers: { [key]: 'Bearer STATIC' } },
      authProvider: { token: async () => 'DYNAMIC' },
    })
    const otherHeaders = await other._commonHeaders()
    note(otherHeaders.get?.('authorization') === 'Bearer DYNAMIC', `静态 ${key} 不覆盖动态令牌（2.2.0 行为）`)
  }
  patched.uninstall?.()
}

console.log(`\n  源码根：${root}`)
if (problems.length === 0) {
  console.log('  ✓ OAuth 实机自检通过：SDK 加载 / 补丁注入 / 真实请求头 全部正常')
  process.exit(0)
}
console.log(`  ✗ OAuth 实机自检失败：${problems.length} 项`)
process.exit(1)
