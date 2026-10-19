/**
 * 唯一接触 MCP SDK 的模块。
 *
 * ## 为什么必须单独一个文件
 *
 * 三件事只能在这一个地方发生，而且都必须能**如实失败**：
 *
 * 1. **解析 SDK**。本插件的 `package.json` 只声明 `peerDependencies`，真正的
 *    `@modelcontextprotocol/client` 是 `dsh-mcp-client` 的依赖。插件 import 不到它，
 *    必须从宿主包的位置反推出运行时 `node_modules` 根，再 `createRequire` 解析。
 * 2. **必须命中 ESM 入口**。SDK 是双包（`index.mjs` / `index.cjs`），两个 class 是
 *    **不同对象**（实测 `===` 为 false）。`dsh-mcp-client` 是 `"type": "module"`，
 *    走 ESM；补丁打在 CJS 那份上不会报错，只会静默失效 —— 也就是「授权按钮点了没反应，
 *    但哪里都没报错」。所以这里显式取 `exports['.'].import.default`。
 * 3. **能力检测**。SDK 升级可能改名/改私有字段。检测不到就返回原因，让面板显示
 *    「OAuth 支持未安装 + 原因」，绝不让面板显示一个其实没生效的按钮。
 *
 * ## 为什么不用 `import.meta.resolve('@modelcontextprotocol/client')`
 *
 * 实测在 plain node 下直接 `MODULE_NOT_FOUND`；即便在 Electron 里能解析，它给的是
 * **CJS** 入口（`index.cjs`），正是第 2 点要避开的那个。所以走「宿主包位置 → 运行时根
 * → createRequire → 读 package.json 的 exports 取 ESM 入口」这条路，两个问题一起解决。
 *
 * ## 不 import 宿主包
 *
 * 宿主包的路径由**调用方**传进来（`src/index.js` 自己 import 了 `dsh-mcp-client`，
 * 它知道 `import.meta.resolve` 的结果）。这样本模块在 CI 上也能被驱动，
 * 不会因为 CI 没有宿主 `node_modules` 而整片跳过。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** OAuth 支持可用/不可用的原因取值。面板直接展示 `reason`。 */
export const OAUTH_SDK_REASONS = Object.freeze({
  /** 宿主包的 URL 没拿到 —— 无法定位运行时根。 */
  noHostUrl: 'no-host-package-url',
  /** 宿主包不在 file: URL 下（例如被单文件打包），无法反推目录。 */
  notFileUrl: 'host-package-not-a-file-url',
  /** 从运行时根解析不到 SDK。 */
  sdkMissing: 'mcp-sdk-not-resolvable',
  /** SDK 的 package.json 读不出来或没有 ESM 入口。 */
  sdkShape: 'mcp-sdk-package-shape-unexpected',
  /** SDK 版本低于已知有 `authProvider` 的下限。 */
  sdkTooOld: 'mcp-sdk-too-old',
  /** 导入失败（语法/权限/打包异常）。 */
  importFailed: 'mcp-sdk-import-failed',
  /** 导入成功但缺少需要的导出。 */
  missingExport: 'mcp-sdk-export-missing',
})

/**
 * 已知支持 `authProvider` 的最低 SDK 版本。
 *
 * 2.0.0 就已经有 `authProvider`（不是 2.2.0 才加的）；这里只是把「已知能工作」的
 * 下限写死，避免在一个老版本上打补丁然后静默失效。
 */
export const MIN_SDK_MAJOR = 2

/** 从宿主包的 file: URL 反推运行时 `node_modules` 根。 */
export function runtimeNodeModulesFrom(hostUrl) {
  if (typeof hostUrl !== 'string' || hostUrl === '') {
    return { ok: false, reason: OAUTH_SDK_REASONS.noHostUrl, detail: '' }
  }
  if (!hostUrl.startsWith('file:')) {
    return { ok: false, reason: OAUTH_SDK_REASONS.notFileUrl, detail: hostUrl.slice(0, 60) }
  }
  let file
  try {
    file = fileURLToPath(hostUrl)
  } catch (error) {
    return { ok: false, reason: OAUTH_SDK_REASONS.notFileUrl, detail: String(error?.message ?? error) }
  }
  // <runtime>/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js
  //   dirname → …/lib   dirname → …/dsh-mcp-client   dirname → …/@deepseek-ai   dirname → …/node_modules
  const pkgDir = dirname(dirname(file))
  const scopeDir = dirname(pkgDir)
  const nodeModules = dirname(scopeDir)
  return { ok: true, nodeModules, pkgDir }
}

