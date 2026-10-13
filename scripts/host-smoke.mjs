/**
 * Host-half smoke test: load the built plugin the way DSH does and feed it a real
 * request through the skill channel, asserting that nothing throws.
 *
 * Why this exists: an uncaught exception during plugin load makes DSH treat the
 * profile as broken and run `sanitizeProfile`, which quarantines the user's whole
 * cordis.patch.yml and disables every non-recovery plugin. Compiling and unit
 * tests cannot see that class of bug — only running the code path can.
 *
 * The plugin imports @deepseek-ai/* packages that only exist next to the app, so
 * we stage a package dir whose node_modules/@deepseek-ai points at the app's.
 */
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const appNodeModules = [
  process.env.DSH_APP_NODE_MODULES,
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules',
  '/tmp/dshroot/dsh/node_modules',
// The candidate must be able to resolve the plugin's own dependencies, not just
// contain an @deepseek-ai folder: the app bundle ships a trimmed set.
].find((dir) => dir !== undefined && existsSync(join(dir, '@deepseek-ai', 'schemastery')))

if (appNodeModules === undefined) {
  console.log('  · 跳过 Host 冒烟（找不到 app 的 node_modules，可用 DSH_APP_NODE_MODULES 指定）')
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

try {
  const pkgDir = stage
  await cp(join(root, 'dist'), join(pkgDir, 'dist'), { recursive: true })
  await cp(join(root, 'package.json'), join(pkgDir, 'package.json'))

  const home = join(stage, 'home')
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = join(stage, 'agents')
  // A skill on disk up front, so the discovery channel has something to publish.
  await mkdir(join(home, 'skills', 'smoke-discovered'), { recursive: true })
  await writeFile(join(home, 'skills', 'smoke-discovered', 'SKILL.md'),
    '---\nname: smoke-discovered\ndescription: 发现通道冒烟\n---\n\n# 发现\n')
  await mkdir(join(home, 'stagingMarker'), { recursive: true })

  const live = {
    skillRequest: { op: 'create', scope: 'global', id: 'dsh', project: '', name: 'smoke-skill', prevName: '', description: '冒烟', body: '# 冒烟正文', nonce: 'smoke-nonce' },
    skillResult: { ok: false, reason: '', name: '', nonce: '' },
    servers: [], skills: [], rowOps: [], rowOpsReady: false,
    importRequest: { source: '', scope: '', project: '', nonce: '' },
    importResult: { nonce: '', files: [], servers: [], error: '' },
    reconnectRequest: { tier: '', serverName: '', scope: '', nonce: '', at: '' },
    reconnectResult: { nonce: '', ok: false, error: '' },
  }
  const noop = () => {}
  const mod = await import(pathToFileURL(join(pkgDir, 'dist', 'index.js')).href)
  // The harness tool registry, with a real `register` so the tool filter's shadow
  // has something to install onto and its effect can be observed.
  /** Tools the registry actually accepted (i.e. what the model would be offered). */
  const registered = []
  const toolsService = {
    register(definition) {
      registered.push(definition.name)
      return () => {
        const at = registered.indexOf(definition.name)
        if (at >= 0) registered.splice(at, 1)
      }
    },
    schemas: () => [
      { name: 'mcp__smoke-server__echo', description: 'Echo back' },
      { name: 'mcp__smoke-server__ping', description: '' },
      { name: 'read_file', description: 'built-in, not from MCP' },
    ],
  }
  /**
   * The service `dsh-mcp-client` publishes its connection to.
   *
   * Present here on purpose: the connection watch hooks this method, and the smoke has
   * to prove two things about it — that the original call is still forwarded and
   * returns a working disposer, and that a registered provider is what makes the
   * status channel report a live connection.
   */
  const registeredProviders = new Map()
  const mcpResourcesService = {
    register(server, provider) {
      registeredProviders.set(server, provider)
      return () => registeredProviders.delete(server)
    },
  }
  /**
   * Loader entries, held in a stable array.
   *
   * Deliberately NOT built inside `entries()`: the smoke mutates a fiber state mid-run
   * to prove the status reacts to it, and a fresh array per call would silently drop
   * that mutation — the assertion would then pass or fail for the wrong reason.
   */
  const loaderEntries = [{
    id: 'mcp-smoke-server',
    disabled: false,
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'smoke-server', transport: 'streamable-http', url: 'https://smoke.invalid/mcp' },
    },
    fiber: { state: 2 },
  }, {
    // A second configured row with no tools. Used to prove a slow first connection is
    // reported as "still connecting" rather than "activation failed" — the false alarm
    // the real app actually produced. Kept LOADING until the smoke flips it.
    id: 'mcp-smoke-idle',
    disabled: false,
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'smoke-idle', transport: 'streamable-http', url: 'https://idle.invalid/mcp' },
    },
    fiber: { state: 1 },
  }]
  const ctx = {
    logger: { info: noop, warn: noop, error: (...args) => problems.push('host logger.error: ' + args.map(String).join(' ')) },
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [] }
      if (name === 'tools') return toolsService
      if (name === 'mcpResources') return mcpResourcesService
      return undefined
    },
    loader: {
      // One configured mcp-client row, exactly as the Loader reports it. This drives
      // the profile-row projection AND the tool-inventory channel built on top of it.
      //
      // The entry carries `fiber` (a Fiber object), NOT `fiberPhase`: that name is a
      // derived field computed by `dsh-host-plugin-inventory`, and reading it off a raw
      // entry yields '' forever. This mock is deliberately the real shape, so the phase
      // assertion below fails if the Host ever goes back to reading the wrong one.
      entries: () => loaderEntries,
    },
    effect: (fn) => { fn(); return noop },
    plugin: () => ({ dispose: noop }),
    on: () => noop,
    inject: (names, cb) => cb({
      settings: { update: async (ns, patch) => { live.__updates = (live.__updates ?? 0) + 1; Object.assign(live, patch); return true } },
      effect: (fn) => { fn(); return noop },
    }),
  }
  const config = {
    servers: { get: () => live.servers }, skills: { get: () => live.skills }, rowOps: { get: () => live.rowOps },
    skillRequest: { get: () => live.skillRequest }, skillResult: { get: () => live.skillResult },
    // One configured MCP row (from the loader mock above), so the tool-inventory
    // channel has something to report.
    profileServers: { get: () => [] }, workspaces: { get: () => [] }, currentWorkspace: { get: () => '' },
    importRequest: { get: () => live.importRequest }, importResult: { get: () => live.importResult },
    // The panel's reconnect channel: written by the panel, drained by the Host.
    reconnectRequest: { get: () => live.reconnectRequest },
    // Read live on every registration, so this mock is also what proves a panel edit
    // takes effect without a restart.
    toolFilters: { get: () => live.toolFilters },
  }

  try {
    mod.apply(ctx, config)
    await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
  } catch (error) {
    escaped = 'apply threw: ' + error.message
  }

  note(escaped === null, '没有异常逃逸出插件（' + (escaped ?? '干净') + '）')
  note(live.skillResult.ok === true, 'skillResult.ok = true（收到处理结果）')
  note(live.skillRequest.nonce === '', '处理完清空了 skillRequest（防止重启重放）')
  const file = join(home, 'skills', 'smoke-skill', 'SKILL.md')
  note(existsSync(file), '技能文件确实写到磁盘')

  // Send one op and wait for its own receipt (the Host clears the request).
  const sendSkill = async (request, waitMs = 1800) => {
    live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
    live.skillRequest = {
      op: '', scope: 'global', id: 'dsh', project: '', name: '', prevName: '',
      description: '', body: '', ...request,
      nonce: `probe-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))
    return live.skillResult
  }

  // update: same name, new content — the panel edits in place.
  const updated = await sendSkill({ op: 'update', name: 'smoke-skill', description: '冒烟', body: '# 改后正文' })
  note(updated.ok === true && readFileSync(file, 'utf8').includes('# 改后正文'), 'update 通道就地改写正文')

  // rename: the user's actual question — does the folder move too? It must,
  // because DSH takes the name from the frontmatter but treats the directory as
  // the skill's resource base.
  const renamed = await sendSkill({ op: 'rename', name: 'smoke-renamed', prevName: 'smoke-skill', description: '冒烟', body: '# 改后正文' })
  const oldDir = join(home, 'skills', 'smoke-skill')
  const newDir = join(home, 'skills', 'smoke-renamed')
  const newFile = join(newDir, 'SKILL.md')
  note(renamed.ok === true && !existsSync(oldDir) && existsSync(newFile), 'rename 把目录一起改名（旧目录消失、新目录存在）')
  if (existsSync(newFile)) {
    const text = readFileSync(newFile, 'utf8')
    note(/name:\s*smoke-renamed/.test(text), 'rename 同步改写了 frontmatter 的 name')
  } else {
    note(false, 'rename 后读不到新目录的 SKILL.md')
  }
  const backups = existsSync(join(home, 'skills')) ? readdirSync(join(home, 'skills')).filter((name) => name.startsWith('.smp-backup-')) : []
  note(backups.length > 0, `rename 之前留了备份（${backups.length} 个 .smp-backup-*）`)
  note((await sendSkill({ op: 'create', name: 'smoke-renamed', body: 'x' })).ok === false, '同名再创建被拒绝（不覆盖既有技能）')

  // Channel 2: importRequest -> importResult (a bogus source must come back as a
  // result, never as a thrown error).
  live.importRequest = { source: 'not-a-real-source', scope: 'global', project: '', nonce: 'import-probe' }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  note(live.importResult?.nonce === 'import-probe', 'importRequest 通道有回执（nonce 原样返回）')

  // Channel 3: rowOps drain. applyRowOp cannot work here (no profileContext), so
  // this asserts the drain *contains* the failure instead of letting it escape.
  live.rowOps = [{ op: 'toggle', entryId: 'mcp-does-not-exist', enabled: false }]
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  note(Array.isArray(live.rowOps) && live.rowOps.length === 0, 'rowOps 被排空（失败被记录而非逃逸）')

  // Channel 3b: the reconnect request. A server the profile does not configure cannot
  // be reconnected, so the request must still be consumed — and the failure must come
  // back as a reason. Silently swallowing it would leave the panel showing "重连中…"
  // forever, which is worse than the dead server the user was trying to fix.
  live.reconnectRequest = { tier: 'global', serverName: 'no-such-server', scope: '', nonce: 'smoke-reconnect-1', at: '' }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
  note(live.reconnectRequest?.nonce === '', '重连请求被排空（否则面板一直显示重连中）')
  note(live.reconnectResult?.nonce === 'smoke-reconnect-1', '重连结果按 nonce 回给了发起方')
  note(live.reconnectResult?.ok === false && live.reconnectResult?.error !== '', '重连失败带上了原因，而不是静默失败')

  // Channel 4: disk-skill discovery. This is where the real app silently published
  // an empty list, so the smoke must prove the channel actually publishes.
  const discovered = Array.isArray(live.discoveredSkills) ? live.discoveredSkills : []
  note(discovered.some((skill) => skill.name === 'smoke-discovered'), '磁盘技能发现通道发布了 staged 技能')

  // Channel 5: the tool inventory. The panel's expanded card shows what each server
  // actually registered, so this must publish per-server tools from the harness
  // registry — filtered by the `mcp__<serverName>__` prefix, with built-ins excluded.
  const rows = Array.isArray(live.profileServers) ? live.profileServers : []
  note(rows.some((row) => row.serverName === 'smoke-server'), '配置文件行投影发布了 loader 里的 MCP 行')
  const inventory = Array.isArray(live.serverTools) ? live.serverTools : []
  const entry = inventory.find((item) => item.serverName === 'smoke-server')
  note(entry !== undefined, '工具清单为已配置的服务器发布了条目')
  if (entry !== undefined) {
    const names = entry.tools.map((tool) => tool.name)
    note(names.length === 2, `只收该服务器的工具（收到 ${names.length} 个，期望 2）`)
    note(names.includes('mcp__smoke-server__echo'), '保留了完整工具名（模型调用时要用它）')
    note(!names.includes('read_file'), '内置工具没被算进 MCP 服务器')
    const echo = entry.tools.find((tool) => tool.name === 'mcp__smoke-server__echo')
    note(echo?.description === 'Echo back', '工具描述一并发布')
  }
  // The error field must be present-and-empty when the read succeeded. If the Host
  // silently omitted it, the panel would report "restart DSH" for a healthy
  // registry — so publishing the *absence* of an error is itself the contract.
  note(live.serverToolsError !== undefined, '读了错误字段本身（缺失会让面板误判为旧 Host）')
  note(live.serverToolsError?.reason === '', '读取正常时原因字段为空串（不是缺字段）')

  // Channel 5b: the row phase. It used to read `entry.fiberPhase`, which does not
  // exist on a raw Loader entry (it is derived by dsh-host-plugin-inventory), so the
  // field was permanently '' and the panel could not tell "connected with no tools"
  // from "never loaded". The mock entry above carries the real `fiber` shape.
  note(rows[0]?.phase === 'active', `行状态由 fiber.state 推出（收到「${rows[0]?.phase}」，期望 active）`)

  // Channel 5c: per-server connection status. This is the channel that makes a
  // silently dead MCP visible, so the smoke proves it publishes for a configured
  // server rather than trusting the unit tests alone.
  const statuses = Array.isArray(live.serverStatus) ? live.serverStatus : []
  const smokeStatus = statuses.find((item) => item.serverName === 'smoke-server')
  note(smokeStatus !== undefined, '连接状态为已配置的服务器发布了条目')
  // The registry is the cheap positive signal for a global row: two tools are
  // registered for this name, so it must read as connected without any probing.
  note(smokeStatus?.status === 'connected', `注册表里有工具即视为已连接（收到「${smokeStatus?.status}」）`)
  note(smokeStatus?.toolCount === 2, `连接状态带上工具数（收到 ${smokeStatus?.toolCount}，期望 2）`)
  note(smokeStatus?.budgetMs === 151500, `重试预算按客户端默认退避算出（收到 ${smokeStatus?.budgetMs}，期望 151500）`)
  note(live.reconnectReady === true, '发布了重连能力标记，面板据此才显示按钮')

  // Channel 5d: the watch's own health. "No server is down" and "we cannot tell" must
  // never render the same, and `instances` is the evidence that separates a genuinely
  // absent instance from a registration the watch simply missed.
  note(live.watchState !== undefined, '发布了连接观测自身的状态（缺失会让面板把「看不见」当成「正常」）')
  note(live.watchState?.installed === true, `连接观测装上了（${live.watchState?.reason || 'ok'}）`)
  note(Array.isArray(live.watchState?.instances), '观测状态带上了它实际看到的实例清单')

  // Channel 5e: a slow first connection must not be reported as an activation failure.
  //
  // This is the regression the real app produced: deepwiki was labelled 激活失败 while
  // its first connect was still in flight (a fiber stays LOADING until `apply` returns,
  // which the client awaits for up to toolCallTimeoutMs — 60 s by default), and a minute
  // later it was connected. False alarms are worse than no alarm here.
  //
  // `smoke-idle` is a configured row with no tools and no provider, so "not connected"
  // is the only honest description; what it must NOT say is 激活失败 while the Loader
  // reports LOADING. It is checked after the 15 s grace period, because that grace is
  // exactly what would otherwise mask the bug.
  const idleRow = ctx.loader.entries().find((entry) => entry.id === 'mcp-smoke-idle')
  note(idleRow !== undefined, '冒烟夹具里有第二行（无工具、用于验证加载中不误报）')
  await new Promise((resolveWait) => setTimeout(resolveWait, 16000))
  const idleLoading = (Array.isArray(live.serverStatus) ? live.serverStatus : [])
    .find((item) => item.serverName === 'smoke-idle')
  note(idleLoading !== undefined, '无工具的服务器也发布了状态条目')
  note(
    idleLoading?.status === 'pending',
    `首次连接仍在进行时不能报激活失败（收到「${idleLoading?.status}」，期望 pending）`,
  )
  if (idleRow !== undefined) idleRow.fiber = { state: 3 }
  await new Promise((resolveWait) => setTimeout(resolveWait, 6500))
  const idleFailed = (Array.isArray(live.serverStatus) ? live.serverStatus : [])
    .find((item) => item.serverName === 'smoke-idle')
  note(
    idleFailed?.status === 'failed',
    `Loader 说 failed 时才报激活失败（收到「${idleFailed?.status}」，期望 failed）`,
  )

  // Channel 6: the tool filter. This is the one that changes what the MODEL is
  // offered, so the smoke drives a real registration through the shadow and checks
  // both directions: a dropped tool never reaches the registry, and everything else
  // is admitted untouched.
  note(live.filterState?.installed === true, `过滤器的 shadow 装上去了（${live.filterState?.reason || 'ok'}）`)
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

  // Switching to deny must flip the outcome for the same two names.
  live.toolFilters = { 'smoke-server': { mode: 'deny', tools: ['ping'] } }
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  registered.length = 0
  toolsService.register({ name: 'mcp__smoke-server__echo' })
  toolsService.register({ name: 'mcp__smoke-server__ping' })
  note(registered.includes('mcp__smoke-server__echo'), 'deny 模式下不在名单里的照常注册')
  note(!registered.includes('mcp__smoke-server__ping'), 'deny 模式挡住名单里的工具')

  // Back to off: the server must pass through untouched.
  live.toolFilters = {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  registered.length = 0
  toolsService.register({ name: 'mcp__smoke-server__ping' })
  note(registered.includes('mcp__smoke-server__ping'), 'off 模式（默认）完全不干预注册')

  // The dropped names reach the panel through the publish tick, not synchronously,
  // so this waits for the projection rather than asserting straight after the drop.
  const dropStart = Date.now()
  let droppedPublished = false
  while (Date.now() - dropStart < 6000) {
    if (Array.isArray(live.filterState?.dropped) && live.filterState.dropped.length > 0) {
      droppedPublished = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  note(droppedPublished, '被挡下的工具名发布给了面板（供它展示真实生效情况）')
  // The list must stay small: bodies are fetched on demand, never published here.
  note(discovered.every((skill) => skill.body === undefined), '列表不夹带正文（体积不会随技能数膨胀）')

  // A write channel that never reaches settings (self-recursion, early return) used
  // to pass every other assertion, so assert the writes actually happened.
  note((live.__updates ?? 0) > 0, 'Host 确实调用了 settings.update（写入通道真的在工作）')

  // `projectRootOf` walks up to the nearest ancestor holding `.git`, so the staged
  // project needs that marker or the skill lands in some unrelated ancestor.
  await mkdir(join(stage, '.git'), { recursive: true })

  // Project-level create must land on disk under <project>/.agents/skills.
  const projNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'create', scope: 'project', id: 'agents', project: stage, path: '', name: 'smoke-project-skill', prevName: '', description: '项目级冒烟', body: '# 项目级\n', nonce: projNonce }
  const projStart = Date.now()
  while (Date.now() - projStart < 2000 && live.skillResult?.nonce !== projNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const projFile = join(stage, '.agents', 'skills', 'smoke-project-skill', 'SKILL.md')
  note(live.skillResult?.nonce === projNonce && live.skillResult?.ok === true, '项目级创建回执成功且 nonce 原样返回')
  note(existsSync(projFile), '项目级技能落盘到 <project>/.agents/skills/<name>/SKILL.md')
  // Latency guard AND metric: the op must publish at once. Waiting for the 5s
  // publish timer is what made a save take ~4.6s to appear in the panel.
  const publishStart = Date.now()
  let publishMs = -1
  while (Date.now() - publishStart < 2000) {
    if (Array.isArray(live.discoveredSkills) && live.discoveredSkills.some((s) => s.name === 'smoke-project-skill')) {
      publishMs = Date.now() - publishStart
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  note(publishMs >= 0 && publishMs < 400,
    `操作后立即发布（列表数据 ${publishMs}ms 内可见，无需等 5 秒周期）`)

  // Delete: the card's spinner is driven by the receipt, its disappearance by the
  // published list — so both must land, and just as fast. A missing receipt left
  // 「删除中…」 spinning forever, and a stale list left the card in place.
  const delNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'delete', scope: 'project', id: 'agents', project: stage, path: projFile, name: 'smoke-project-skill', prevName: '', description: '', body: '', nonce: delNonce }
  const delStart = Date.now()
  let delMs = -1
  while (Date.now() - delStart < 2000) {
    const listed = Array.isArray(live.discoveredSkills) && live.discoveredSkills.some((s) => s.name === 'smoke-project-skill')
    if (live.skillResult?.nonce === delNonce && live.skillResult?.ok === true && !listed) {
      delMs = Date.now() - delStart
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  note(live.skillResult?.nonce === delNonce && live.skillResult?.ok === true, '删除回执成功且 nonce 原样返回')
  note(!existsSync(projFile), '删除后 SKILL.md 真的从磁盘消失')
  // The budget to beat is the 5s periodic publish; the delete itself re-scans the
  // roots before republishing, so it is not held to the create path's 400ms.
  note(delMs >= 0 && delMs < 1500,
    `删除后列表在回执同轮就已更新（实测 ${delMs}ms，未等 5 秒周期）`)

  // Deleting an already-deleted skill must still answer: a silent no-answer is
  // what made the panel's card spin forever instead of reporting 「不存在」.
  const againNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'delete', scope: 'project', id: 'agents', project: stage, path: projFile, name: 'smoke-project-skill', prevName: '', description: '', body: '', nonce: againNonce }
  const againStart = Date.now()
  while (Date.now() - againStart < 2000 && live.skillResult?.nonce !== againNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  note(live.skillResult?.nonce === againNonce && live.skillResult?.ok === false,
    '重复删除同样有回执（ok=false + 原因，卡片不会一直空转）')
  note(live.skillRequest?.nonce === '', '删除处理完清空了请求（防重启重放）')

  // Channel 5: on-demand body read. The preview asks for the file by path and the
  // Host verifies that path came from the latest scan before reading it.
  const target = discovered.find((skill) => skill.name === 'smoke-discovered')
  // Poll: the Host drains its request channel on a 600ms timer, so a fixed short
  // wait is a coin flip (and made this suite flaky under any timing change).
  const readNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'read', scope: '', id: '', project: '', path: target?.path ?? '', name: '', prevName: '', description: '', body: '', nonce: readNonce }
  const readStart = Date.now()
  while (Date.now() - readStart < 2000 && live.skillResult?.nonce !== readNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const readResult = live.skillResult ?? {}
  note(readResult.nonce === readNonce && readResult.ok === true, 'read 通道回执成功（按需读取正文）')
  note(typeof readResult.body === 'string' && readResult.body.includes('发现'), 'read 通道返回了正文内容')
  note(live.skillRequest?.nonce === '', 'read 处理完清空了请求（防重放）')

  // Regression guard for the reported bug: previewing a skill must not shrink the
  // discovered list (a `read` used to re-scan with the request's own empty roots).
  const beforeRead = Array.isArray(live.discoveredSkills) ? live.discoveredSkills.length : -1
  const shrinkNonce = String(Date.now())
  live.skillResult = { ok: false, reason: '', name: '', nonce: '' }
  live.skillRequest = { op: 'read', scope: '', id: '', project: '', path: target?.path ?? '', name: '', prevName: '', description: '', body: '', nonce: shrinkNonce }
  const shrinkStart = Date.now()
  while (Date.now() - shrinkStart < 2000 && live.skillResult?.nonce !== shrinkNonce) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const afterRead = Array.isArray(live.discoveredSkills) ? live.discoveredSkills.length : -1
  note(beforeRead > 0 && afterRead === beforeRead, `预览(read)不会让列表缩水（${beforeRead} → ${afterRead}）`)
  note(typeof live.discoveryInfo?.at === 'string' && live.discoveryInfo.at !== '', 'discoveryInfo 记录了扫描时间（诊断通道可用）')
} catch (error) {
  note(false, '冒烟脚本自身出错：' + error.message)
} finally {
  process.removeAllListeners('uncaughtException')
  process.removeAllListeners('unhandledRejection')
  await rm(stage, { recursive: true, force: true })
  if (createdScopeLink) await rm(scopeLink, { force: true })
}

if (problems.length > 0) {
  console.log('  ✗ Host 冒烟失败：' + problems.join(' | '))
  process.exit(1)
}
console.log('  ✓ Host 冒烟通过：加载 / skillRequest / importRequest / rowOps 排空 / 磁盘技能发现 / 按需读正文 全部正常')
process.exit(0)
