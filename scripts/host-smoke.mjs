/**
 * Host-half smoke test: load the built plugin the way DSH does and drive its **real write
 * paths** through the HTTP routes, asserting that nothing throws and that the files on disk
 * actually changed.
 *
 * Why this exists: an uncaught exception during plugin load makes DSH treat the profile as
 * broken and run `sanitizeProfile`, which quarantines the user's whole cordis.patch.yml and
 * disables every non-recovery plugin. Compiling and unit tests cannot see that class of bug
 * — only running the code path can.
 *
 * ## What changed in 0.5.6 (and why this file was rewritten)
 *
 * Everything used to travel the **settings document**: the panel wrote `skillRequest` /
 * `rowOps` / `reconnectRequest`, the Host drained them on a timer and published
 * `profileServers` / `oauthState` / `probeState` back. That round trip cost 2–9 s for 1–5 ms
 * of disk work, and the published projection was observed going stale (the panel needed a
 * settings-page reopen to see a new row).
 *
 * Commands are now ordinary `POST` requests, and the list is computed on demand from the
 * patch file. So this smoke asserts the things that can now break silently:
 *
 *   · every route is registered, and each refuses a GET (they write files);
 *   · a skill write lands on disk **and** in the response, in the same round trip;
 *   · a row write lands in `cordis.patch.yml` and the answer already lists the new row —
 *     no waiting for the Loader to reload the profile (that was the 4 s);
 *   · the settings surface keeps only `toolFilters`, and the Host never writes settings;
 *   · the read-only `/runtime` answer carries the live view (tools, status, probe, filter,
 *     discovery, OAuth) instead of publishing it through settings.
 *
 * The plugin imports @deepseek-ai/* packages that only exist next to the app, so we stage a
 * package dir whose node_modules/@deepseek-ai points at the app's.
 */
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, stringify } from 'yaml'
import { RUNTIME_PATH } from '../src/mcp/runtime.js'
import { ROWS_PATH } from '../src/mcp/rows.js'
import { SKILLS_PATH } from '../src/skills/route.js'
import { SKILL_READ_PATH } from '../src/skills/read.js'
import { RECONNECT_PATH } from '../src/mcp/reconnect.js'
import { IMPORT_PATH } from '../src/import/route.js'
import { OAUTH_PATH } from '../src/mcp/oauth/route.js'
import { CALLBACK_PATH } from '../src/mcp/oauth/callback.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const appNodeModules = [
  process.env.DSH_APP_NODE_MODULES,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
  '/tmp/dshroot/dsh/node_modules',
// The candidate must be able to resolve the plugin's own dependencies, not just
// contain an @deepseek-ai folder: the app bundle ships a trimmed set.
].find((dir) => dir !== undefined && existsSync(join(dir, '@deepseek-ai', 'schemastery')))

/**
 * 找不到 app 的 node_modules 时跳过 —— 但要**说得足够响**。
 *
 * 这个冒烟需要 DSH 本体提供的 `@deepseek-ai/*` 包，CI 上没有，所以跳过必须是成功退出，
 * 否则门禁在任何 CI 里都会红。代价是：CI「通过」并不代表冒烟跑过。这个洞曾经把一条完全
 * 红的分支藏了整整一晚上（重构删掉了 settings 通道，冒烟还在断言它，46 条全红，而 CI 绿）。
 *
 * 所以两件事：
 *   · 跳过时打一条 ⚠，让「没跑」和「跑过且通过」在日志里长得不一样；
 *   · 设 `SMP_SMOKE_REQUIRED=1` 时把跳过变成失败，发布流程可以用它确保这一关真的过了。
 */
if (appNodeModules === undefined) {
  if (process.env.SMP_SMOKE_REQUIRED === '1') {
    console.log('  ✗ Host 冒烟没有运行：找不到 app 的 node_modules（SMP_SMOKE_REQUIRED=1）')
    console.log('    指定 DSH_APP_NODE_MODULES，或去掉 SMP_SMOKE_REQUIRED')
    process.exit(1)
  }
  console.log('  ⚠ 未运行 Host 冒烟（找不到 app 的 node_modules；可用 DSH_APP_NODE_MODULES 指定）')
  console.log('    「跳过」不等于「通过」：这一关只在装有 DSH 本体的机器上才真正生效。')
  process.exit(0)
}

// Build the Host half. Run the local TypeScript entry directly instead of through
// `npx`: a machine can have Node without npm (`execFileSync` also refuses to launch
// a `.cmd` shim on Windows), and a gate that silently cannot run is not a gate.
const tscEntry = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tscEntry)) throw new Error(`typescript is not installed at ${tscEntry} — run the package manager install first`)
execFileSync(process.execPath, [tscEntry, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })

// Stage inside the workspace's node_modules so the plugin's own third-party deps
// (yaml) resolve naturally; only @deepseek-ai/* has to come from the app.
const stage = join(root, 'node_modules', 'dsh-smoke-stage')
const scopeLink = join(root, 'node_modules', '@deepseek-ai')
const createdScopeLink = !existsSync(scopeLink)
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
if (createdScopeLink) {
  // A directory junction instead of a symlink: creating a symlink on Windows needs
  // Developer Mode or elevation, and this gate must run for every contributor.
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', scopeLink, join(appNodeModules, '@deepseek-ai')], { stdio: 'ignore' })
  } else {
    await symlink(join(appNodeModules, '@deepseek-ai'), scopeLink, 'dir')
  }
}

/**
 * Make sibling `@deepseek-ai` packages resolvable from inside the scope.
 *
 * The app bundle keeps them flat (`<nm>/@deepseek-ai/<pkg>`), which its own asar
 * loader resolves but plain Node does not: `schemastery` asks for
 * `@deepseek-ai/cosmokit`, and Node only ever walks *up* from the importing file —
 * `<nm>/@deepseek-ai/schemastery/node_modules` → `<nm>/@deepseek-ai/node_modules` →
 * `<nm>/node_modules` — never sideways into its own scope directory, where the
 * package actually sits.
 *
 * Pointing `-AppNodeModules` at a real `node_modules` therefore only needs one extra
 * hop: a `node_modules` inside the scope dir, holding the scope itself.
 */
const scopeDir = join(appNodeModules, '@deepseek-ai')
const innerScope = join(scopeDir, 'node_modules')
if (!existsSync(join(innerScope, '@deepseek-ai'))) {
  await mkdir(innerScope, { recursive: true })
  const link = join(innerScope, '@deepseek-ai')
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, scopeDir], { stdio: 'ignore' })
  } else {
    await symlink(scopeDir, link, 'dir')
  }
}
const problems = []
const note = (ok, label) => {
  console.log((ok ? '    ✓ ' : '    ✗ ') + label)
  if (!ok) problems.push(label)
}