/**
 * 解析 SDK 的 ESM 入口 URL，不做 import。
 *
 * @param hostUrl - 宿主包（`dsh-mcp-client`）的 `file:` URL。
 * @returns `{ ok: true, url, version }` 或 `{ ok: false, reason, detail }`。
 */
export function resolveSdkEsmEntry(hostUrl) {
  const root = runtimeNodeModulesFrom(hostUrl)
  if (root.ok !== true) return root
  const anchor = join(root.nodeModules, '@deepseek-ai', 'dsh-mcp-client', 'package.json')
  let cjsEntry
  try {
    cjsEntry = createRequire(anchor).resolve('@modelcontextprotocol/client')
  } catch (error) {
    return { ok: false, reason: OAUTH_SDK_REASONS.sdkMissing, detail: String(error?.message ?? error) }
  }
  const pkgDir = dirname(dirname(cjsEntry))
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch (error) {
    return { ok: false, reason: OAUTH_SDK_REASONS.sdkShape, detail: String(error?.message ?? error) }
  }
  const esmRel = pkg?.exports?.['.']?.import?.default
  if (typeof esmRel !== 'string' || esmRel === '') {
    return { ok: false, reason: OAUTH_SDK_REASONS.sdkShape, detail: 'exports["."].import.default 缺失' }
  }
  const major = Number(String(pkg.version ?? '').split('.')[0])
  if (!Number.isFinite(major)) {
    return { ok: false, reason: OAUTH_SDK_REASONS.sdkShape, detail: `版本不可解析：${String(pkg.version)}` }
  }
  if (major < MIN_SDK_MAJOR) {
    return { ok: false, reason: OAUTH_SDK_REASONS.sdkTooOld, detail: String(pkg.version) }
  }
  return {
    ok: true,
    url: pathToFileURL(join(pkgDir, esmRel)).href,
    version: String(pkg.version),
    pkgDir,
  }
}

/** 需要从 SDK 拿到的导出。缺任何一个都算不可用 —— 打半个补丁比不打更糟。 */
const REQUIRED_EXPORTS = ['StreamableHTTPClientTransport', 'auth', 'extractWWWAuthenticateParams']

/**
 * 加载 SDK。
 *
 * @param hostUrl - 宿主包的 `file:` URL。
 * @param options.importModule - 注入的 `import()`，测试用。
 * @returns `{ ok: true, sdk, version }` 或 `{ ok: false, reason, detail }`。
 *   永不抛错：OAuth 是可选能力，装不上时面板要说「没装 + 原因」，而不是让插件加载失败。
 */
export async function loadSdk(hostUrl, options = {}) {
  const entry = resolveSdkEsmEntry(hostUrl)
  if (entry.ok !== true) return entry
  const importModule = options.importModule ?? ((specifier) => import(specifier))
  let sdk
  try {
    sdk = await importModule(entry.url)
  } catch (error) {
    return { ok: false, reason: OAUTH_SDK_REASONS.importFailed, detail: String(error?.message ?? error) }
  }
  const missing = REQUIRED_EXPORTS.filter((name) => sdk?.[name] === undefined)
  if (missing.length > 0) {
    return { ok: false, reason: OAUTH_SDK_REASONS.missingExport, detail: missing.join(', ') }
  }
  return { ok: true, sdk, version: entry.version }
}

/** 面向面板的一句话。缺 SDK 时用户看到的应该是「怎么修」，不是一段堆栈。 */
export function oauthSdkReasonText(result) {
  switch (result?.reason) {
    case OAUTH_SDK_REASONS.noHostUrl:
    case OAUTH_SDK_REASONS.notFileUrl:
      return '无法定位 DSH 的运行时目录，OAuth 支持不可用'
    case OAUTH_SDK_REASONS.sdkMissing:
      return '当前 DSH 运行时里找不到 MCP SDK（@modelcontextprotocol/client），OAuth 支持不可用'
    case OAUTH_SDK_REASONS.sdkShape:
      return 'MCP SDK 的包结构不是预期形状，OAuth 支持不可用'
    case OAUTH_SDK_REASONS.sdkTooOld:
      return `MCP SDK 版本过旧（${String(result?.detail ?? '')}），OAuth 支持不可用`
    case OAUTH_SDK_REASONS.importFailed:
      return 'MCP SDK 加载失败，OAuth 支持不可用'
    case OAUTH_SDK_REASONS.missingExport:
      return 'MCP SDK 缺少 OAuth 需要的导出，OAuth 支持不可用'
    default:
      return 'OAuth 支持不可用'
  }
}