let escaped = null
process.on('uncaughtException', (error) => { escaped = 'uncaughtException: ' + error.message })
process.on('unhandledRejection', (error) => { escaped = 'unhandledRejection: ' + (error?.message ?? error) })

// Declared outside the `try` because the `finally` below has to restore it: the stub is
// installed inside the block, but a binding created there is out of scope for cleanup.
const realFetch = globalThis.fetch

// ── Fixtures ────────────────────────────────────────────────────────────────────────────
//
// **One definition, two destinations.** Every row is written both into the profile patch
// file and into the Loader mock, generated from this list. They must agree: the Host now
// prefers the file (so a row is visible the instant it is written) and borrows only the
// runtime `phase` off the Loader, so a fixture that existed in one place only would make
// the status assertions describe a row the other side cannot see.
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const FIXTURES = [
  { id: 'mcp-smoke-server', serverName: 'smoke-server', url: 'https://smoke.invalid/mcp', fiber: 2 },
  // A second row with no tools, LOADING until the smoke flips it — proves a slow first
  // connection is reported as "still connecting", not as an activation failure.
  { id: 'mcp-smoke-idle', serverName: 'smoke-idle', url: 'https://idle.invalid/mcp', fiber: 1 },
  // Provider exists, client refuses: "not connected", which is a different fix from
  // "activation failed" and must not be collapsed.
  { id: 'mcp-smoke-dead', serverName: 'smoke-dead', url: 'https://dead.invalid/mcp', fiber: 2 },
  // Refuses until authorized. Its 401 is invisible through `mcpResources` (the client
  // throws "server is disconnected" before any HTTP), so the Host probes over HTTP.
  { id: 'mcp-smoke-auth', serverName: 'smoke-auth', url: 'https://auth.smoke.invalid/mcp', fiber: 2 },
  // Project scope. `disabled: true` is mandatory: the Loader honours `disabled`, not
  // `scope`, so an enabled one would be connected twice (see src/mcp/serverRows.js).
  {
    id: 'mcp-smoke-project', serverName: 'smoke-project', url: 'https://project.invalid/mcp',
    fiber: 2, scope: '/p/smoke', disabled: true,
  },
]

/** The patch file the Host reads and writes, in the shape `applyRowOp` produces. */
const patchText = stringify([{
  insert: FIXTURES.map((fixture) => ({
    id: fixture.id,
    name: MCP_MODULE,
    ...(fixture.disabled === true ? { disabled: true } : {}),
    config: {
      serverName: fixture.serverName,
      transport: 'streamable-http',
      url: fixture.url,
      ...(fixture.scope === undefined ? {} : { scope: fixture.scope }),
    },
  })),
}], { lineWidth: 0 })

try {
  const pkgDir = stage
  await cp(join(root, 'dist'), join(pkgDir, 'dist'), { recursive: true })
  await cp(join(root, 'package.json'), join(pkgDir, 'package.json'))

  const home = join(stage, 'home')
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = join(stage, 'agents')
  // A skill on disk up front, so the discovery scan has something to find and the read
  // route has a path it will accept.
  await mkdir(join(home, 'skills', 'smoke-discovered'), { recursive: true })
  const discoveredFile = join(home, 'skills', 'smoke-discovered', 'SKILL.md')
  await writeFile(discoveredFile, '---\nname: smoke-discovered\ndescription: 发现通道冒烟\n---\n\n# 发现\n')
  await mkdir(join(stage, 'stagingMarker'), { recursive: true })
  // A project marker: `projectRootOf` walks up to the nearest ancestor holding `.git`,
  // so without it a project skill lands in some unrelated ancestor.
  await mkdir(join(stage, '.git'), { recursive: true })

  // The profile the Host writes into. `applyRowOp` resolves it through the
  // `profileContext` service, so this is the seam that keeps the smoke off the real profile.
  const profileDir = join(stage, 'profile')
  await mkdir(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await writeFile(patchPath, patchText)

  const live = { toolFilters: {}, __updates: 0, profileContext: { dir: profileDir } }
  const noop = () => {}

  /**
   * The auth probe's network seam.
   *
   * The Host's auth probe builds its own `fetch` call (it cannot go through
   * `mcpResources`, which throws "server is disconnected" before any HTTP happens), so the
   * smoke has to stand in for the network. `smoke-auth` answers 401 with a Bearer challenge;
   * anything else answers 200. Installed on `globalThis` only for the duration of the run
   * and restored in the caller's `finally`.
   */
  const authProbeRequests = []
  globalThis.fetch = async (url, init) => {
    authProbeRequests.push({ url: String(url), method: init?.method })
    const headers = { get: () => null }
    if (String(url).includes('auth.smoke.invalid')) {
      return {
        status: 401,
        headers: {
          get: (name) => (String(name).toLowerCase() === 'www-authenticate'
            ? 'Bearer error="invalid_token", scope="mcp:read", error_description="authorization required"'
            : null),
        },
        body: { cancel: async () => {} },
      }
    }
    return { status: 200, headers, body: { cancel: async () => {} } }
  }

  const mod = await import(pathToFileURL(join(pkgDir, 'dist', 'index.js')).href)

  /**
   * The plugin **must** export its `Config` schema.
   *
   * This is not a formality: the host's settings service resolves a namespace by finding a
   * configurable entry and reading *its schema* (`configEditor.entries()` → `this.schema(entry)`),
   * and throws `No configurable plugin entry "<ns>"` when it cannot. A missing `Config` export
   * does not fail loudly at load — it silently rejects every panel write.
   *
   * That is exactly what shipped in 081bcfc: an edit inserted a doc comment between `export` and
   * `const Config`, so the keyword bound to the next declaration and `Config` stopped being
   * exported. `apply` still ran, so a smoke that only checks "the plugin loaded" passed.
   */
  note(mod.Config !== undefined, '插件导出了 Config（settings 服务靠它解析命名空间）')
  note(typeof mod.apply === 'function', '插件导出了 apply')

  /**
   * The settings surface is now **one field**.
   *
   * Everything else (skills, rows, requests, results, projections) left the settings
   * document in 0.5.6, and that is the whole point of the refactor: the document was both
   * slow to round-trip and observed going stale in the panel. A leftover field would
   * quietly re-open that channel, so assert the absence rather than trusting the diff.
   */
  {
    const configDict = mod.Config?.dict ?? {}
    const gone = [
      'servers', 'skills', 'rowOps', 'profileServers', 'discoveredSkills',
      'skillRequest', 'skillResult', 'importRequest', 'importResult',
      'reconnectRequest', 'reconnectResult', 'oauthState', 'oauthServers',
      'probeState', 'filterState', 'skillDirs', 'workspaces', 'currentWorkspace',
    ].filter((key) => configDict[key] !== undefined)
    note(gone.length === 0, `settings 文档只剩 toolFilters（残留：${gone.join(', ') || '无'}）`)
    note(configDict.toolFilters !== undefined, 'Config 里有 toolFilters')
    note(configDict.toolFilters?.meta?.volatile === true,
      'toolFilters 声明了 volatile（否则面板写它会被宿主拒绝）')
  }

  // ── Harness services ──────────────────────────────────────────────────────────────────
  /** Tools the registry actually accepted (i.e. what the model would be offered). */
  const registered = []
  /**
   * The live agent the project row is mounted into.
   *
   * Deliberately created BEFORE `apply`, and deliberately never announced through
   * `ctx.on('agent/created')` (a no-op in this harness). That is the exact shape of the bug
   * this covers: an agent that already existed when the plugin loaded never delivers a
   * creation event to it, so the plugin's own map stays empty and a correctly-scoped project
   * server is never mounted. `agents.list()` is the only way to discover it.
   */
  const mountCalls = []
  const liveAgent = {
    id: 'smoke-agent',
    session: { cwd: '/p/smoke' },
    ctx: {
      plugin(plugin, config) {
        mountCalls.push({ serverName: config?.serverName, cwd: '/p/smoke' })
        return { dispose: noop }
      },
    },
  }
  const agentsService = { list: () => [liveAgent] }
  /**
   * The tool registry, scoped like the real one.
   *
   * `tools.register()` files a definition under the **registering context's scope**, and
   * `schemas()` without a scope reads the **global** view. A project server is mounted into
   * an agent's scope, so its tools exist only in that scope's view — an unscoped read cannot
   * see them, which is why every project server used to show an empty tool list while the
   * card looked configured. This mock reproduces that split.
   */
  const projectTools = [
    { name: 'mcp__smoke-project__search', description: 'Project-scoped tool' },
    { name: 'mcp__smoke-project__get_file', description: 'Another project tool' },
  ]
  const toolsService = {
    register(definition) {
      registered.push(definition.name)
      return () => {
        const at = registered.indexOf(definition.name)
        if (at >= 0) registered.splice(at, 1)
      }
    },
    schemas: (scope) => [
      { name: 'mcp__smoke-server__echo', description: 'Echo back' },
      { name: 'mcp__smoke-server__ping', description: '' },
      { name: 'read_file', description: 'built-in, not from MCP' },
      // Only visible to the agent whose scope the project row was mounted into.
      ...(scope === liveAgent ? projectTools : []),
    ],
  }
  /**
   * The service the panel probes for connection state.
   *
   * Present here on purpose: the probe goes through this public `request()`, so the smoke has
   * to prove the Host actually drives it and maps the answers — connected, disconnected, and
   * no-provider — onto different labels.
   */
  const probeRequests = []
  const mcpResourcesService = {
    async request(server, request, exec) {
      probeRequests.push({ server, method: request?.method, agent: exec?.agent })
      // Provider present, client not connected.
      if (server === 'smoke-dead') throw new Error(`mcp-client(${server}): server is disconnected`)
      // Same shape for the auth-protected row: a server that refuses the connection until it
      // is authorized is *not connected*, so the client throws before any HTTP happens. That
      // is exactly why the 401 is invisible here and the Host needs its own probe.
      if (server === 'smoke-auth') throw new Error(`mcp-client(${server}): server is disconnected`)
      // No provider at all — the "never mounted / activation failed" answer, which must be
      // distinguishable from the one above.
      if (server === 'smoke-idle') throw new Error(`MCP resource server "${server}" is unavailable in this agent's scope`)
      return { resources: [] }
    },
  }
  /**
   * Loader entries, held in a stable array.
   *
   * Deliberately NOT built per call: the smoke mutates a fiber state mid-run to prove the
   * status reacts to it, and a fresh array per call would silently drop that mutation — the
   * assertion would then pass or fail for the wrong reason.
   *
   * The entry carries `fiber` (a Fiber object), NOT `fiberPhase`: that name is derived by
   * `dsh-host-plugin-inventory`, and reading it off a raw entry yields '' forever.
   */
  const loaderEntries = FIXTURES.map((fixture) => ({
    id: fixture.id,
    disabled: fixture.disabled === true,
    options: {
      name: MCP_MODULE,
      config: {
        serverName: fixture.serverName,
        transport: 'streamable-http',
        url: fixture.url,
        ...(fixture.scope === undefined ? {} : { scope: fixture.scope }),
      },
    },
    fiber: { state: fixture.fiber },
  }))

  /** Every route the plugin registered, by path. */
  const routes = new Map()
  /**
   * The `webServer` service, shared by `ctx.get('webServer')` and `ctx.inject([...])`.
   *
   * Both are the *same* service in the real runtime, so the stub must expose one object the
   * same two ways. Exposing it only through `inject` was not the real shape, and that
   * mismatch hid a real bug: `oauthRedirectUri()` reads it via `ctx.get('webServer')`, so it
   * published `redirectUri: ''` while `ready` still said true — and an empty `redirect_url`
   * makes the SDK treat the flow as non-interactive.
   */
  const webServer = {
    getOrigin: () => 'http://127.0.0.1:3080',
    register: (route) => { routes.set(route.path, route); return noop },
  }
  const ctx = {
    logger: { info: noop, warn: noop, error: (...args) => problems.push('host logger.error: ' + args.map(String).join(' ')) },
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [] }
      if (name === 'tools') return toolsService
      if (name === 'mcpResources') return mcpResourcesService
      if (name === 'agents') return agentsService
      if (name === 'webServer') return webServer
      if (name === 'profileContext') return live.profileContext
      return undefined
    },
    loader: {
      // Exactly as the Loader reports it. `configuredEntries` merges these with the patch
      // file, borrowing the runtime `fiber` state for rows the file also lists.
      entries: () => loaderEntries,
    },
    effect: (fn) => { fn(); return noop },
    plugin: () => ({ dispose: noop }),
    on: () => noop,
    inject: (names, cb) => cb({
      webServer,
      // Same resolver as the root context: `applyRowOp` finds the profile through
      // `ctx.get('profileContext')`, and the route handlers are handed *this* object.
      get: (name) => ctx.get(name),
      connection: { requestRejection: () => undefined },
      logger: { warn: noop, info: noop, error: noop },
      effect: (fn) => { fn(); return noop },
      /**
       * Counted, never expected to be called.
       *
       * The Host wrote the settings document on every publish tick; the refactor removed that
       * entirely. Counting here is what turns "we deleted the writes" into an assertion: a
       * resurrected `settings.update` fails the smoke instead of quietly costing a round trip.
       */
      settings: { update: async () => { live.__updates += 1; return true } },
    }),
  }
  /**
   * The only live settings field.
   *
   * Read **per registration** by the filter (`readFilters()`), which is what makes the
   * allow/deny/off assertions below meaningful without restarting the plugin.
   */
  const config = { toolFilters: { get: () => live.toolFilters } }

  try {
    mod.apply(ctx, config)
    await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
  } catch (error) {
    escaped = 'apply threw: ' + error.message
  }

  note(escaped === null, '没有异常逃逸出插件（' + (escaped ?? '干净') + '）')

  // ── Request helpers ───────────────────────────────────────────────────────────────────
  /**
   * Drive one route the way the browser does.
   *
   * The handlers read the body through `req.on('data'|'end')` and answer through
   * `res.end()`, so the fake has to be an EventEmitter-shaped object rather than a plain
   * `{method}` literal (which is all the earlier version needed for its 405 checks).
   */
  const callRoute = async (path, { method = 'POST', body, headers = {}, url } = {}) => {
    const route = routes.get(path)
    if (route === undefined) throw new Error(`route not registered: ${path}`)
    const text = body === undefined ? '' : JSON.stringify(body)
    const req = {
      method,
      url: url ?? path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      on(event, fn) {
        if (event === 'data' && text !== '') fn(Buffer.from(text))
        if (event === 'end') fn()
        return req
      },
      destroy: noop,
    }
    let out = ''
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this },
      writeHead(status, extra) { this.statusCode = status; Object.assign(this.headers, extra ?? {}); return this },
      end(value = '') { out = value },
    }
    await route.handler(req, res)
    let json
    try { json = JSON.parse(out) } catch { json = undefined }
    return { status: res.statusCode, headers: res.headers, text: out, json }
  }
  const readRuntime = async () => {
    const response = await callRoute(RUNTIME_PATH, { method: 'GET' })
    if (response.status !== 200) throw new Error(`runtime HTTP ${response.status}`)
    return response.json
  }

  // ── 1. Every route is registered, and each refuses the wrong method ──────────────────
  //
  // Registration is asserted for all of them because a route that silently did not register
  // is indistinguishable, from the panel's side, from a click that does nothing. The 405 is
  // asserted because these handlers **write files**: a GET must never reach the write path.
  const writeRoutes = [
    [ROWS_PATH, 'rows'],
    [SKILLS_PATH, 'skills'],
    [RECONNECT_PATH, 'reconnect'],
    [IMPORT_PATH, 'import'],
    [OAUTH_PATH, 'oauth'],
  ]
  for (const [path, label] of writeRoutes) {
    note(routes.get(path) !== undefined, `${label} 路由已注册（POST ${path}）`)
    if (routes.get(path) === undefined) continue
    const response = await callRoute(path, { method: 'GET' })
    note(response.status === 405, `${label} 路由只接受 POST（GET 得到 ${response.status}）`)
    note(response.text === '', `${label} 拒绝时没有产生响应体`)
  }
  // The read route is GET-only, the mirror image.
  note(routes.get(SKILL_READ_PATH) !== undefined, `技能读取路由已注册（GET ${SKILL_READ_PATH}）`)
  if (routes.get(SKILL_READ_PATH) !== undefined) {
    const response = await callRoute(SKILL_READ_PATH, { method: 'POST', body: {} })
    note(response.status === 405, `技能读取路由只接受 GET（POST 得到 ${response.status}）`)
  }
  // A write route with a form-encoded body must be refused: that is the shape a cross-site
  // HTML form can send, and demanding `application/json` is what closes it.
  if (routes.get(ROWS_PATH) !== undefined) {
    const text = JSON.stringify({ op: 'delete', entryId: 'mcp-nope' })
    const req = {
      method: 'POST', url: ROWS_PATH, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      on(event, fn) {
        if (event === 'data') fn(Buffer.from(text))
        if (event === 'end') fn()
        return req
      },
      destroy: noop,
    }
    const res = {
      statusCode: 0, headers: {},
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); return this },
      end() {},
    }
    await routes.get(ROWS_PATH).handler(req, res)
    note(res.statusCode === 415, `非 JSON 的写入被拒绝（得到 ${res.statusCode}，期望 415）`)
  }

  // ── 2. Skills: create / update / rename / delete / read, over HTTP ──────────────────
  //
  // Every assertion here is "the file on disk says so", because that is what DSH actually
  // loads. The response is checked too: the panel applies it directly, so a reply that
  // disagrees with the disk is a bug the user sees as a card that lies.
  const skillOp = (op, extra = {}) => callRoute(SKILLS_PATH, {
    body: {
      op, scope: 'global', id: 'dsh', project: '', path: '', name: '',
      prevName: '', description: '', body: '', nonce: `smoke-${op}-${Date.now()}`,
      ...extra,
    },
  })

  const created = await skillOp('create', { name: 'smoke-skill', description: '冒烟', body: '# 冒烟正文' })
  note(created.status === 200 && created.json?.ok === true, `技能创建成功（HTTP ${created.status} / ${created.json?.reason ?? ''}）`)
  const skillFile = join(home, 'skills', 'smoke-skill', 'SKILL.md')
  note(existsSync(skillFile), '技能文件确实写到磁盘')
  note((created.json?.nonce ?? '') !== '', '回执带回了 nonce（面板据此配对）')

  const updated = await skillOp('update', { name: 'smoke-skill', description: '冒烟', body: '# 改后正文' })
  note(updated.json?.ok === true && readFileSync(skillFile, 'utf8').includes('# 改后正文'), 'update 就地改写正文')

  // rename: the user's actual question — does the folder move too? It must, because DSH
  // takes the name from the frontmatter but treats the directory as the resource base.
  const renamed = await skillOp('rename', { name: 'smoke-renamed', prevName: 'smoke-skill', description: '冒烟', body: '# 改后正文' })
  const oldDir = join(home, 'skills', 'smoke-skill')
  const newFile = join(home, 'skills', 'smoke-renamed', 'SKILL.md')
  note(renamed.json?.ok === true && !existsSync(oldDir) && existsSync(newFile), 'rename 把目录一起改名（旧目录消失、新目录存在）')
  if (existsSync(newFile)) {
    note(/name:\s*smoke-renamed/.test(readFileSync(newFile, 'utf8')), 'rename 同步改写了 frontmatter 的 name')
  } else {
    note(false, 'rename 后读不到新目录的 SKILL.md')
  }
  const backups = existsSync(join(home, 'skills')) ? readdirSync(join(home, 'skills')).filter((name) => name.startsWith('.smp-backup-')) : []
  note(backups.length > 0, `rename 之前留了备份（${backups.length} 个 .smp-backup-*）`)
  note((await skillOp('create', { name: 'smoke-renamed', body: 'x' })).json?.ok === false, '同名再创建被拒绝（不覆盖既有技能）')

  // Read: the preview asks for a file **by path**, and the Host only accepts a path that its
  // own scan produced — the path is client-supplied, so it must be proved to be ours.
  const runtimeAfterScan = await readRuntime()
  const discovered = Array.isArray(runtimeAfterScan.skills) ? runtimeAfterScan.skills : []
  note(discovered.some((skill) => skill.name === 'smoke-discovered'), '磁盘技能扫描发布了 staged 技能')
  note(discovered.some((skill) => skill.name === 'smoke-renamed'), '刚改名的技能已在扫描结果里（无需等周期扫描）')
  const target = discovered.find((skill) => skill.name === 'smoke-discovered')
  note(target?.path === discoveredFile, `扫描结果带上了磁盘路径（收到 ${target?.path ?? '无'}）`)
  const readResponse = await callRoute(SKILL_READ_PATH, {
    method: 'GET',
    url: `${SKILL_READ_PATH}?path=${encodeURIComponent(target?.path ?? '')}`,
  })
  note(readResponse.json?.ok === true, `按需读取正文成功（HTTP ${readResponse.status} / ${readResponse.json?.reason ?? ''}）`)
  note(String(readResponse.json?.body ?? '').includes('发现'), '读回来的确实是正文内容')
  const readBad = await callRoute(SKILL_READ_PATH, {
    method: 'GET',
    url: `${SKILL_READ_PATH}?path=${encodeURIComponent('/etc/passwd')}`,
  })
  note(readBad.json?.ok === false, '不在扫描结果里的路径被拒绝（不能读任意文件）')

  // Delete, and then delete again: a silent no-answer is what made the panel's card spin
  // forever instead of reporting 「不存在」.
  const removed = await skillOp('delete', { name: 'smoke-renamed', path: newFile })
  note(removed.json?.ok === true, `删除回执成功（HTTP ${removed.status} / ${removed.json?.reason ?? ''}）`)
  note(!existsSync(newFile), '删除后 SKILL.md 真的从磁盘消失')
  const again = await skillOp('delete', { name: 'smoke-renamed', path: newFile })
  note(again.json?.ok === false && String(again.json?.reason ?? '') !== '', '重复删除回了 ok=false + 原因（卡片不会一直空转）')

  // Project scope lands under `<project>/.agents/skills`.
  const projectCreated = await callRoute(SKILLS_PATH, {
    body: {
      op: 'create', scope: 'project', id: 'agents', project: stage, path: '', name: 'smoke-project-skill',
      prevName: '', description: '项目级冒烟', body: '# 项目级\n', nonce: 'smoke-project-create',
    },
  })
  const projFile = join(stage, '.agents', 'skills', 'smoke-project-skill', 'SKILL.md')
  note(projectCreated.json?.ok === true, `项目级创建成功（HTTP ${projectCreated.status} / ${projectCreated.json?.reason ?? ''}）`)
  note(existsSync(projFile), '项目级技能落盘到 <project>/.agents/skills/<name>/SKILL.md')

  // ── 3. MCP rows: file CRUD, and the answer already contains the new row ──────────────
  //
  // This is the assertion the 4-second delay was about. `applyRowOp` writes the patch, the
  // route reads the file back **before** answering, and the Loader is not consulted — so the
  // new row must come back in the same response. Waiting for the Loader to reload the profile
  // is what used to make a created card take ~4 s to become real.
  const addResponse = await callRoute(ROWS_PATH, {
    body: {
      op: 'add', entryId: '', serverName: 'smoke-added', transport: 'streamable-http',
      url: 'https://added.invalid/mcp', command: '', args: '', env: '', headers: '',
      failOnStartupError: false, reconnectInitialDelayMs: '', reconnectMaxDelayMs: '',
      reconnectMaxAttempts: '', toolCallTimeoutMs: '', connTimeoutMs: '', enabled: true,
      scope: '', scopeChanged: false,
    },
  })
  note(addResponse.status === 200 && addResponse.json?.ok === true, `新增行成功（HTTP ${addResponse.status} / ${addResponse.json?.reason ?? ''}）`)
  const answeredRows = Array.isArray(addResponse.json?.servers) ? addResponse.json.servers : []
  note(
    answeredRows.some((row) => row.serverName === 'smoke-added'),
    `新增的响应里就已经包含这一行（收到 ${JSON.stringify(answeredRows.map((row) => row.serverName))}）—— 不必等 Loader 重载`,
  )
  const patchAfterAdd = readFileSync(patchPath, 'utf8')
  note(/smoke-added/.test(patchAfterAdd), '新行确实写进了 cordis.patch.yml')
  note(
    existsSync(join(home, 'dsh-skills-mcp-manager.backups', 'cordis.patch.yml.bak')),
    '写之前留了备份（改配置是危险操作）',
  )
  // …and the read route agrees without any Loader involvement.
  const runtimeAfterAdd = await readRuntime()
  note(
    (runtimeAfterAdd.servers ?? []).some((row) => row.serverName === 'smoke-added'),
    '/runtime 立刻能看到新行（列表以文件为准，不走投影）',
  )

  // Toggle off: the patch must carry `disabled: true`, and the row must still be listed
  // (a disabled row is configuration, not absence).
  const toggled = await callRoute(ROWS_PATH, {
    body: { op: 'toggle', entryId: 'mcp-smoke-added', enabled: false },
  })
  note(toggled.json?.ok === true, `停用行成功（HTTP ${toggled.status} / ${toggled.json?.reason ?? ''}）`)
  note(/disabled:\s*true/.test(readFileSync(patchPath, 'utf8')), '停用写成了 disabled: true')

  // Delete it again: the file must lose the row.
  const deletedRow = await callRoute(ROWS_PATH, {
    body: { op: 'delete', entryId: 'mcp-smoke-added' },
  })
  note(deletedRow.json?.ok === true, `删除行成功（HTTP ${deletedRow.status} / ${deletedRow.json?.reason ?? ''}）`)
  note(!/smoke-added/.test(readFileSync(patchPath, 'utf8')), '删除后 patch 里没有这一行')

  // Deleting a row that is already gone **succeeds**: the requested end state ("this row is
  // not in the patch") holds. Reporting a failure there would be a scary message for an action
  // that did what the user asked — and it is reachable, because the route can be retried.
  // What must *also* be true is that nothing is written: no patch churn, no backup churn.
  const patchBeforeMiss = readFileSync(patchPath, 'utf8')
  const missingRow = await callRoute(ROWS_PATH, {
    body: { op: 'delete', entryId: 'mcp-does-not-exist' },
  })
  note(missingRow.json?.ok === true, `删除已经不存在的行幂等成功（HTTP ${missingRow.status} / ${missingRow.json?.reason ?? ''}）`)
  note(readFileSync(patchPath, 'utf8') === patchBeforeMiss, '幂等删除没有改写 patch（不制造无谓的备份）')

  // A malformed command is refused **as a result**, never as a thrown error: an exception
  // escaping here would take the plugin down with it.
  const badRow = await callRoute(ROWS_PATH, { body: { op: 'nonsense', entryId: 'mcp-x' } })
  note(badRow.status === 400 && badRow.json?.ok === false, `非法行命令被拒（HTTP ${badRow.status}）`)
  note(String(badRow.json?.reason ?? '') !== '', `非法行命令带上了原因（收到「${badRow.json?.reason ?? ''}」）`)

  // ── 4. Import and reconnect: both answer, neither throws ────────────────────────────
  const badImport = await callRoute(IMPORT_PATH, {
    body: { source: 'not-a-real-source', scope: 'global', project: '' },
  })
  note(badImport.status === 200 && badImport.json !== undefined, `导入扫描有回执（HTTP ${badImport.status}）`)
  // An unknown source is **not** an error of the route: the scan ran and found nothing, and
  // says why in `error`. What must never happen is a throw (which would take the plugin down)
  // or a silent empty answer with no explanation.
  note(String(badImport.json?.error ?? '') !== '',
    `无法识别的来源给出了原因而不是抛错（收到「${badImport.json?.error ?? ''}」）`)
  note(Array.isArray(badImport.json?.servers) && badImport.json.servers.length === 0,
    '无法识别的来源不会凭空给出服务器')

  /**
   * 导入预览 → 真的写进 patch。
   *
   * 导入拆成了两段（`/import` 只扫描、`/rows` 才写），所以单测那层接缝必须也在真机上过一遍：
   * 扫描出来的字段形状（`args` 数组、`env`/`headers` 对象）与 `RowOp` 的形状完全不同，
   * 转换只发生在面板里。转换错了 yml 照样生成，只是行少了参数或丢了 Authorization ——
   * 表现为「导入成功但连不上」，最难联想到导入。
   */
  {
    const importDir = join(stage, 'import-proj')
    await mkdir(join(importDir, '.cursor'), { recursive: true })
    await writeFile(join(importDir, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        'imported-http': { url: 'https://imported.invalid/mcp', headers: { Authorization: 'Bearer smoke' } },
        'imported-stdio': { command: 'npx', args: ['-y', '@smoke/pkg'], env: { SMOKE: '1' } },
      },
    }))
    const scanned = await callRoute(IMPORT_PATH, {
      body: { source: 'cursor', scope: 'project', project: importDir },
    })
    const found = Array.isArray(scanned.json?.servers) ? scanned.json.servers : []
    note(found.length === 2, `导入扫描识别出 2 台（收到 ${JSON.stringify(found.map((s) => s.serverName))}）`)
    // 面板的转换，逐字照抄 lib/src/client.js 的导入 onClick。
    for (const server of found) {
      await callRoute(ROWS_PATH, {
        body: {
          op: 'add', entryId: '',
          serverName: server.serverName, transport: server.transport,
          url: server.transport === 'stdio' ? '' : server.url,
          command: server.transport === 'stdio' ? server.command : '',
          args: server.transport === 'stdio' ? (server.args ?? []).join(' ') : '',
          env: server.env ?? '', headers: server.headers ?? '',
          failOnStartupError: false, reconnectInitialDelayMs: '', reconnectMaxDelayMs: '',
          reconnectMaxAttempts: '', toolCallTimeoutMs: '', connTimeoutMs: '',
          enabled: true, scope: importDir, scopeChanged: true,
        },
      })
    }
    const written = parse(readFileSync(patchPath, 'utf8'))
    const rowsWritten = []
    for (const top of written) {
      const insert = top?.insert
      if (Array.isArray(insert)) rowsWritten.push(...insert)
    }
    const httpRow = rowsWritten.find((row) => row?.config?.serverName === 'imported-http')
    const stdioRow = rowsWritten.find((row) => row?.config?.serverName === 'imported-stdio')
    note(httpRow !== undefined && stdioRow !== undefined,
      `导入的两台都写进了 cordis.patch.yml（收到 ${JSON.stringify(rowsWritten.map((r) => r?.config?.serverName))}）`)
    note(httpRow?.config?.url === 'https://imported.invalid/mcp', '导入的 http 行带上了 url')
    note(httpRow?.config?.headers?.Authorization === 'Bearer smoke',
      `导入的 http 行保住了 headers（收到 ${JSON.stringify(httpRow?.config?.headers)}）`)
    note(Array.isArray(stdioRow?.config?.args) && stdioRow.config.args.length === 2,
      `导入的 stdio 行 args 还原成数组（收到 ${JSON.stringify(stdioRow?.config?.args)}）`)
    note(stdioRow?.config?.env?.SMOKE === '1', '导入的 stdio 行保住了 env')
    note(httpRow?.disabled === true, '项目级导入写成 disabled: true（否则 Loader 会重复连接）')
  }

  // A server the profile does not configure cannot be reconnected, so the request must still
  // be answered — silently swallowing it would leave the panel showing 「重连中…」 forever.
  const badReconnect = await callRoute(RECONNECT_PATH, {
    body: { tier: 'global', serverName: 'no-such-server', scope: '' },
  })
  note(badReconnect.status === 200 && badReconnect.json !== undefined, `重连有回执（HTTP ${badReconnect.status}）`)
  note(badReconnect.json?.ok === false && String(badReconnect.json?.reason ?? '') !== '',
    `重连不存在的服务器回了原因（收到「${badReconnect.json?.reason ?? ''}」）`)

  // ── 5. OAuth: routes + published state + a forged callback ───────────────────────────
  //
  // The callback is the **only** route here that cannot carry `connection.requestRejection`
  // — the browser arrives from the authorization server's 302 with no DSH session cookie. Its
  // security boundary is the one-time `state`, so a state-less callback must be refused.
  note(routes.get(CALLBACK_PATH) !== undefined, `OAuth 回调路由已注册（GET ${CALLBACK_PATH}）`)
  if (routes.get(CALLBACK_PATH) !== undefined) {
    const callback = await callRoute(CALLBACK_PATH, {
      method: 'GET',
      url: `${CALLBACK_PATH}?code=x&state=`,
    })
    note(callback.status === 400, `缺少 state 的回调被拒绝（得到 ${callback.status}）`)
    note(/no-store/.test(String(callback.headers['cache-control'] ?? '')), '回调整页不可缓存（响应里带一次性 code）')
    note(!/access_token|refresh_token|code_verifier/.test(callback.text), '回调响应体里没有令牌或 PKCE 材料')
  }
  const runtime = await readRuntime()
  note(typeof runtime.oauth === 'object' && runtime.oauth !== null, 'OAuth 支持状态随 /runtime 一起发布')
  note(typeof runtime.oauth?.ready === 'boolean', 'OAuth 支持状态有明确的 ready 布尔值')
  if (runtime.oauth?.ready === false) {
    note(String(runtime.oauth?.detail ?? '') !== '', 'OAuth 不可用时给出了原因，而不是静默关闭这项能力')
  }
  // The `redirect_uri` must be a real absolute URL ending at the callback route. An empty one
  // is the failure mode that hides best: `ready` still says true, the button still renders,
  // and the SDK silently takes the non-interactive branch. (This shipped once —
  // `ctx.webServer` instead of `ctx.get('webServer')`.)
  const redirectUri = String(runtime.oauth?.redirectUri ?? '')
  if (runtime.oauth?.ready === true) {
    note(redirectUri !== '', 'OAuth 已就绪时 redirectUri 不能为空（空值会让 SDK 走非交互分支）')
    note(redirectUri.endsWith(CALLBACK_PATH), `redirectUri 指向回调路由（收到 ${redirectUri}）`)
    note(/^https?:\/\//.test(redirectUri), `redirectUri 是绝对 URL（收到 ${redirectUri}）`)
    note(runtime.oauth?.callbackReady === true, '回调路由的可用状态也发布了')
  }
  note(typeof runtime.oauth?.servers === 'object' && runtime.oauth.servers !== null, '逐服务器的授权状态随 /runtime 发布')
  note(!JSON.stringify(runtime.oauth?.servers ?? {}).includes('access_token'), '授权状态里不含令牌本体')

  // ── 6. /runtime carries the live view (what settings used to project) ───────────────
  note(!('serverTools' in (config ?? {})), '/runtime 的工具清单不经过 settings')
  const inventory = runtime.serverTools
  const entry = inventory.find((item) => item.serverName === 'smoke-server')
  note(entry !== undefined, '工具清单为已配置的服务器发布了条目')
  if (entry !== undefined) {
    const names = entry.tools.map((tool) => tool.name)
    note(names.length === 2, `只收该服务器的工具（收到 ${names.length} 个，期望 2）`)
    note(names.includes('mcp__smoke-server__echo'), '保留了完整工具名（模型调用时要用它）')
    note(!names.includes('read_file'), '内置工具没被算进 MCP 服务器')
    note(entry.tools.find((tool) => tool.name === 'mcp__smoke-server__echo')?.description === 'Echo back', '工具描述一并发布')
  }
  // The error field must be present-and-empty when the read succeeded: publishing the
  // *absence* of an error is itself the contract, otherwise the panel reports "restart DSH"
  // for a healthy registry.
  note(runtime.serverToolsError !== undefined, '运行时接口携带工具读取结果')
  note(runtime.serverToolsError?.reason === '', '读取正常时原因字段为空串')

  // Status: one row per server, split on the row's own `scope`.
  const statuses = runtime.serverStatus
  const smokeStatus = statuses.find((item) => item.serverName === 'smoke-server')
  note(smokeStatus !== undefined, '连接状态为已配置的服务器发布了条目')
  note(smokeStatus?.status === 'connected', `注册表里有工具即视为已连接（收到「${smokeStatus?.status}」）`)
  note(smokeStatus?.toolCount === 2, `连接状态带上工具数（收到 ${smokeStatus?.toolCount}，期望 2）`)
  note(smokeStatus?.budgetMs === 151500, `重试预算按客户端默认退避算出（收到 ${smokeStatus?.budgetMs}，期望 151500）`)
  const statusKeys = statuses.map((item) => `${item.serverName}\u0000${item.tier}\u0000${item.scope ?? ''}`)
  note(
    new Set(statusKeys).size === statusKeys.length,
    `每台服务器每个档位只发布一条状态（发出 ${statusKeys.length} 条，去重后 ${new Set(statusKeys).size} 条）`,
  )
  const projectStatus = statuses.find((item) => item.serverName === 'smoke-project')
  note(projectStatus !== undefined, '项目级行也发布了状态条目')
  note(
    projectStatus?.tier === 'project' && projectStatus?.scope === '/p/smoke',
    `项目级行按 tier=project + 自己的 scope 发布（收到 tier=${projectStatus?.tier} scope=${projectStatus?.scope}）`,
  )
  note(
    !statuses.some((item) => item.serverName === 'smoke-server' && item.tier !== 'global'),
    '全局行不会同时被当成项目级发布',
  )
  note(projectStatus?.status !== 'unmounted', `插件加载前已存在的会话也会被补挂（smoke-project 状态「${projectStatus?.status}」）`)
  note(mountCalls.some((call) => call.serverName === 'smoke-project'), '项目级行确实挂载到了 agent 作用域')

  // A project server's tools are read from **its agent's scope**.
  const projectToolsEntry = inventory.find((item) => item.serverName === 'smoke-project')
  const projectToolNames = (projectToolsEntry?.tools ?? []).map((tool) => tool.name)
  note(
    projectToolNames.includes('mcp__smoke-project__search'),
    `项目级工具按作用域读取（收到 ${JSON.stringify(projectToolNames)}）`,
  )
  note(
    !(entry?.tools ?? []).some((tool) => tool.name.startsWith('mcp__smoke-project__')),
    '全局行的工具清单不会混入项目级工具',
  )

  // Probe health plus per-server answers: "no server is down" and "we cannot tell" must never
  // render the same, and the recorded answers are the evidence that separates a genuinely
  // absent instance from a refused connection.
  note(runtime.probe !== undefined, '发布了连接探测自身的状态（缺失会让面板把「看不见」当成「正常」）')
  note(runtime.probe?.installed === true, `连接探测可用（${runtime.probe?.reason || 'ok'}）`)
  const probed = Array.isArray(runtime.probe?.results) ? runtime.probe.results : []
  note(probed.some((item) => item.serverName === 'smoke-dead'), '探测结果记录了逐服务器的回答')
  note(
    probed.find((item) => item.serverName === 'smoke-dead')?.state === 'down',
    `服务说 disconnected 时探测记为 down（收到「${probed.find((i) => i.serverName === 'smoke-dead')?.state}」）`,
  )
  note(probeRequests.length > 0, 'Host 真的通过服务公开的 request() 探测（而不是劫持 register）')
  note(probeRequests.every((call) => call.method === 'resources/list'), '探测用 resources/list 判断客户端是否活着')

  // A server that refuses until authorized must read 「需要授权」, not a fault.
  let authStatus = null
  for (let tick = 0; tick < 40; tick += 1) {
    authStatus = (await readRuntime()).serverStatus.find((item) => item.serverName === 'smoke-auth')
    if (authStatus?.status === 'needs-auth') break
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  note(authProbeRequests.length > 0, 'Host 真的发起了 HTTP 鉴权探测（mcpResources 看不到 401，必须自己发）')
  note(authProbeRequests.every((call) => call.method === 'POST'),
    '用 POST 探测（GET/HEAD 在 Streamable HTTP 上会把「不支持 GET」误读成「需要授权」）')
  note(authStatus?.status === 'needs-auth', `401 的服务器判成「需要授权」而不是故障（收到「${authStatus?.status}」）`)
  note(/不是故障/.test(String(authStatus?.detail ?? '')), `需要授权的说明必须点明它不是故障（收到「${authStatus?.detail}」）`)
  note(authStatus?.status !== 'needs-auth' || authStatus?.remainingSeconds === 0, '需要授权不发布剩余重试时间（它不是重试中的一种）')

  // Provider present but refusing the connection is "not connected", NOT "activation failed".
  const deadStatus = (await readRuntime()).serverStatus.find((item) => item.serverName === 'smoke-dead')
  note(deadStatus?.status === 'retrying' || deadStatus?.status === 'gave-up',
    `有 provider 但连不上 ⇒ 未连接（收到「${deadStatus?.status}」）`)

  // A slow first connection must not be reported as an activation failure. `smoke-idle` is a
  // configured row with no tools and no provider; while the Loader says LOADING the only
  // honest description is 「连接中」. Checked after the 15 s grace period, because that grace
  // is exactly what would otherwise mask the bug.
  const idleRow = loaderEntries.find((item) => item.id === 'mcp-smoke-idle')
  note(idleRow !== undefined, '冒烟夹具里有第二行（无工具、用于验证加载中不误报）')
  await new Promise((resolveWait) => setTimeout(resolveWait, 16000))
  const idleLoading = (await readRuntime()).serverStatus.find((item) => item.serverName === 'smoke-idle')
  note(idleLoading !== undefined, '无工具的服务器也发布了状态条目')
  note(idleLoading?.status === 'pending', `首次连接仍在进行时不能报激活失败（收到「${idleLoading?.status}」，期望 pending）`)
  if (idleRow !== undefined) idleRow.fiber = { state: 3 }
  await new Promise((resolveWait) => setTimeout(resolveWait, 6500))
  const idleFailed = (await readRuntime()).serverStatus.find((item) => item.serverName === 'smoke-idle')
  note(idleFailed?.status === 'failed', `Loader 说 failed 时才报激活失败（收到「${idleFailed?.status}」，期望 failed）`)

  // ── 7. Tool filter: allow / deny / off ──────────────────────────────────────────────
  note(runtime.filter?.installed === true, `过滤器的 shadow 装上去了（${runtime.filter?.reason || 'ok'}）`)
  registered.length = 0
  live.toolFilters = { 'smoke-server': { mode: 'allow', tools: ['echo'] } }
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  // The rules are read per registration, so no restart is needed for this to apply.
  toolsService.register({ name: 'mcp__smoke-server__echo' })
  toolsService.register({ name: 'mcp__smoke-server__ping' })
  toolsService.register({ name: 'read_file' })
  note(registered.includes('mcp__smoke-server__echo'), 'allow 名单里的工具照常注册')
  note(!registered.includes('mcp__smoke-server__ping'), '不在名单里的工具被挡在注册表之外')
  note(registered.includes('read_file'), '非 MCP 的内置工具完全不受影响')

  live.toolFilters = { 'smoke-server': { mode: 'deny', tools: ['ping'] } }
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  registered.length = 0
  toolsService.register({ name: 'mcp__smoke-server__echo' })
  toolsService.register({ name: 'mcp__smoke-server__ping' })
  note(registered.includes('mcp__smoke-server__echo'), 'deny 模式下不在名单里的照常注册')
  note(!registered.includes('mcp__smoke-server__ping'), 'deny 模式挡住名单里的工具')

  live.toolFilters = {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  registered.length = 0
  toolsService.register({ name: 'mcp__smoke-server__ping' })
  note(registered.includes('mcp__smoke-server__ping'), 'off 模式（默认）完全不干预注册')

  // The dropped names reach the panel through the runtime answer, so this polls for it
  // rather than asserting straight after the drop.
  {
    const start = Date.now()
    let droppedPublished = false
    while (Date.now() - start < 6000) {
      const now = await readRuntime()
      if (Array.isArray(now.filter?.dropped) && now.filter.dropped.length > 0) { droppedPublished = true; break }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    note(droppedPublished, '被挡下的工具名发布给了面板（供它展示真实生效情况）')
  }

  // ── 8. The refactor's contract: no settings writes at all ───────────────────────────
  //
  // Every command is a request and every list is computed on demand, so the Host should never
  // touch the settings document. This is the assertion that keeps the old channel from being
  // reintroduced "just for one field": a resurrected publish tick fails here.
  note(live.__updates === 0, `Host 从不写 settings（实测 ${live.__updates} 次）`)

  // Bodies are fetched on demand, never published in the list: the list must not grow with
  // the size of the skills on disk.
  const finalSkills = (await readRuntime()).skills ?? []
  note(finalSkills.every((skill) => skill.body === undefined), '列表不夹带正文（体积不会随技能数膨胀）')
  const discovery = (await readRuntime()).discovery
  note(typeof discovery?.at === 'string' && discovery.at !== '', 'discoveryInfo 记录了扫描时间（诊断通道可用）')
} catch (error) {
  note(false, '冒烟脚本自身出错：' + (error?.stack ?? error?.message ?? error))
} finally {
  process.removeAllListeners('uncaughtException')
  process.removeAllListeners('unhandledRejection')
  // Restore the real network function: leaving a stub installed would silently break
  // anything the harness runs after this point.
  if (realFetch === undefined) delete globalThis.fetch
  else globalThis.fetch = realFetch
  await rm(stage, { recursive: true, force: true })
  if (createdScopeLink) await rm(scopeLink, { force: true })
}

if (problems.length > 0) {
  console.log('  ✗ Host 冒烟失败：' + problems.join(' | '))
  process.exit(1)
}
console.log('  ✓ Host 冒烟通过：加载 / 7 条路由 / 技能落盘 / 行文件 CRUD / 无需等 Loader / 零 settings 写盘 全部正常')
process.exit(0)
