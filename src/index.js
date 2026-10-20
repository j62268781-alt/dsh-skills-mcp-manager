/**
 * Host half of the Skills & MCP panel.
 *
 * Two file-first sources of truth, one in-memory read model:
 *
 *   · skills → `<root>/<name>/SKILL.md`, written by the `POST /skills` route. There is no
 *     `config.skills[]` and no reconcile loop; the disk scan is the list.
 *   · MCP    → the profile patch's `mcp-client` rows. The `POST /rows` route writes them
 *     directly (lock + atomic write + backup), and `/runtime` reads the same file back.
 *
 * Commands (row CRUD, skill writes/read, reconnect, import) are HTTP request/response;
 * nothing transient is persisted. The only settings field left is `toolFilters`, a real
 * user preference. The read model (`/runtime`) is recomputed per request: rows from the
 * file, `phase` from the Loader, tools from the live registry, status from probe caches,
 * skills from the periodic scan.
 *
 * @module dsh-skills-mcp-manager
 */
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { commandEnv, parseEnv, resolveCommand, setHomeResolver, spawnEnv, splitArgs } from './runtime/env.js'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { applyRowOp, migratePanelConfig, setPatchIO } from './patch/apply.js'
import { scanImportSource } from './import/scan.js'
import { registerImportRoute } from './import/route.js'
import { beat } from './diagnostics/heartbeat.js'
import { agentsHome, projectRootOf } from './skills/reconcile.js'
import { bodyOf, discoverSkills } from './skills/discover.js'
import { createSkill, deleteSkill, renameSkill, updateSkill, writableRoots } from './skills/write.js'
import { registerSkillRoute } from './skills/route.js'
import { registerSkillReadRoute } from './skills/read.js'
import { serverMountConfig, setMountClient, workingDirectoryOf } from './project/mount.js'
import { GLOBAL_SCOPE, projectServersFor, serverRows, serverSetKey } from './mcp/serverRows.js'
import { readMcpRowsFromPatch } from './patch/readRows.js'
import { connectionDraftOf } from './mcp/connection.js'
import { toolsByServer } from './mcp/tools.js'
import { registerRuntimeRoute } from './mcp/runtime.js'
import { registerRowRoute } from './mcp/rows.js'
import { registerReconnectRoute } from './mcp/reconnect.js'
import { installShadow, isMcpName, judge, liveToolNames } from './mcp/filter.js'
import { PROBE_STATE, createConnectionProbe } from './mcp/probe.js'
import { authDetailText } from './mcp/auth.js'
import { createAuthProbe } from './mcp/authprobe.js'
import { openExternalUrl } from './mcp/oauth/browser.js'
import { SERVER_STATUS, deriveStatus, reconnectBudgetMs, remainingSeconds } from './mcp/status.js'
import { createOAuthStore } from './mcp/oauth/store.js'
import { createOAuthProvider, tokenStatus } from './mcp/oauth/provider.js'
import { loadSdk, oauthSdkReasonText } from './mcp/oauth/sdk.js'
import { installTransportPatch, makeAuthProvider, patchReasonText } from './mcp/oauth/patch.js'
import { createOAuthFlow, flowReasonText } from './mcp/oauth/flow.js'
import { CALLBACK_PATH, registerOAuthCallback } from './mcp/oauth/callback.js'
import { OAUTH_PATH, registerOAuthRoute } from './mcp/oauth/route.js'

setMountClient(mcpClient)

setPatchIO({ withFileLock, writeFileAtomic })
import { isMap, isSeq, parseDocument } from 'yaml'

import { NAME as name } from './identity.js'
export { name }

/** The Loader is core, so requiring it costs nothing and never blocks startup. */
export const inject = ['loader']

/** One queued change against a row the profile itself configures. */
const RowOp = z.object({
  op: z.union(['add', 'delete', 'update', 'toggle']),
  /** delete/update: the row to touch; add: the id for the new row (blank = derive). */
  entryId: z.string().default(''),
  serverName: z.string().default(''),
  transport: z.string().default('streamable-http'),
  url: z.string().default(''),
  command: z.string().default(''),
  /** stdio arguments, space separated (the panel's form shape). */
  args: z.string().default(''),
  /** extra child environment, one KEY=VALUE per line. */
  env: z.string().default(''),
  /** HTTP headers, one KEY=VALUE per line. */
  headers: z.string().default(''),
  /**
   * stdio 用哪个 npm 家族：`system`（默认）或 `auto`（跟随 Harness 自带的 node + pnpx）。
   *
   * 这个字段**原先根本不存在**，于是面板上那个「运行时」下拉是个纯装饰：选择写进 draft、
   * 却既不进 RowOp 也不落盘，Host 一律按默认分支走。用户的直觉是对的 —— 选什么都不生效，
   * 那就是 bug。
   *
   * `system` 是默认值，因为 `auto` 走 pnpx 时解析到的 pnpm store 里依赖没有链接进去：
   * `server-memory` / `server-filesystem` 会 `Cannot find package 'zod'` 直接退出。
   * 只有系统找不到 npx 时才回落到 pnpx（见 src/project/mount.js）。
   */
  runtime: z.string().default('system'),
  /** Connection policy written into the row's config (see src/mcp/connection.js). */
  failOnStartupError: z.boolean().default(false),
  reconnectInitialDelayMs: z.string().default(''),
  reconnectMaxDelayMs: z.string().default(''),
  reconnectMaxAttempts: z.string().default(''),
  /** Per-call tool timeout for this server ('' = the client's own default). */
  toolCallTimeoutMs: z.string().default(''),
  /**
   * 这台服务器的 token 端点允许**明文 http**（非回环地址）。
   *
   * 默认关闭，且**这是唯一能开启它的地方**：每台服务器自己的字段，不存在全局开关。
   * 开启后 OAuth 的 token 交换（含 refresh）会把 `access_token` / `refresh_token` 以
   * 明文发到内网 —— 同网段任何能嗅探的设备都能读到。SDK 的 `assertSecureTokenEndpoint`
   * 无条件拒绝这种端点（这是对的），所以本插件用 `src/mcp/oauth/insecure.js` 自己完成那一步，
   * 每次明文请求都记一条 warning。
   *
   * 存在的理由：内网部署的授权服务器（如 MCPHub）常常没有 TLS，而它既不是回环地址、
   * 也不会升级 https。没有这个例外，那类服务器在 OAuth 上完全不可用。
   */
  allowInsecureTokenEndpoint: z.boolean().default(false),
  /**
   * update: whether the user actually edited the connection fields.
   *
   * Defaults to false on purpose: a form whose fields were not prefilled (an older
   * Host does not project them) must not wipe a configured value on an unrelated
   * edit, and a missing flag is the recoverable direction.
   */
  connectionChanged: z.boolean().default(false),
  /** toggle: the desired enabled state of the row. */
  enabled: z.boolean().default(true),
  /**
   * add/update: the row's tier. `global` (or empty) leaves the key off, which is what a
   * row without a `scope` already means — so existing rows stay valid untouched.
   */
  scope: z.string().default(''),
  /** update: whether the user actually changed the tier (blank = leave it alone). */
  scopeChanged: z.boolean().default(false),
})

setHomeResolver(resolveDshHome)

/**
 * One skill write request, validated by the `POST /<name>/skills` route.
 *
 * Plain schema (no `.volatile()`): a volatile schemastery schema returns `{}` when called,
 * which would strip `scope`/`id` and make every write answer 「未知的写入区域」. The same
 * distinction once cost this repository a full debugging round.
 */
const SkillRequest = z.object({
  op: z.string().default(''),
  scope: z.string().default(''),
  id: z.string().default(''),
  project: z.string().default(''),
  /**
   * The `SKILL.md` path for `op: 'read'` — the editor and the preview send only this.
   *
   * It was in the inline schema this definition replaced, and dropping it silently broke
   * 「编辑」: the panel sent the read request, validation stripped `path`, and the Host answered
   * 「该技能不在当前扫描结果里」. Creating still worked (it goes over HTTP now and never sends
   * `path`), which is exactly why the loss was easy to miss.
   */
  path: z.string().default(''),
  name: z.string().default(''),
  prevName: z.string().default(''),
  description: z.string().default(''),
  body: z.string().default(''),
  nonce: z.string().default(''),
})

/**
 * One OAuth command, as the panel sends it to `POST /<name>/oauth`.
 *
 * Kept as a **plain schema** (no `.volatile()`) for exactly the reason documented on
 * `SkillRequest` above: a `.volatile()` schema returns `{}` when called, so the route's
 * `schema(payload)` would hand `run` an empty object and every command would answer
 * 「未知的 OAuth 操作」. This distinction has already cost this repository one full round of
 * debugging (skill edit/delete), so it is stated here rather than rediscovered.
 *
 * The action set is closed: `authorize`, `status`, `logout`. Finishing an authorization is
 * **not** a command — it arrives as the authorization server's browser redirect, which is
 * why it lives in `src/mcp/oauth/callback.js`.
 */
const OAuthCommand = z.object({
  action: z.union(['authorize', 'status', 'logout']),
  serverName: z.string().default(''),
})

/** One reconnect command (`POST /<name>/reconnect`). Plain schema: it is a validator. */
const ReconnectRequest = z.object({
  tier: z.string().default(''),
  serverName: z.string().default(''),
  scope: z.string().default(''),
})

/** One import scan request (`POST /<name>/import`). Plain schema: it is a validator. */
const ImportRequest = z.object({
  source: z.string().default(''),
  scope: z.string().default('project'),
  project: z.string().default(''),
})

export const Config = z.object({
  /**
   * 每个服务器的工具过滤规则：`{ [serverName]: { mode, tools } }`。
   *
   * 这是本插件**唯一**持久化的用户配置。技能与 MCP 行都不再经过 settings：
   *   · 技能 = 磁盘上的 `SKILL.md`；
   *   · MCP = profile patch 里的 Loader 行（面板通过 HTTP 路由直接改该文件）；
   *   · 列表 / 工具 / 连接状态 / 授权状态 = `/runtime` 现算，不落盘。
   *
   * `mode`：`off`（不过滤，默认）/ `allow`（只保留 tools 里的）/ `deny`（只挡 tools 里的）。
   * 面板写入，Host 在注册那一刻据此决定要不要放行。见 `src/mcp/filter.js` 的取舍说明：
   * mcp-client 自身没有白名单字段，`ctx.tools.restrict()` 又要求 scoped 上下文，
   * 所以唯一的接缝是劫持工具服务实例的 `register`。
   */
  toolFilters: z.dict(z.object({
    mode: z.string().default('off'),
    tools: z.array(z.string()).default([]),
  })).default({}).volatile(),
})
/** The shipped mcp-client plugin, re-mounted per server inside this scope. */
const mcpPlugin = {
  name: mcpClient.name,
  apply: mcpClient.apply,
  inject: mcpClient.inject,
  Config: mcpClient.Config,
}

/**
 * cordis fiber 状态 → 官方 phase 文案。
 *
 * 顺序就是 `FiberState` 的枚举顺序（PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING），
 * 与 `@deepseek-ai/dsh-host-plugin-inventory` 的 FIBER_PHASE 一致。`null` 表示没有对应
 * 文案（DISPOSED）。
 */
const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', null, 'unloading']

/**
 * 读一行的 fiber 状态。
 *
 * 修掉一个死字段：原先读的是 `entry.fiberPhase`，但那是
 * `dsh-host-plugin-inventory` **另外算出来**的派生字段，原始 Loader entry 上只有
 * `entry.fiber`（Fiber 对象），于是 `phase` 永远是空串 —— 面板因此无法区分
 * 「连上了但没有工具」和「压根没加载起来」。两种形态都认，优先用官方已算好的。
 */
const phaseOf = (entry) => {
  const direct = entry?.fiberPhase
  if (typeof direct === 'string' && direct !== '') return direct
  return fiberPhaseOf(entry?.fiber)
}

/** 同一个映射，但直接吃一个 fiber 对象 —— 本插件自己挂载的那些项目级服务器用这个。 */
const fiberPhaseOf = (fiber) => {
  const state = fiber?.state
  const mapped = Number.isInteger(state) ? FIBER_PHASE[state] : undefined
  return typeof mapped === 'string' ? mapped : ''
}

/** Stable identity of the global servers that should be mounted. */




























/** Keep the last rewrites so a bad edit is always recoverable. */

/** Workspaces the registry knows, reduced to what the project picker needs. */
function configuredWorkspaces(ctx) {
  try {
    const registry = ctx.get?.('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
    return JSON.parse(JSON.stringify(registry.list().map((workspace) => ({
      id: String(workspace?.id ?? ''),
      title: String(workspace?.title ?? ''),
      path: String(workspace?.path ?? ''),
    })).filter((workspace) => workspace.path !== '')))
  } catch (error) {
    // Distinguish "no workspaces" from "the registry blew up".
    if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] workspace registry unavailable', error)
    return []
  }
}

/** The Loader service, reached without depending on injection timing. */
function loaderOf(ctx) {
  try {
    const direct = ctx.get?.('loader')
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // fall through to the injected property
  }
  try {
    return ctx.loader ?? null
  } catch {
    // Expected: a bare access throws in cordis before the service is injected.
    return null
  }
}

/** The active profile's `cordis.patch.yml`, or '' when the profile is not injected yet. */
function patchFileOf(ctx) {
  try {
    const profile = ctx.get?.('profileContext') ?? ctx.profileContext
    if (profile === null || typeof profile !== 'object') return ''
    if (typeof profile.dir !== 'string' || profile.dir === '') return ''
    return join(profile.dir, 'cordis.patch.yml')
  } catch {
    return ''
  }
}

/** Awaitable patch-row refresh (mtime cache; the promise is shared while a read is in flight). */
let patchRowsCache = { file: '', mtimeMs: -1, entries: null }
let patchRowsInFlight = null
/** 由 `apply()` 绑定：文件里出现了新行时立刻刷新运行态。 */
let onPatchRowsRefreshed = () => {}

/** Read the patch file once and cache the entries together with its mtime. */
async function refreshPatchRows(file, { force = false } = {}) {
  if (patchRowsInFlight !== null) {
    if (!force) return patchRowsInFlight
    // A write just happened: a read that started before it would cache the OLD mtime and
    // hand the caller a list without the new row (the client then keeps its optimistic
    // card next to the real one). Wait for that read, then read the file again.
    await patchRowsInFlight
  }
  patchRowsInFlight = readMcpRowsFromPatch(file)
    .then((result) => {
      if (result.ok === true) {
        patchRowsCache = { file, mtimeMs: result.mtimeMs, entries: result.entries }
        try { onPatchRowsRefreshed() } catch { /* 下一次 refresh 会再试 */ }
      }
      return result
    })
    .catch(() => ({ ok: false, reason: 'patch 读取失败' }))
    .finally(() => { patchRowsInFlight = null })
  return patchRowsInFlight
}

/**
 * Every configured `mcp-client` entry: the file is the config fact, the Loader adds runtime.
 *
 * **文件优先，Loader 补运行态。** The file already contains the row we just wrote, while the
 * Loader may need seconds to reload it; reading the Loader first is what made a saved edit
 * appear only after "a while". `phase` still comes from the Loader, because only it knows
 * the fiber state. When it has not caught up, `phase` is empty and the card says 「连接中」,
 * which is the truth.
 */
function configuredEntries(ctx) {
  const loader = loaderOf(ctx)
  const liveEntries = loader !== null && typeof loader.entries === 'function' ? [...(loader.entries() ?? [])] : null
  let entries = liveEntries
  const file = patchFileOf(ctx)
  if (file !== '') {
    let mtimeMs = -1
    try { mtimeMs = statSync(file).mtimeMs } catch { mtimeMs = -1 }
    if (mtimeMs >= 0) {
      if (patchRowsCache.file !== file || patchRowsCache.mtimeMs !== mtimeMs) {
        // 文件变了（或第一次看）：先发起读取，这一轮仍用 Loader 的视图。
        refreshPatchRows(file)
      } else if (patchRowsCache.entries !== null) {
        const live = new Map((liveEntries ?? []).map((entry) => [String(entry?.id ?? ''), entry]))
        entries = patchRowsCache.entries.map((entry) => {
          const running = live.get(String(entry.id))
          // 只借运行态字段，行的配置一律以文件为准。
          return running === undefined ? entry : { ...entry, fiber: running.fiber, disabled: entry.disabled ?? running.disabled }
        })
      }
    }
  }
  return { loaderFound: entries !== null, entries }
}

/** The mount path's view (real server fields) — same source as the panel list. */
function configuredServers(ctx) {
  const { entries } = configuredEntries(ctx)
  if (entries === null) return []
  return serverRows(entries)
}

/**
 * The panel's view of every configured server, in the form its forms need.
 *
 * Built on {@link serverRows} so there is exactly one projection from rows to servers —
 * the panel used to receive a differently-shaped object than the mount path did, from a
 * different source (rows for global, `config.servers` for project), which is how the two
 * tiers drifted apart in the first place.
 *
 * `args`/`env`/`headersText` are the *form* shapes (one string, one `KEY=VALUE` per line);
 * `scope` travels with the row so the panel can split one list into its two tabs instead of
 * merging two arrays.
 */
function configuredMcpRows(ctx) {
  const { loaderFound, entries } = configuredEntries(ctx)
  if (entries === null) return { loaderFound: false, rows: [] }
  try {
    const rows = serverRows(entries).map((server) => ({
      entryId: server.entryId,
      serverName: server.serverName,
      scope: server.scope,
      transport: server.transport,
      target: server.target,
      command: server.command,
      args: server.args.join(' '),
      env: Object.entries(server.env).map(([key, value]) => `${key}=${String(value)}`).join('\n'),
      headersText: Object.entries(server.headers).map(([key, value]) => `${key}=${String(value)}`).join('\n'),
      // Connection policy travels with the row so 编辑 can show what is set.
      ...connectionDraftOf(server),
      // 面板要能读回当前值，否则「编辑」永远显示默认，用户改过的看不出效果。
      runtime: server.runtime,
      enabled: server.enabled,
      phase: server.phase,
    }))
    return { loaderFound, rows }
  } catch (error) {
    return { loaderFound, rows: [], error: String(error?.message ?? error) }
  }
}

/**
 * Every MCP server name this panel can speak for.
 *
 * A filter may only judge names whose server the panel can actually see configured;
 * anything else is left alone, because the panel has no standing to drop a tool
 * belonging to a server it does not manage. The union covers both tiers: the
 * profile's own rows (Loader entries) and the panel's in-memory entries (global and
 * per-project).
 */
function configuredServerNames(ctx, memoryServers = []) {
  const names = new Set()
  const { rows } = configuredMcpRows(ctx)
  for (const row of rows) {
    if (typeof row.serverName === 'string' && row.serverName !== '') names.add(row.serverName)
  }
  for (const server of Array.isArray(memoryServers) ? memoryServers : []) {
    if (typeof server?.serverName === 'string' && server.serverName !== '') names.add(server.serverName)
  }
  return [...names]
}

/**
 * Reconcile continuously.
 *
 * The settings page writes `.volatile()` fields straight into the running
 * config; that update never re-runs `apply`. So this half reads the live values
 * on a slow tick and re-applies only what actually changed — a save in the panel
 * takes effect within a couple of seconds, and the work stays idempotent.
 *
 * Global servers mount in the root scope (where a configured row lives, so every
 * agent sees their tools). Project servers mount in a matching agent's own scope
 * at `agent/created`, which is how the shipped client scopes tools per agent.
 */
export function apply(ctx, config) {
  /**
   * Every configured MCP server, from the profile patch's `mcp-client` rows.
   *
   * Both tiers come from here now. This used to read `config.servers`, a field this plugin
   * owned, while the global tier lived in rows — the same feature stored two ways, with the
   * panel merging two arrays to render one list and a scope-less registry read unable to
   * see project tools at all. Rows are the single source of truth; `scope` is the only
   * difference between the tiers (see `src/mcp/serverRows.js`).
   */
  // `entries()` is a **generator**, not an array: passing it straight to `serverRows`
  // (which requires an array) silently produced an empty list — every server looked
  // unconfigured, while the projection right next to it, which spreads first, saw all of
  // them. Spread here too, and never assume `Array.isArray` on a loader return value.
  const readServers = () => serverRows([...(loaderOf(ctx)?.entries?.() ?? [])])
  const readFilters = () => config?.toolFilters?.get?.() ?? config?.toolFilters ?? {}

  /**
   * The tool filter, installed before anything else in this plugin runs.
   *
   * Ordering is the whole ballgame: `dsh-mcp-client` registers a server's first
   * tool generation while it starts, and a plugin cannot unregister another
   * plugin's tools. This panel is a **bundle-layer** plugin while the MCP rows live
   * in the profile's own patch, and the profile composes bundle patches first — so
   * installing here, synchronously during `apply`, is what makes the shadow land
   * ahead of every MCP client.
   *
   * The rules are read through a getter on every registration rather than captured
   * once, so a panel edit takes effect without a restart (the settings document
   * writes these volatile fields straight into the live config).
   */
  const filterState = { installed: false, reason: '', dropped: [], preExisting: [] }
  const droppedNames = []
  /**
   * Server names the filter may speak for, cached.
   *
   * The judge runs once per tool registration, and reading the Loader's entries on
   * every one of them would walk the whole entry list for each tool of every
   * server. The set changes only when a row is added or removed, so it is refreshed
   * on the same slow tick that publishes the projection instead.
   */
  /**
   * The one-time server migration's outcome, published on the heartbeat.
   *
   * It has silently done nothing twice now — once because the field it reads looked empty,
   * once because the timer never ran — and both times the only symptom was "nothing
   * changed", which is indistinguishable from "nothing to do". So the outcome is a visible
   * field, the same technique that made the route installation and the entry rename
   * diagnosable.
   */
  const serverMigrationState = { status: 'pending', reason: '', migrated: 0, source: 0 }

  let filterServerNames = []
  const refreshFilterServers = (memoryServers) => {
    filterServerNames = configuredServerNames(ctx, memoryServers)
  }
  refreshFilterServers(readServers())
  const shadow = installShadow(
    ctx,
    (name) => {
      const verdict = judge(name, readFilters(), filterServerNames)
      if (!verdict.admit && typeof name === 'string' && droppedNames.length < 512 && !droppedNames.includes(name)) {
        droppedNames.push(name)
        filterState.dropped = [...droppedNames]
      }
      return verdict
    },
    { warn: (message) => ctx.logger.warn(message) },
  )
  filterState.installed = shadow.installed
  filterState.reason = shadow.reason
  if (shadow.installed) {
    filterState.preExisting = liveToolNames(ctx).filter(isMcpName)
    ctx.logger.info('dsh-skills-mcp-manager: MCP tool filter installed (%d pre-existing MCP tool(s))', filterState.preExisting.length)
  } else {
    // Reported, never swallowed: "filtering is off" and "filtering could not be
    // installed" look identical in the UI otherwise, and only one of them is the
    // user's configuration.
    ctx.logger.warn('dsh-skills-mcp-manager: MCP tool filter not installed — %s', shadow.reason)
  }
  ctx.effect(() => () => shadow.restore(), 'dsh-skills-mcp-manager.tool-filter')

  /**
   * Connection probe: asks `mcpResources` what each server's state is.
   *
   * Deliberately a *caller* of the service rather than a hijack of it. The first
   * implementation shadowed `mcpResources.register`, which looked tidy and was wrong:
   * the profile recreates that service instance on recomposition, so a shadow written
   * once sat on a dead instance and captured nothing — while still reporting itself
   * installed. Calling the public `request()` re-resolves the provider on every probe
   * and cannot rot that way.
   *
   * This is what lets the panel warn about a server that quietly died. The client gives
   * up permanently once its retry budget runs out, and until then that was invisible:
   * the tools simply disappeared and nothing said whether the server was still retrying
   * or already dead.
   */
  const probe = createConnectionProbe(ctx, { warn: (message) => ctx.logger.warn(message) })
  if (!probe.available()) {
    // Reported, never swallowed: "no server is down" and "we cannot tell" must not look
    // the same, or the status tag would show a confident lie. The service can also appear
    // later (the profile composes rows after this plugin), so this is not fatal — the
    // availability check is re-run on every publish.
    ctx.logger.warn('dsh-skills-mcp-manager: MCP connection probe unavailable — %s', probe.reason())
  }

  /**
   * Auth-challenge probe: asks the server over HTTP whether it is demanding authorization.
   *
   * A separate detector from {@link probe} on purpose. The MCP client supports no OAuth at
   * all (no `authProvider` reaches the SDK), so a protected server's 401 is retried like a
   * network fault and finally reported as "gave up" — the panel would tell the user their
   * server is broken when all they need is to authorize it. `mcpResources.request()` cannot
   * see the 401 either: the client throws "server is disconnected" before any HTTP happens.
   *
   * See `src/mcp/authprobe.js` for why the probe has to be a real `initialize` POST.
   */
  const authProbe = createAuthProbe({ warn: (message) => ctx.logger.warn(message) })
  /** Last auth-challenge verdict per server: `{ at, challenge }`. null challenge = none seen. */
  const authCache = new Map()
  /** Servers with an auth probe in flight, so a slow server cannot pile up requests. */
  const authProbing = new Set()

  // ── OAuth ────────────────────────────────────────────────────────────────────────────
  //
  // Everything below exists because `dsh-mcp-client` never passes an `authProvider` to the
  // SDK: `createTransport()` gives `StreamableHTTPClientTransport` only
  // `{ requestInit: { headers } }`, so the SDK's `if (401 && this._authProvider)` branch can
  // never run. A protected server's 401 is therefore retried like a network fault and finally
  // reported as "gave up" — the panel said the server was broken when all it needed was a
  // grant. `src/mcp/auth.js` already *detects* that; this half *fixes* it.
  //
  // Three pieces, each of which can fail independently and is reported as a reason:
  //   1. `sdk.js`     — resolve the SDK that ships inside the app runtime (the plugin's own
  //                     `node_modules` has no `@modelcontextprotocol/client`).
  //   2. `patch.js`   — inject `_authProvider` on each transport's `start()`, because
  //                     `authProvider` can only arrive through the constructor.
  //   3. `flow.js` + `callback.js` — run the authorization-code flow and receive the code.
  //
  // Loaded lazily and asynchronously: a failed *optional* capability must never stop the
  // plugin from loading (a rejected `apply()` takes every other plugin down with it).
  const oauthStore = createOAuthStore({ dshHome: resolveDshHome(), log: { warn: (message) => ctx.logger.warn(message) } })
  /** Last authorize/login result per server, so the card can report what just happened. */
  const oauthResultCache = new Map()
  /** Last on-disk authorization state per server, refreshed off the publish path. */
  const oauthStatusCache = new Map()
  /** Servers whose status refresh is in flight, so a slow disk cannot pile up reads. */
  const oauthStatusPending = new Set()
  /**
   * Kick a projection refresh now instead of waiting for the 5 s publish interval.
   *
   * Late-bound on purpose: `tick` and `publish` are declared further down in `apply()` (one
   * at the bottom, one inside the settings injection), while the OAuth helpers that need them
   * are declared here. A plain reference would be a TDZ error at call time. The settings
   * injection assigns the real implementation; until then this is a no-op, which is the safe
   * direction — the periodic publish still runs.
   */
  let kickProjection = () => {}
  /** `{ ok, sdk } | { ok: false, reason, detail }` once the SDK load settles. */
  let oauthSdk = null
  let oauthReady = { ready: false, reason: '', detail: '', sdkVersion: '' }
  let oauthFlow = null
  let oauthCallbackReady = false
  let oauthCallbackPath = ''

  /**
   * A provider factory bound to this plugin's store.
   *
   * `redirectUri` has to be built from the live `webServer` origin: the listener may bind a
   * port chosen by the OS, so it cannot be known before `listen`. Rebuilt on every call
   * rather than captured once — a different port would otherwise produce a `redirect_uri`
   * the server rejects.
   */
  const oauthRedirectUri = () => {
    // `ctx.get('webServer')`, NOT `ctx.webServer`.
    //
    // This plugin's `inject` list is `['loader']`, so a bare `ctx.webServer` is always
    // undefined at this level — the service is only reachable through `ctx.get()`, or inside
    // one of the `ctx.inject([...])` callbacks. Reading `.webServer` directly returned '' and
    // the projection published an empty `redirectUri`, which makes the SDK treat the flow as
    // **non-interactive** (`redirectUrl === undefined` → it skips the whole authorization-code
    // branch). That failure is silent: `ready` still says true and the button still appears.
    //
    // Re-resolved on every call rather than captured once, for the same reason
    // `src/mcp/probe.js` does it: the profile recreates services on recomposition, and a
    // captured instance would go stale while still looking installed.
    try {
      const service = ctx.get?.('webServer') ?? null
      if (service === null || service === undefined) return ''
      const origin = service.getOrigin?.()
      if (typeof origin !== 'string' || origin === '') return ''
      return `${origin}${CALLBACK_PATH}`
    } catch {
      // `getOrigin()` throws before the listener binds a port — expected during startup.
      return ''
    }
  }

  const makeOAuthProvider = (serverName, url) => createOAuthProvider({
    store: oauthStore,
    serverName,
    url,
    redirectUri: oauthRedirectUri(),
    onRedirect: async (authorizeUrl) => {
      // The transport path (401 during normal operation) reaches here too. There is no panel
      // request waiting for it, so record it where the status projection will find it.
      oauthResultCache.set(serverName, {
        ok: true, kind: 'redirect', reason: '', text: '这台服务器需要授权：点「授权」按钮完成登录',
        detail: '', authorizeUrl, at: new Date().toISOString(),
      })
      kickProjection()
    },
    log: { warn: (message) => ctx.logger.warn(message) },
  })

  /**
   * Look up the provider for a transport about to start.
   *
   * The patch calls this with the transport's `_url`; we map back to a configured server.
   * Only `streamable-http` rows are candidates — stdio has no HTTP status code to challenge.
   * Returns `null` when the server has no saved credentials, so an unauthenticated server
   * behaves exactly as before.
   */
  const oauthLookup = (targetUrl) => {
    if (oauthSdk === null || oauthSdk.ok !== true || oauthFlow === null) return null
    let origin = ''
    let href = ''
    try {
      const parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl))
      origin = parsed.origin
      href = parsed.href
    } catch {
      return null
    }
    if (origin === '') return null
    for (const server of candidateServers()) {
      if (String(server?.transport ?? '') !== 'streamable-http') continue
      const rowUrl = String(server?.url ?? '')
      if (rowUrl === '') continue
      let rowHref = ''
      try { rowHref = new URL(rowUrl).href } catch { continue }
      if (rowHref !== href) continue
      const serverName = String(server.serverName ?? '')
      if (serverName === '') continue
      let made
      try {
        // The **flow's** instance, not a new one.
        //
        // Each provider caches the credential record in memory. Building a second instance
        // here gave the transport its own stale "no tokens" snapshot: after the user
        // authorized, `flow.complete()` wrote the token through its instance, the transport
        // kept reading the other one, and the server answered 401 forever while the panel
        // showed 「已授权」. One server must have exactly one provider.
        made = oauthFlow.providerFor(serverName, rowUrl)
      } catch (error) {
        ctx.logger.warn('dsh-skills-mcp-manager: cannot build an OAuth provider for %s: %s', serverName, String(error?.message ?? error))
        return null
      }
      if (made === undefined || made === null) return null
      return {
        provider: makeAuthProvider({
          sdk: oauthSdk.sdk,
          oauthProvider: made.provider,
          log: { warn: (message) => ctx.logger.warn(message) },
          serverName,
          /**
           * 明文端点的 401 处理：先让 flow 自己换一次令牌。
           *
           * SDK 的 `auth()` 在存在 refresh_token 时无条件走它的刷新，而那条路上的 TLS
           * 检查会抛 InsecureTokenEndpointError 且不吞掉 —— 结果是「令牌过期 → 每次重试
           * 都以一个与令牌无关的错失败」。刷新成功就不用麻烦用户；失败才去要一次授权。
           *
           * 只在 flow 已经建好时提供；没有 flow 就没有 OAuth，这条路径本来也走不到。
           */
          prepareAuth: oauthFlow === null ? undefined : () => oauthFlow.prepareAuth(serverName, rowUrl),
        }),
        oauthProvider: made.provider,
      }
    }
    return null
  }

  /** Every configured server, both tiers. Rows are the single source of truth. */
  /**
   * Every configured MCP server, as `serverRows` produced it.
   *
   * **Deliberately not a hand-written projection.** It used to be
   * `rows.map((row) => ({ serverName, transport, url, scope }))`, and when the OAuth half
   * later needed `allowInsecureTokenEndpoint`, that field was silently missing — the switch
   * in the panel wrote `true` to the row, `candidateServers()` dropped it on the way out, and
   * the exchange refused with 「允许明文 token 端点没有打开」while the box was visibly ticked.
   *
   * This repo has now shipped that same mistake three times (a hand-written field list left
   * out `toolCallTimeoutMs`, the `connectionChanged` comparison, and this one). The fix that
   * stops it recurring is not "remember to add the field" — it is to stop re-listing fields.
   * Consumers read what they need off the row.
   */
  const candidateServers = () => {
    try {
      return serverRows([...(loaderOf(ctx)?.entries?.() ?? [])])
    } catch {
      return []
    }
  }

  /**
   * Load the SDK and install the transport patch, once.
   *
   * Ordered before anything else in `apply()` that could construct a transport: this plugin
   * is a **bundle-layer** plugin while the MCP rows live in the profile's own patch, and the
   * profile composes bundle patches first — so a patch installed here lands ahead of every
   * row's `apply()`. That ordering is why the injection is possible at all.
   */
  const bootstrapOAuth = async () => {
    // `import.meta.resolve` is the only way to find the host package from inside a plugin:
    // `@deepseek-ai/dsh-mcp-client` is a peer dependency, so its own `file:` URL is the one
    // reliable anchor for the runtime's `node_modules`.
    let hostUrl = ''
    try {
      hostUrl = import.meta.resolve('@deepseek-ai/dsh-mcp-client')
    } catch (error) {
      oauthReady = { ready: false, reason: 'no-host-package-url', detail: String(error?.message ?? error), sdkVersion: '' }
      ctx.logger.warn('dsh-skills-mcp-manager: OAuth support unavailable — %s', oauthReady.detail)
      return
    }
    const loaded = await loadSdk(hostUrl)
    oauthSdk = loaded
    if (loaded.ok !== true) {
      oauthReady = { ready: false, reason: String(loaded.reason ?? ''), detail: oauthSdkReasonText(loaded), sdkVersion: '' }
      ctx.logger.warn('dsh-skills-mcp-manager: OAuth support unavailable — %s (%s)', oauthReady.detail, String(loaded.detail ?? ''))
      return
    }
    const patched = installTransportPatch({
      sdk: loaded.sdk,
      lookup: oauthLookup,
      log: { warn: (message) => ctx.logger.warn(message) },
    })
    if (patched.installed !== true) {
      oauthReady = { ready: false, reason: String(patched.reason ?? ''), detail: patchReasonText(patched.reason), sdkVersion: loaded.version }
      ctx.logger.warn('dsh-skills-mcp-manager: OAuth support unavailable — %s (%s)', oauthReady.detail, String(patched.detail ?? ''))
      return
    }
    // Verify with a real instance: every step above can "succeed" while the final header is
    // still missing, and a button that can never work is worse than no button.
    const verified = await patched.verify()
    if (verified.ok !== true) {
      oauthReady = { ready: false, reason: String(verified.reason ?? ''), detail: patchReasonText(verified.reason), sdkVersion: loaded.version }
      ctx.logger.warn('dsh-skills-mcp-manager: OAuth support unavailable — %s (%s)', oauthReady.detail, String(verified.detail ?? ''))
      return
    }
    ctx.effect(() => () => { try { patched.uninstall?.() } catch { /* best effort */ } }, 'dsh-skills-mcp-manager.oauth.patch')
    oauthFlow = createOAuthFlow({
      store: oauthStore,
      getSdk: () => (oauthSdk?.ok === true ? oauthSdk : { ok: false, reason: String(oauthSdk?.reason ?? ''), detail: String(oauthSdk?.detail ?? '') }),
      makeProvider: makeOAuthProvider,
      /**
       * Whether this server may use a **plaintext** token endpoint.
       *
       * Read from the row on every call, never cached: the user can toggle the checkbox and
       * retry without restarting, and a cached `true` would keep the exception alive after it
       * was switched off — the one direction that must never lag.
       *
       * A missing row or a missing field answers `false`: the default has to be "refuse".
       */
      allowInsecure: (serverName) => {
        const row = candidateServers().find((entry) => entry.serverName === serverName)
        return row?.allowInsecureTokenEndpoint === true
      },
      /**
       * 当前的回调地址。
       *
       * 桌面版把端口写死成 `--port 0`（`dsh-desktop-host` 的启动参数里），所以每次启动
       * 端口都不同；而动态注册的 `client_id` 与注册时的 `redirect_uri` 绑定。把「此刻
       * 的地址」交给 flow，它就能在启动授权前发现旧绑定并重新注册 —— 用户不必因为重启
       * 一次 DSH 就去清一遍凭据。
       */
      currentRedirectUri: () => oauthRedirectUri(),
      log: { warn: (message) => ctx.logger.warn(message) },
    })
    oauthReady = { ready: true, reason: '', detail: '', sdkVersion: loaded.version }
    ctx.logger.info('dsh-skills-mcp-manager: OAuth support installed (MCP SDK %s)', loaded.version)
  }

  const oauthBootstrapped = bootstrapOAuth().catch((error) => {
    // Never let an optional capability reject out of apply().
    oauthReady = { ready: false, reason: 'bootstrap-failed', detail: String(error?.message ?? error), sdkVersion: '' }
    ctx.logger.warn('dsh-skills-mcp-manager: OAuth bootstrap failed — %s', oauthReady.detail)
  })

  /*
   * Why starting this asynchronously is safe even though the patch must land before a
   * transport is constructed.
   *
   * The window is real: `apply()` is synchronous and returns before the SDK `import()`
   * resolves, so an MCP row that activates in that window would build its transport
   * unpatched. It is *self-healing* for the only case that matters, though:
   *
   *   · a server that needs authorization answers 401, so its FIRST attempt fails;
   *   · `dsh-mcp-client` then retries with backoff, and every retry constructs a **fresh**
   *     `Client` and a **fresh** transport (`connectGeneration` → `createTransport`), whose
   *     `start()` our patch now covers;
   *   · the SDK import takes single-digit milliseconds, while the first retry is ≥ 500 ms.
   *   · a server that does NOT need authorization never consults `_authProvider`, so a
   *     missed first injection costs nothing.
   *
   * Making `apply()` async to remove the window was considered and rejected: Cordis treats a
   * plugin whose `apply` never settles as a hung load, and a hung load takes the whole profile
   * down — a far worse failure than one extra retry.
   */

  /** OAuth commands over HTTP (see `src/mcp/oauth/route.js` for why not the settings queue). */
  const runOAuthCommand = async (op) => {
    await oauthBootstrapped
    const action = String(op?.action ?? '')
    const serverName = String(op?.serverName ?? '')
    const server = candidateServers().find((entry) => entry.serverName === serverName)
    if (server === undefined) return { ok: false, reason: `找不到服务器 ${serverName}`, text: '' }
    if (oauthReady.ready !== true) return { ok: false, reason: oauthReady.detail, text: oauthReady.detail }
    if (action === 'status') {
      const status = await oauthFlow.status(serverName, String(server.url ?? ''))
      return { ok: true, reason: '', text: '', ...status }
    }
    if (action === 'authorize') {
      const result = await oauthFlow.begin(serverName, String(server.url ?? ''))
      /**
       * 拿到授权链接就**直接拉起系统浏览器**。
       *
       * 这是用户点「授权」时的全部期望：点一下，浏览器开了，登录完回来就好。让用户先
       * 复制一段 URL 再自己粘到地址栏，是把这个流程里唯一需要机器做的事留给人工。
       *
       * 打开失败**不让授权失败**：链接依然是有效的，会照常返回给面板显示（用户还能手动
       * 复制）。但失败原因必须回传，否则「点了没反应」就无从排查 —— 这个仓库已经在
       * 「装上了但没生效」上踩过两次。
       */
      let opened = null
      if (result.kind === 'redirect' && typeof result.authorizeUrl === 'string' && result.authorizeUrl !== '') {
        opened = openExternalUrl({ url: result.authorizeUrl, log: { warn: (message) => ctx.logger.warn(message) } })
      }
      oauthResultCache.set(serverName, { ...result, opened, at: new Date().toISOString() })
      kickProjection()
      const finished = result.kind === 'redirect' || result.kind === 'authorized'
      return {
        ok: finished,
        reason: finished ? '' : String(result.detail || result.reason || ''),
        text: String(result.text ?? ''),
        opened,
        ...result,
      }
    }
    if (action === 'logout') {
      const result = await oauthFlow.logout(serverName)
      oauthResultCache.set(serverName, { ok: true, kind: 'logout', reason: '', text: result.text, detail: '', at: new Date().toISOString() })
      kickProjection()
      return { ok: true, reason: '', ...result }
    }
    return { ok: false, reason: `未知的 OAuth 操作：${action}`, text: '' }
  }

  /**
   * The auth probe runs on a much slower cadence than the connection probe.
   *
   * It makes a real HTTP round trip that can take seconds, and an authorization requirement
   * is not something that appears and disappears between ticks — while a connection state
   * genuinely flips quickly. So the cheap probe keeps its 12s TTL and this one takes minutes.
   */
  const AUTH_PROBE_TTL_MS = 120000

  /**
   * When each server was first seen not-connected, in epoch ms.
   *
   * The client keeps its own attempt counter in a closure, so elapsed time against
   * the configured budget is the only way to tell "still retrying" from "gave up".
   */
  const downSince = new Map()
  /** Last probe result per server: `{ at, state, detail }`. */
  const probeCache = new Map()
  /** Servers with a probe in flight, so a slow server cannot pile up requests. */
  const probing = new Set()
  const PROBE_TTL_MS = 12000

  /**
   * Ask a server for its state, at most once per TTL.
   *
   * Fire-and-forget on purpose: `publish` is synchronous and must not await a remote
   * round-trip. The tag renders from the last known answer, which is at most one TTL
   * stale — a few seconds on a status label nobody needs to the millisecond.
   *
   * The `agent` matters: a project server's provider is registered in that agent's
   * scope, and the service resolves it from the caller's scope. Probing without it
   * would report a mounted project server as absent.
   */
  const refreshProbe = (serverName, agent) => {
    if (!probe.available()) return
    const cached = probeCache.get(serverName)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return
    if (probing.has(serverName)) return
    probing.add(serverName)
    Promise.resolve(probe.probe(serverName, { agent }))
      .then((result) => {
        probeCache.set(serverName, { at: Date.now(), state: result.state, detail: result.detail })
      })
      .catch((error) => {
        probeCache.set(serverName, { at: Date.now(), state: PROBE_STATE.unknown, detail: String(error?.message ?? error) })
      })
      .finally(() => probing.delete(serverName))
  }

  /**
   * Connected / not, from the last probe.
   *
   * `absent` counts as "not connected" **and** "no instance": the service answered that
   * there is no provider for this server, which is a fact about the mount, not about the
   * network. Everything still comes from the service, so nothing is inferred from the
   * mere absence of a tap firing.
   */
  const probeStateOf = (serverName) => {
    if (!probe.available()) return { connected: null, hasInstance: false, known: false }
    const cached = probeCache.get(serverName)
    if (cached === undefined) return { connected: null, hasInstance: false, known: false }
    if (cached.state === PROBE_STATE.connected) return { connected: true, hasInstance: true, known: true }
    if (cached.state === PROBE_STATE.down) return { connected: false, hasInstance: true, known: true }
    if (cached.state === PROBE_STATE.absent) return { connected: false, hasInstance: false, known: true }
    return { connected: null, hasInstance: false, known: false }
  }

  /**
   * Ask a server whether it is demanding authorization, at most once per TTL.
   *
   * Fire-and-forget like {@link refreshProbe}: `publish` is synchronous and must never
   * await a remote round trip. The verdict lands in `authCache` for a later tick.
   *
   * @param serverName - the MCP server name.
   * @param server - `{ transport, url, headers }` read from the row/entry that owns it.
   */
  const refreshAuth = (serverName, server) => {
    const cached = authCache.get(serverName)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < AUTH_PROBE_TTL_MS) return
    if (authProbing.has(serverName)) return
    authProbing.add(serverName)
    Promise.resolve(authProbe.probe({ serverName, ...server }))
      .then((challenge) => {
        authCache.set(serverName, { at: Date.now(), challenge: challenge ?? null })
      })
      .catch(() => {
        // `probe` already never rejects; a defensive branch keeps a future refactor from
        // turning a detector bug into an unhandled rejection in the Host.
        authCache.set(serverName, { at: Date.now(), challenge: null })
      })
      .finally(() => authProbing.delete(serverName))
  }

  /**
   * The last auth challenge for a server, or null.
   *
   * Deliberately not consulted while connected: a challenge is a cached observation, and a
   * live connection is the present fact. Letting a stale 401 outrank a working connection
   * would relabel a healthy server as needing authorization.
   */
  const authChallengeOf = (serverName) => authCache.get(serverName)?.challenge ?? null

  /**
   * Refresh one server's on-disk authorization state, at most once per TTL.
   *
   * Fire-and-forget for the same reason as {@link refreshProbe}: `publish` is synchronous
   * and must never await a disk read. Credentials change only when the user authorizes or
   * logs out, so a slow cadence is honest rather than lazy.
   *
   * Deliberately silent about tokens: the cache holds only the four facts the panel needs.
   */
  const OAUTH_STATUS_TTL_MS = 15000
  /**
   * 到期前多久开始主动刷新。
   *
   * 5 分钟是「足够久，不会因为一次失败就断档」与「足够近，刷新出来的令牌还有意义」之间
   * 的折中：短于它，一次网络抖动就可能让令牌过期；长于它，等于不停地换新令牌，把
   * refresh_token 的轮换次数（有些服务器每次刷新都会作废旧 refresh_token）翻倍。
   */
  const OAUTH_REFRESH_BEFORE_MS = 5 * 60 * 1000
  /** 检查间隔。比「提前量」小一个数量级，才可能在窗口内动手。 */
  const OAUTH_REFRESH_SWEEP_MS = 60 * 1000
  /** 正在刷新的服务器，避免同一台被连点几次刷出多个并发刷新。 */
  const oauthRefreshing = new Set()

  /**
   * 丢掉一台服务器**所有**的可观测缓存。
   *
   * 这些缓存各有各的 TTL（鉴权挑战 2 分钟、连接探测 12 秒、凭据状态 15 秒），存在的理由
   * 都是「别让 publish 去等一个远程往返」。但授权完成那一刻，它们的**每一条结论都过期了**：
   *
   *   · `authCache` 里还留着授权前那次 401 —— 不丢，卡片会继续显示「需要授权」两分钟；
   *   · `oauthStatusCache` 里还写着「没有凭据」—— 不丢，`hasCredentials` 就是 false，
   *     上面那条抑制也就不会生效；
   *   · `probeCache` 里还写着「连接断开」—— 不丢，重新挂载之后的第一次 publish 会拿旧
   *     结论去贴标签。
   *
   * 真机上表现就是「授权完了，状态还是需要授权」，而等到的往往只是下一个 TTL，不是
   * 任何真实的进展。授权是**明确的状态跃迁**，这类时刻必须主动失效，而不是等缓存过期。
   */
  const invalidateServerCaches = (serverName) => {
    authCache.delete(serverName)
    probeCache.delete(serverName)
    oauthStatusCache.delete(serverName)
    downSince.delete(serverName)
  }
  const refreshOAuthStatus = (serverName, url) => {
    if (oauthFlow === null) return
    const cached = oauthStatusCache.get(serverName)
    const now = Date.now()
    if (cached !== undefined && now - Date.parse(String(cached.readAt ?? '')) < OAUTH_STATUS_TTL_MS) return
    if (oauthStatusPending.has(serverName)) return
    oauthStatusPending.add(serverName)
    Promise.resolve(oauthFlow.status(serverName, url))
      .then((status) => {
        // `at` = when the credentials themselves last changed (stable between reads), `readAt`
        // = when we looked. Only `readAt` drives the TTL; `at` is what gets published.
        oauthStatusCache.set(serverName, { ...status, readAt: new Date().toISOString(), at: String(status.updatedAt ?? '') })
      })
      .catch((error) => {
        // A failed read must not look like "no credentials": keep the previous answer and
        // let it age. The alternative is a card that flips to 「需要授权」 because a read failed.
        ctx.logger.warn('dsh-skills-mcp-manager: cannot read OAuth state for %s: %s', serverName, String(error?.message ?? error))
      })
      .finally(() => oauthStatusPending.delete(serverName))
  }

  /**
   * 在令牌到期前主动刷新。
   *
   * 为什么不能只靠 401 触发：那要等到**下一次请求已经失败**才动手。对 MCP 来说，一次
   * 失败不是一个请求的失败 —— 客户端会退避重试，最终把整个服务器标成「已放弃」并把
   * 工具全部下掉，用户这时才看到问题，而且看到的是一台「坏了的服务器」。
   *
   * 所以：在窗口内先换新令牌，下一次连接自然就是有效的。
   *
   * 只处理「有 refresh_token 且知道到期时间」的服务器 —— 不知道到期时间的令牌无法预判，
   * 那类仍然只能等 401。
   */
  const sweepOAuthRefresh = () => {
    if (oauthFlow === null) return
    const now = Date.now()
    for (const { serverName, transport, url } of candidateServers()) {
      if (transport !== 'streamable-http' || url === '') continue
      if (oauthRefreshing.has(serverName)) continue
      const cached = oauthStatusCache.get(serverName)
      if (cached === undefined || cached.present !== true || cached.refreshable !== true) continue
      const expiresAt = Date.parse(String(cached.expiresAt ?? ''))
      // 没有到期时间 / 解析不了：不猜。猜错的代价是拿一个还有效的令牌去换新的，
      // 而有些服务器会因此作废旧的那份。
      if (!Number.isFinite(expiresAt)) continue
      if (expiresAt - now > OAUTH_REFRESH_BEFORE_MS || expiresAt - now <= 0) continue
      oauthRefreshing.add(serverName)
      Promise.resolve(oauthFlow.refresh(serverName, url))
        .then((result) => {
          if (result.ok === true) {
            ctx.logger.info('dsh-skills-mcp-manager: %s 的令牌已在到期前刷新', serverName)
            // 让卡片立刻看到新的到期时间，而不是等下一个 15 秒的 TTL。
            oauthStatusCache.delete(serverName)
            kickProjection()
            return
          }
          ctx.logger.warn('dsh-skills-mcp-manager: %s 的令牌预刷新失败（%s）：%s', serverName, result.reason, result.detail)
        })
        .catch((error) => {
          ctx.logger.warn('dsh-skills-mcp-manager: %s 的令牌预刷新异常：%s', serverName, String(error?.message ?? error))
        })
        .finally(() => oauthRefreshing.delete(serverName))
    }
  }

  /**
   * Mount fibers, per server name — the project tier's equivalent of a Loader row's
   * `phase`.
   *
   * Project servers are mounted by this plugin rather than by the Loader, so there is
   * no entry to read a phase from; keeping the fiber is what lets the status tell
   * "still activating" from "activation failed" instead of guessing. Disposal is
   * pruned lazily (a disposed fiber has no phase) because the three unmount paths
   * have different shapes and none of them should have to remember this bookkeeping.
   */
  const mountFibers = new Map()
  const recordMount = (serverName, fiber) => {
    if (typeof serverName !== 'string' || serverName === '') return
    if (fiber === null || typeof fiber !== 'object') return
    const set = mountFibers.get(serverName) ?? new Set()
    set.add(fiber)
    mountFibers.set(serverName, set)
  }

  /** Phase for a project server: active wins, then failed, then still-loading. */
  const mountedPhaseOf = (serverName) => {
    const set = mountFibers.get(serverName)
    if (set === undefined) return ''
    const phases = [...set].map(fiberPhaseOf).filter((phase) => phase !== '')
    if (phases.length === 0) return ''
    if (phases.includes('active')) return 'active'
    if (phases.includes('failed')) return 'failed'
    if (phases.includes('loading') || phases.includes('pending')) return 'loading'
    return phases[0]
  }

  /**
   * One status row per configured server, both tiers.
   *
   * Called on the publish tick. It never awaits anything: probes are kicked off and
   * their answers are consumed on a later tick, so a hung MCP server can slow a
   * label by seconds but can never stall the projection.
   *
   * `connected` merges two sources of different reach. The tool registry is the
   * cheap positive signal, but it is an **unscoped** view and project servers mount
   * into agent scopes, so their tools are invisible there — using it for both tiers
   * would report every project server as down. Hence: registry for global rows,
   * probe for everything.
   */
  const computeServerStatus = ({ rows, entries, toolCounts }) => {
    const now = Date.now()
    // A project server is only mounted for an agent whose cwd falls in its scope, so
    // "not mounted" is the normal state when no such session is open — not a fault.
    // The agent is kept because that is the scope its provider registered in, and the
    // probe has to run in the same scope to find it.
    const expected = new Map()
    for (const [agent, entry] of agents) {
      if (typeof entry.cwd !== 'string' || entry.cwd === '') continue
      for (const server of projectServersFor(committedServers, entry.cwd)) {
        if (server.enabled !== false && typeof server.serverName === 'string' && !expected.has(server.serverName)) {
          expected.set(server.serverName, agent)
        }
      }
    }
    // Both tiers are rows now, and `readServers()` returns the whole list — so `rows` and
    // `entries` are the *same* list, and a row's own `scope` is what says which tier it
    // belongs to (see src/mcp/serverRows.js).
    //
    // Assuming `rows` = global and `entries` = project therefore published every server
    // twice: once as `tier: 'global'` and once as `tier: 'project'`. The panel matches a
    // card's status on tier **and** scope, so a project row could pick up the bogus global
    // entry — a status line about a connection that does not exist. `GLOBAL_SCOPE` is
    // where the truth lives, so the split is derived from `scope`, never assumed.
    // `serverRows` normalises an absent scope to `GLOBAL_SCOPE`, so a plain comparison is
    // enough here — no need to re-derive the default.
    const byScope = (list) => list.filter((row) => String(row.scope) === GLOBAL_SCOPE)
    const byProject = (list) => list.filter((row) => String(row.scope) !== GLOBAL_SCOPE)
    const targets = [
      ...byScope(rows).map((row) => ({
        tier: 'global', scope: '', serverName: String(row.serverName ?? ''),
        enabled: row.enabled !== false, expected: true, source: row,
        // The Loader's own verdict, which is what makes "activation failed" a fact
        // rather than an inference. See deriveStatus.
        phase: String(row.phase ?? ''),
        // The auth probe needs the connection parameters, which only the row carries.
        probeTarget: { transport: row.transport, url: row.target, headers: row.headersText },
      })),
      ...byProject(entries).map((entry) => ({
        tier: 'project', scope: String(entry.scope ?? ''), serverName: String(entry.serverName ?? ''),
        enabled: entry.enabled !== false,
        expected: expected.has(entry.serverName),
        agent: expected.get(entry.serverName),
        source: entry,
        phase: mountedPhaseOf(String(entry.serverName ?? '')),
        probeTarget: { transport: entry.transport, url: entry.url, headers: entry.headers },
      })),
    ]
    const reported = []
    const seen = new Set()
    for (const target of targets) {
      if (target.serverName === '') continue
      const key = `${target.tier}\u0000${target.scope}\u0000${target.serverName}`
      if (seen.has(key)) continue
      seen.add(key)
      const probed = probeStateOf(target.serverName)
      const hasInstance = probed.hasInstance
      const toolCount = toolCounts.get(target.serverName) ?? 0
      /**
       * Tools in the registry are proof of a live connection, for **both** tiers.
       *
       * This used to trust `toolCount` only for a global row, because an *unscoped* registry
       * read cannot see a project server's tools — so for a project row the count was
       * structurally 0 and the probe was treated as the only source. `readRuntime` now reads
       * project tools **in the agent's own scope**, so the count is real, and it is a stronger
       * signal than the probe: tools present means the server is talking to us, which is
       * exactly what "connected" claims.
       *
       * Issue #3 is the other side of the same coin: a project server that works fine showed
       * 「已放弃重试」 with `toolCount: 0`, because the status path kept asking a source that is
       * *designed* not to contain project rows.
       */
      const connected = toolCount > 0 ? true : probed.connected
      // On-disk authorization state is refreshed for every http server, connected or not:
      // the card has to show 「已授权」 vs 「需要授权」 regardless of the connection state, and
      // a token silently expiring is exactly the case where the label must change first.
      //
      // Read through `probeTarget` rather than the row: a global row's `target` is the
      // command line for stdio rows, so `transport` is the only reliable discriminator.
      if (String(target.probeTarget?.transport ?? '') === 'streamable-http') {
        const oauthUrl = String(target.probeTarget?.url ?? '')
        if (oauthUrl !== '') refreshOAuthStatus(target.serverName, oauthUrl)
      }
      if (connected !== true) {
        refreshProbe(target.serverName, target.agent)
        // Only asked while not connected. An authorization requirement is a *reason a
        // connection is being refused*, so it is meaningless — and, given the cache, stale —
        // once the server is actually talking to us.
        refreshAuth(target.serverName, target.probeTarget ?? {})
      }
      if (connected === true) {
        downSince.delete(target.serverName)
      } else if (!downSince.has(target.serverName)) {
        downSince.set(target.serverName, now)
      }
      const elapsedMs = connected === true ? 0 : Math.max(0, now - (downSince.get(target.serverName) ?? now))
      const budgetMs = reconnectBudgetMs(target.source)
      const authChallenge = connected === true ? null : authChallengeOf(target.serverName)
      const status = deriveStatus({
        enabled: target.enabled,
        expected: target.expected,
        observed: probe.available(),
        phase: target.phase,
        hasInstance,
        connected,
        elapsedMs,
        budgetMs,
        authChallenge,
        /**
         * 有凭据时，401 不再是「需要授权」：那是服务器不认这份令牌（或者端点根本不看
         * 这个头），点一百次授权也不会好。让它落到「未连接/重试中/已放弃」，用户才会去
         * 查服务器侧；而重新授权的入口一直在 `…` 菜单里，并没有因此消失。
         */
        hasCredentials: oauthStatusCache.get(target.serverName)?.present === true,
      })
      const cached = probeCache.get(target.serverName)
      reported.push({
        serverName: target.serverName,
        tier: target.tier,
        scope: target.scope,
        status,
        toolCount,
        elapsedMs,
        budgetMs,
        remainingSeconds: status === SERVER_STATUS.retrying ? remainingSeconds(elapsedMs, budgetMs) : 0,
        // A connected server has nothing to explain; an auth challenge explains itself in
        // words the protocol probe cannot produce ("不是故障" is the whole point).
        detail: status === SERVER_STATUS.connected
          ? ''
          : status === SERVER_STATUS.needsAuth
            ? authDetailText(authChallenge.kind, authChallenge)
            : String(cached?.detail ?? ''),
      })
    }
    return reported
  }


  let committedServers = []
  let committedServersKey = null
  /** Live agents, with the project servers mounted into each one's scope. */
  const agents = new Map()

  /** Mount one server into `host`, appending its disposer to `sink`. */
  const mountInto = (host, server, sink, where) => {
    const mountConfig = serverMountConfig(server)
    if (mountConfig === null) {
      ctx.logger.warn('dsh-skills-mcp-manager: server %s has no name/%s, skipped', server.id, server.transport === 'stdio' ? 'command' : 'url')
      return false
    }
    try {
      const fiber = host.plugin(mcpPlugin, mountConfig)
      recordMount(server.serverName, fiber)
      sink.push(typeof fiber === 'function' ? fiber : () => fiber?.dispose?.())
      ctx.logger.info('dsh-skills-mcp-manager: mounted mcp server %s (%s) in %s', server.serverName, mountConfig.transport, where)
      return true
    } catch (error) {
      ctx.logger.error('dsh-skills-mcp-manager: cannot mount mcp server %s in %s', server.serverName, where)
      ctx.logger.error(error)
      return false
    }
  }

  const unmount = (sink) => {
    for (const stop of sink.reverse()) {
      try {
        stop()
      } catch (error) {
        ctx.logger.warn('dsh-skills-mcp-manager: unmount failed')
        ctx.logger.warn(error)
      }
    }
    sink.length = 0
  }

  /**
   * Project tier: one agent's scope, re-derived whenever that agent or the config changes.
   *
   * There is no `mountGlobal` any more. Global rows are ordinary `mcp-client` rows, so the
   * Loader connects them itself; mounting them here as well would connect every server
   * twice — two clients, two tool generations, one namespace. What remains is the part only
   * this plugin can do: deciding which *project* rows belong to which agent, which no row
   * can express (a row is loaded once, and `!!js` sees no working directory).
   *
   * Mounts are tracked **per server**, not as one all-or-nothing list: editing context7's
   * URL used to unmount and reconnect every other project server in the same workspace,
   * because the only state was one key for the whole set. Keeping the unchanged server's
   * disposer means an edit touches exactly the edited server.
   */
  const mountForAgent = (agent, entry) => {
    const desired = projectServersFor(committedServers, entry.cwd)
    const desiredKeys = new Set()
    for (const server of desired) {
      const key = serverSetKey([server])
      desiredKeys.add(key)
      if (entry.mounted.has(key)) continue
      // Same server, new config: drop its previous instance first so it reconnects with
      // the new URL/headers instead of running both.
      for (const [oldKey, old] of [...entry.mounted]) {
        if (old.serverName === server.serverName) {
          unmount(old.stops)
          entry.mounted.delete(oldKey)
        }
      }
      const stops = []
      mountInto(agent.ctx, server, stops, `agent scope ${entry.cwd}`)
      entry.mounted.set(key, { serverName: server.serverName, stops })
    }
    for (const [key, mounted] of [...entry.mounted]) {
      if (desiredKeys.has(key)) continue
      unmount(mounted.stops)
      entry.mounted.delete(key)
    }
  }

  /** Every disposer one agent currently owns (heartbeat + cleanup). */
  const stopsOf = (entry) => [...entry.mounted.values()].flatMap((mounted) => mounted.stops)

  const attachAgent = (agent) => {
    if (agent === undefined || agent === null || agents.has(agent)) return
    const entry = { cwd: workingDirectoryOf(agent), mounted: new Map() }
    agents.set(agent, entry)
    mountForAgent(agent, entry)
  }

  const detachAgent = (agent) => {
    const entry = agents.get(agent)
    if (entry === undefined) return
    for (const mounted of entry.mounted.values()) unmount(mounted.stops)
    agents.delete(agent)
  }

  ctx.on('agent/created', ({ agent }) => attachAgent(agent))
  ctx.on('agent/disposed', ({ agent }) => detachAgent(agent))

  /**
   * Pick up agents that were already live before this plugin loaded.
   *
   * Subscribing to `agent/created` alone is not enough, and the gap is invisible: an event
   * only reaches a listener that was already registered, so a session that existed when this
   * plugin (re)loaded never fires one *here*. Its `agents` entry then never appears, which
   * means `mountForAgent` is never called for it — and a project server the user *did*
   * configure correctly is simply never mounted. The panel reports `unmounted`, which is
   * literally true and reads as "your config is wrong" while the config is fine.
   *
   * `ctx.agents.list()` is the registry itself, so this closes the gap regardless of how the
   * plugin's context relates to the one that created the agent. Called on every tick, it is
   * idempotent: `attachAgent` returns early for an agent it already tracks.
   */
  const adoptLiveAgents = () => {
    let registry = null
    try {
      registry = ctx.get?.('agents') ?? null
    } catch {
      // A bare service access throws in cordis before the service is injected.
      registry = null
    }
    if (registry === null || typeof registry.list !== 'function') return
    let live = []
    try {
      live = registry.list() ?? []
    } catch (error) {
      ctx.logger.warn('dsh-skills-mcp-manager: cannot list live agents: %s', String(error?.message ?? error))
      return
    }
    for (const agent of live) attachAgent(agent)
  }

  /** Written on every transition; the heartbeat file surfaces it for debugging. */
  let lastBeat = { at: '', observed: { servers: [] }, changed: {}, mounted: 0, agents: [] }
  /** Latest disk-skill scan, refreshed on a timer (the scan itself is async). */
  let discoveredSkills = []
  /** Last skill/import op, surfaced on the heartbeat for outside diagnosis. */
  let lastOp = null
  let discoveryInfo = { at: '', roots: [], count: 0, error: '' }
  const refreshDiscovered = async (projectRoots) => {
    const roots = Array.isArray(projectRoots) ? projectRoots.slice(0, 12) : []
    try {
      discoveredSkills = await discoverSkills({
        projectRoots: roots,
        dshHome: resolveDshHome(),
        agentsHome: agentsHome(),
      })
      discoveryInfo = { at: new Date().toISOString(), roots, count: discoveredSkills.length, error: '' }
      // The periodic heartbeat only fires on change, and the first one happens
      // before this async scan finishes — so publish the diagnostics explicitly.
      beat({ ...lastBeat, at: new Date().toISOString(), discovery: discoveryInfo })
    } catch (error) {
      // A failed scan must not look like "there are no skills on disk", and the
      // reason must survive into the published diagnostics.
      discoveryInfo = { at: new Date().toISOString(), roots, count: 0, error: String(error?.message ?? error) }
      beat({ ...lastBeat, at: new Date().toISOString(), discovery: discoveryInfo })
      if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] skill scan failed', error)
      discoveredSkills = []
    }
  }

  /**
   * The agent a project server is mounted into, per server name.
   *
   * A project row's tools are registered in the *agent's* scope, so reading them needs that
   * exact agent[object] as the scope key — the same object `createScope` was minted with.
   * The first matching live agent wins, mirroring `computeServerStatus`'s `expected` map so
   * the tool list and the status label always describe the same agent.
   */
  const agentForServer = () => {
    const found = new Map()
    for (const [agent, entry] of agents) {
      if (typeof entry.cwd !== 'string' || entry.cwd === '') continue
      for (const server of projectServersFor(committedServers, entry.cwd)) {
        if (server.enabled !== false && typeof server.serverName === 'string' && !found.has(server.serverName)) {
          found.set(server.serverName, agent)
        }
      }
    }
    return found
  }

  /**
   * The panel's complete read model. Recomputed per request — nothing here is persisted.
   *
   * Three kinds of data, from three different sources, deliberately in one answer because
   * the browser has no other channel to reach the Host:
   *   · config rows  → the profile patch file (direct read, mtime cache; Loader adds `phase`)
   *   · tools/status → the live tool registry + probe caches (observational, TTL'd)
   *   · skills       → the periodic disk scan
   */
  const readRuntime = () => {
    const { rows } = configuredMcpRows(ctx)
    const plain = JSON.parse(JSON.stringify(rows))
    const names = plain.map((row) => row.serverName)
    // Global rows are instantiated by the Loader at the root, so the unscoped view is
    // exactly where their tools are. Everything else lives in an agent's scope and is
    // invisible to an unscoped read — which is why every project server used to report zero
    // tools while the card still said it was configured.
    const globalNames = plain.filter((row) => String(row.scope) === GLOBAL_SCOPE).map((row) => row.serverName)
    const projectNames = plain.filter((row) => String(row.scope) !== GLOBAL_SCOPE).map((row) => row.serverName)

    const byName = new Map()
    const globalInventory = toolsByServer(ctx, globalNames)
    if (globalInventory.ok) for (const entry of globalInventory.servers) byName.set(entry.serverName, entry)

    const scopes = agentForServer()
    for (const name of projectNames) {
      const agent = scopes.get(name)
      // No live agent for this scope means the server is genuinely not mounted right now
      // (`computeServerStatus` reports the same situation as `unmounted`). Leaving it out of
      // `byName` is the honest answer: an empty list, not a fabricated one.
      if (agent === undefined) continue
      const scoped = toolsByServer(ctx, [name], agent)
      if (!scoped.ok) continue
      for (const entry of scoped.servers) byName.set(entry.serverName, entry)
    }

    // A failed registry read is reported as a whole, exactly as before: "the registry is
    // unreadable" is a different fact from "this server exposes nothing".
    const inventory = globalInventory.ok
      ? { ok: true, servers: names.map((serverName) => byName.get(serverName) ?? { serverName, tools: [] }) }
      : globalInventory
    const serverTools = inventory.ok ? inventory.servers : []
    const serverToolsError = inventory.ok
      ? { reason: '', detail: '' }
      : { reason: String(inventory.reason ?? ''), detail: String(inventory.detail ?? '') }
    const toolCounts = new Map(serverTools.map((entry) => [entry.serverName, entry.tools.length]))
    const serverStatus = computeServerStatus({ rows: plain, entries: configuredServers(ctx), toolCounts })

    // The filter may only judge servers the panel can see; refresh the cached name set here
    // so a freshly added row is covered on the next registration.
    refreshFilterServers(readServers())
    const filter = {
      installed: filterState.installed,
      reason: filterState.reason,
      dropped: [...filterState.dropped],
      preExisting: [...filterState.preExisting],
    }
    // The probe's own health travels with the answer: "no server is down" and "we cannot
    // tell" must never render the same.
    const probeState = {
      installed: probe.available(),
      reason: probe.reason(),
      results: [...probeCache.entries()].map(([serverName, cached]) => ({
        serverName,
        state: String(cached?.state ?? ''),
        detail: String(cached?.detail ?? ''),
      })),
    }

    const spaces = configuredWorkspaces(ctx).map((workspace) => ({
      ...workspace,
      agentsSkillsDir: workspace.path === '' ? '' : join(workspace.path, '.agents', 'skills'),
    }))
    const cwds = [...agents.values()].map((entry) => entry.cwd).filter((cwd) => typeof cwd === 'string' && cwd !== '')
    const skillDirs = {
      userDsh: join(resolveDshHome(), 'skills'),
      userAgents: join(agentsHome(), 'skills'),
    }

    // Per-server authorization state. Deliberately carries **no token material**: the panel
    // only needs "is there one, does it expire, do I need to click".
    const oauthServers = {}
    for (const server of plain) {
      if (String(server.transport ?? '') !== 'streamable-http') continue
      const serverName = String(server.serverName ?? '')
      if (serverName === '') continue
      const cached = oauthStatusCache.get(serverName)
      oauthServers[serverName] = cached === undefined
        ? { present: false, refreshable: false, waiting: false, authorizeUrl: '', expiresAt: '', expired: false, at: '' }
        : {
            present: cached.present === true,
            refreshable: cached.refreshable === true,
            waiting: cached.waiting === true,
            authorizeUrl: String(cached.authorizeUrl ?? ''),
            expiresAt: String(cached.expiresAt ?? ''),
            expired: cached.expired === true,
            at: String(cached.updatedAt ?? ''),
          }
    }

    return {
      serverTools,
      serverToolsError,
      serverStatus,
      servers: plain,
      skills: discoveredSkills,
      skillDirs,
      workspaces: spaces,
      currentWorkspace: cwds[0] ?? '',
      filter,
      probe: probeState,
      oauth: {
        ready: oauthReady.ready === true,
        reason: String(oauthReady.reason ?? ''),
        detail: String(oauthReady.detail ?? ''),
        sdkVersion: String(oauthReady.sdkVersion ?? ''),
        redirectUri: oauthRedirectUri(),
        callbackReady: oauthCallbackReady,
        callbackPath: oauthCallbackPath,
        servers: oauthServers,
      },
      discovery: discoveryInfo,
    }
  }
  // Optional injection keeps non-web profiles usable; never fall back to writing tools.
  ctx.inject(['webServer', 'connection'], (inner) => registerRuntimeRoute(inner, readRuntime))

  // ── One-time migration ──────────────────────────────────────────────────────────────
  //
  // Everything this panel used to keep in `config` (skills, legacy servers, projections)
  // becomes files: skills → `SKILL.md`, servers → profile rows. The write is one raw-patch
  // pass (lock → backup → atomic write, see `migratePanelConfig`), after which those keys no
  // longer exist in the profile patch. It must run before the first panel read; a failed
  // attempt retries on a slow tick, because a profile lock can be held at startup.
  ctx.effect(() => {
    let stopped = false
    let done = false
    const attempt = () => {
      if (done || stopped) return
      serverMigrationState.status = 'running'
      Promise.resolve(migratePanelConfig(ctx))
        .then((changed) => {
          done = true
          serverMigrationState.status = changed > 0 ? 'migrated' : 'nothing-to-do'
          serverMigrationState.migrated = changed
          try { tick() } catch { /* tick is declared below; the 2 s timer runs it anyway */ }
        })
        .catch((error) => {
          serverMigrationState.status = 'failed'
          serverMigrationState.reason = String(error?.message ?? error)
          ctx.logger.warn('dsh-skills-mcp-manager: migration failed: %s', serverMigrationState.reason)
        })
    }
    const timer = setTimeout(attempt, 800)
    const repeat = setInterval(attempt, 5000)
    return () => { stopped = true; clearTimeout(timer); clearInterval(repeat) }
  }, 'dsh-skills-mcp-manager.migration')

  // ── Disk skill scan (memory only; served by `/runtime`) ─────────────────────────────
  //
  // The skills tab has no config source any more: the four roots on disk are the whole
  // truth. The scan is periodic so `/runtime` is cheap, but it never writes anything.
  ctx.effect(() => {
    const scan = () => {
      const roots = []
      const add = (dir) => {
        if (typeof dir !== 'string' || dir === '') return
        const root = projectRootOf(dir)
        if (!roots.includes(root)) roots.push(root)
      }
      for (const entry of agents.values()) add(entry.cwd)
      for (const workspace of configuredWorkspaces(ctx)) {
        add(typeof workspace === 'string' ? workspace : workspace?.path)
      }
      void refreshDiscovered(roots)
    }
    scan()
    const timer = setInterval(scan, 5000)
    return () => clearInterval(timer)
  })

  /**
   * patch 文件读完 —— 刷新运行态，让 /runtime 下一次就带上新行。
   *
   * 这里没有 settings 写入，也没有投影：行列表由 `/runtime` 现算；`phase` 由 Loader 合并。
   */
  onPatchRowsRefreshed = () => {
    try { tick() } catch { /* 下一次 tick 会再试 */ }
  }

  /** One command chain for every write route: no interleaved read-modify-write on the patch. */
  let commandChain = Promise.resolve()
  const serialized = (run) => {
    const next = commandChain.then(run, run)
    commandChain = next.catch(() => {})
    return next
  }

  // ── Row commands over HTTP ──────────────────────────────────────────────────────────
  //
  // The panel owns the profile patch's mcp-client rows. There is no queue any more: a
  // command either applies and answers with the resulting row list, or fails with a reason.
  ctx.inject(['webServer', 'connection'], (routeCtx) => registerRowRoute(routeCtx, {
    schema: (payload) => RowOp(payload),
    apply: async (op) => serialized(async () => {
      // Capture the server name(s) this command may affect **before** the write: a rename
      // has two, a delete only the old one. Their probe/auth caches must be invalidated or
      // the card keeps showing the old connection for up to the 12 s probe TTL.
      const bareId = (value) => String(value ?? '').replace(/^include:/, '')
      const targetId = bareId(op?.entryId)
      const findRow = (rows) => rows.find((row) => bareId(row.entryId) === targetId)
      const before = findRow(configuredMcpRows(routeCtx).rows)
      await applyRowOp(routeCtx, op)
      // Read the file back before answering: the client applies this list directly, so it
      // must not be the Loader view from before the write.
      const file = patchFileOf(routeCtx)
      if (file !== '') await refreshPatchRows(file, { force: true })
      const { rows } = configuredMcpRows(routeCtx)
      const after = findRow(rows)
      const affected = new Set([before?.serverName, after?.serverName].filter((name) => typeof name === 'string' && name !== ''))
      for (const serverName of affected) invalidateServerCaches(serverName)
      try {
        // The file is the stable source after our own write, so commit immediately instead
        // of waiting for two 2 s Loader observations. mountForAgent keeps unchanged project
        // servers mounted, so only the edited one reconnects.
        tick({ force: true })
      } catch (error) {
        routeCtx.logger.warn('dsh-skills-mcp-manager: post-command refresh failed: %s', String(error?.message ?? error))
      }
      return { ok: true, reason: '', servers: JSON.parse(JSON.stringify(configuredMcpRows(routeCtx).rows)) }
    }),
  }))

  // ── Reconnect ───────────────────────────────────────────────────────────────────────
  //
  // Why the instance has to be recreated instead of "nudged": the retry state lives inside
  // the client's closure (`failedAttempts`, `reconnectTimer`) and there is no API to reset
  // it. Worse, `dispose()` clears the pending reconnect timer, so once a server has given up
  // only a **new plugin instance** gets a fresh budget. Global rows are rebuilt by the
  // Loader (disable → wait for it to unload → enable); project rows are remounted by us.
  //
  // This is a command, not state: it is an HTTP request that answers when it is done. It is
  // never written into the profile patch, so a restart cannot replay it.
  const RECONNECT_STEP_TIMEOUT_MS = 25000
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const remountProject = (serverName) => {
    let touched = 0
    for (const [agent, entry] of agents) {
      const desired = projectServersFor(committedServers, entry.cwd)
      const wanted = desired.some((server) => server.serverName === serverName)
      let had = false
      // Only this server's instance is dropped; the rest of the agent's project servers
      // keep their connections (see mountForAgent's per-server bookkeeping).
      for (const [key, mounted] of [...entry.mounted]) {
        if (mounted.serverName !== serverName) continue
        unmount(mounted.stops)
        entry.mounted.delete(key)
        had = true
      }
      if (!wanted && !had) continue
      mountForAgent(agent, entry)
      touched += 1
    }
    return touched
  }

  /** The Loader's own view (for "did the disable actually take effect?"). */
  const loaderRows = () => serverRows([...(loaderOf(ctx)?.entries?.() ?? [])])

  // Deliberately **not** part of the row-command chain: a global reconnect legitimately
  // waits seconds for the Loader to unload the row, and blocking unrelated row edits for
  // that long would be worse than letting the two writes interleave (applyRowOp takes the
  // same file lock either way).
  const reconnectServer = async (request) => {
    const serverName = String(request?.serverName ?? '')
    const tier = String(request?.tier ?? '')
    if (serverName === '') return { ok: false, reason: '请求里没有服务器名' }
    try {
      if (tier === 'project') {
        const touched = remountProject(serverName)
        // 「连接断开」这条探测结论在重新挂载后也过期了。
        invalidateServerCaches(serverName)
        try { tick() } catch { /* 下一次 tick 会再试 */ }
        return touched === 0
          ? { ok: false, reason: `没有会话正在使用项目级服务器 ${serverName}，无需重连` }
          : { ok: true, reason: '' }
      }
      const row = configuredMcpRows(ctx).rows.find((item) => item.serverName === serverName)
      if (row === undefined || row.entryId === '') {
        return { ok: false, reason: `profile 里找不到服务器 ${serverName} 对应的行` }
      }
      if (row.enabled === false) {
        return { ok: false, reason: `服务器 ${serverName} 处于停用状态，先在面板里启用它` }
      }
      const entryId = row.entryId
      await applyRowOp(ctx, { op: 'toggle', entryId, enabled: false })
      const deadline = Date.now() + RECONNECT_STEP_TIMEOUT_MS
      let stopped = false
      while (Date.now() < deadline) {
        const live = loaderRows().find((item) => item.entryId === entryId)
        if (live === undefined || live.enabled === false) { stopped = true; break }
        await sleep(200)
      }
      // Re-enable even on timeout: leaving the row disabled would turn a failed reconnect
      // into a worse regression than the one the user was fixing.
      await applyRowOp(ctx, { op: 'toggle', entryId, enabled: true })
      try { tick() } catch { /* 下一次 tick 会再试 */ }
      return stopped
        ? { ok: true, reason: '' }
        : { ok: false, reason: '停用后未等到 Loader 卸载该行，已重新启用，请再试一次' }
    } catch (error) {
      ctx.logger.warn('dsh-skills-mcp-manager: reconnect failed: %s', String(error?.message ?? error))
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  ctx.inject(['webServer', 'connection'], (reconnectCtx) => registerReconnectRoute(reconnectCtx, {
    schema: (payload) => ReconnectRequest(payload),
    run: reconnectServer,
  }))

  /** Token pre-refresh. Runs without a panel; it only touches the credential files. */
  ctx.effect(() => {
    const timer = setInterval(sweepOAuthRefresh, OAUTH_REFRESH_SWEEP_MS)
    return () => clearInterval(timer)
  }, 'dsh-skills-mcp-manager.oauth-sweep')

  // ── Skill writes over HTTP ──────────────────────────────────────────────────────────
  //
  // A skill is a directory on disk and nothing else. The four roots are the whole model:
  // create/update/rename/delete go straight to `SKILL.md`, and the list is the disk scan.
  const applySkillWrite = async (skillReq) => {
    const at = () => new Date().toISOString()
    const fail = (reason) => ({ ok: false, reason, name: '', body: '', nonce: String(skillReq?.nonce ?? ''), at: at() })
    const op = String(skillReq?.op ?? '')
    const roots = writableRoots({
      dshHome: resolveDshHome(),
      agentsHome: agentsHome(),
      projectRoot: skillReq?.project === '' ? '' : projectRootOf(String(skillReq.project)),
    })
    const target = roots.find((entry) => entry.scope === skillReq?.scope && entry.id === skillReq?.id)
    let result
    if (String(skillReq?.scope ?? '') === 'project' && String(skillReq?.project ?? '') === '') {
      // Never guess: an empty project used to fall back to the cwd and wrote
      // the skill into the wrong workspace.
      result = fail('未选择项目，无法写入项目级技能')
    } else if (target === undefined) {
      result = fail('未知的写入区域')
    } else {
      const payload = {
        dir: target.dir, name: String(skillReq?.name ?? ''),
        description: String(skillReq?.description ?? ''), body: String(skillReq?.body ?? ''),
      }
      // A disk op that throws (a failing copy, a permission error) must
      // still produce an answer: without a receipt the panel's card kept
      // spinning on 「删除中…」 forever.
      let done
      try {
        done = op === 'create' ? await createSkill(payload)
          : op === 'rename' ? await renameSkill({ ...payload, from: String(skillReq?.prevName ?? ''), to: String(skillReq?.name ?? '') })
            : op === 'delete' ? await deleteSkill(payload)
              : await updateSkill(payload)
      } catch (error) {
        done = { ok: false, reason: String(error?.message ?? error) }
      }
      result = { ok: done.ok === true, reason: String(done.reason ?? ''), name: String(done.name ?? ''), body: '', nonce: String(skillReq?.nonce ?? ''), at: at() }
    }
    if (result.ok === true) {
      // Re-scan so `/runtime` shows the change now. The periodic scan already covers every
      // project, but a write must refresh the roots it touched.
      try {
        const projectScopes = [...new Set(discoveredSkills
          .map((entry) => entry.scope)
          .filter((scope) => typeof scope === 'string' && scope !== '' && scope !== 'global'))]
        await refreshDiscovered([...new Set([
          ...roots.map((entry) => projectRootOf(entry.dir)),
          ...projectScopes,
        ])].filter((root) => typeof root === 'string' && root !== ''))
      } catch (error) {
        if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] post-write rescan failed', error)
      }
    }
    return result
  }

  /** Record what just happened (diagnostics); `/runtime` refreshes on its own. */
  const finishSkillOp = (op, skillReq, result) => {
    lastOp = {
      op: String(op ?? ''), name: String(skillReq?.name ?? ''),
      nonce: String(result?.nonce ?? ''), ok: result?.ok === true,
      at: new Date().toISOString(),
    }
    try { tick() } catch (error) { console.error('[dsh-skills-mcp-manager] post-skill refresh failed:', error) }
  }

  ctx.inject(['webServer', 'connection'], (skillRouteCtx) => registerSkillRoute(skillRouteCtx, {
    schema: (payload) => SkillRequest(payload),
    apply: async (request) => {
      const op = String(request?.op ?? '')
      // The route is writes-only; a read has its own GET endpoint.
      if (op === 'read') return { ok: false, reason: 'read 不走此路由', name: '', body: '', nonce: String(request?.nonce ?? ''), at: new Date().toISOString() }
      const result = await applySkillWrite(request)
      finishSkillOp(op, request, result)
      return result
    },
  }))

  /**
   * Resolve one skill body for the editor/preview.
   *
   * Only files the scanner actually found are readable — the path is a client-supplied
   * string, so it must be proved to be one of *our* skill roots before reading it. A stale
   * list (a skill created a moment ago) is handled by one rescan, never by widening the
   * check.
   */
  const resolveSkillBody = async (wanted) => {
    const path = String(wanted ?? '')
    if (path === '') return { ok: false, reason: '缺少 path' }
    const isKnown = () => Array.isArray(discoveredSkills) && discoveredSkills.some((entry) => entry.path === path)
    if (!isKnown()) {
      try {
        const extra = []
        for (const agent of agents.values()) extra.push(projectRootOf(agent.cwd))
        for (const workspace of configuredWorkspaces(ctx)) extra.push(projectRootOf(String(workspace?.path ?? workspace?.dir ?? '')))
        const scopes = discoveredSkills.map((entry) => entry.scope).filter((scope) => typeof scope === 'string' && scope !== '' && scope !== 'global')
        const nextRoots = [...new Set([...scopes, ...extra])].filter((root) => typeof root === 'string' && root !== '')
        await refreshDiscovered(nextRoots)
      } catch (error) {
        if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] read rescan failed', error)
      }
    }
    if (!isKnown()) return { ok: false, reason: '该技能不在当前扫描结果里' }
    try {
      const text = await readFile(path, 'utf8')
      return { ok: true, reason: '', name: '', body: bodyOf(text), at: new Date().toISOString() }
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  ctx.inject(['webServer', 'connection'], (readCtx) => registerSkillReadRoute(readCtx, { resolve: resolveSkillBody }))

  // ── OAuth: command route + browser callback ─────────────────────────────────────────
  //
  // Registered on the same `webServer` service the row/skill routes use. The callback is
  // the only route in this plugin that **cannot** carry `connection.requestRejection`:
  // the browser arrives from the authorization server's 302, which has no DSH session
  // cookie, so that check would 401 every callback and authorization could never finish.
  // Its security boundary is the one-time `state` instead (see `src/mcp/oauth/state.js`).
  ctx.inject(['webServer', 'connection'], (oauthRouteCtx) => {
    registerOAuthRoute(oauthRouteCtx, {
      // Only the action and the target are accepted; everything else is ours to decide.
      schema: (payload) => OAuthCommand(payload),
      run: runOAuthCommand,
    })
    const registered = registerOAuthCallback(oauthRouteCtx, {
      servers: () => candidateServers(),
      flow: {
        checkCallback: async (...args) => {
          await oauthBootstrapped
          if (oauthFlow === null) return { ok: false, reason: 'no-authorization-in-progress' }
          return oauthFlow.checkCallback(...args)
        },
        complete: async (serverName, url, code) => {
          await oauthBootstrapped
          if (oauthFlow === null) return { ok: false, reason: 'oauth-sdk-unavailable', detail: '', text: 'OAuth 支持未安装' }
          const done = await oauthFlow.complete(serverName, url, code)
          // The client's own retry loop has already given up by the time a user authorizes
          // (10 attempts with backoff). A fresh instance is the only way back.
          try { oauthStatusCache.delete(serverName) } catch { /* cache miss is harmless */ }
          return done
        },
      },
      onAuthorized: async (serverName) => {
        // 授权一完成就自己重连，不等用户回面板再点一次。重连是命令，直接走任务函数。
        ctx.logger.info('dsh-skills-mcp-manager: %s finished OAuth authorization, reconnecting', serverName)
        invalidateServerCaches(serverName)
        const target = candidateServers().find((entry) => entry.serverName === serverName)
        const tier = target !== undefined && String(target.scope ?? '') === 'global' ? 'global' : 'project'
        void reconnectServer({ tier, serverName }).catch((error) => {
          ctx.logger.warn('dsh-skills-mcp-manager: reconnect after OAuth failed: %s', String(error?.message ?? error))
        })
      },
      snapshot: () => oauthResultCache,
      log: { warn: (message) => ctx.logger.warn(message) },
    })
    oauthCallbackReady = registered.installed === true
    oauthCallbackPath = registered.installed === true ? CALLBACK_PATH : `unavailable: ${registered.reason}`
    if (registered.installed !== true) {
      ctx.logger.warn('dsh-skills-mcp-manager: OAuth callback route unavailable — %s', registered.reason)
    }
  })

  // ── MCP import: scan on request, answer with the preview ───────────────────────────
  //
  // A scan is a read of other tools' config files. It used to travel through settings
  // (request field → 600 ms poll → answer field); now it is one request/response.
  ctx.inject(['webServer', 'connection'], (importCtx) => registerImportRoute(importCtx, {
    schema: (payload) => ImportRequest(payload),
    scan: (request) => {
      const source = String(request?.source ?? '')
      const scope = request?.scope === 'global' ? 'global' : 'project'
      const project = String(request?.project ?? '')
      try {
        return { ok: true, source, scope, project, at: new Date().toISOString(), ...scanImportSource(scope, project, source) }
      } catch (error) {
        return { ok: false, source, scope, project, at: new Date().toISOString(), files: [], servers: [], error: String(error?.message ?? error) }
      }
    },
  }))

  let pendingServersKey = null
  let firstTick = true

  /**
   * Reconcile project mounts with the configured rows.
   *
   * Reads the **file-first** view, not the Loader's: after a panel write the file is already
   * current while the Loader may lag seconds behind, and waiting for it was why a saved edit
   * sat on the old connection.
   *
   * `force` is set by the row command that just wrote the patch: the config is stable and
   * known, so skip the "observe twice" debounce that exists only to survive transient
   * Loader recompositions. Unchanged servers are kept mounted by {@link mountForAgent}.
   */
  const tick = ({ force = false } = {}) => {
    // Before anything is decided: make sure every live agent is tracked. An agent that
    // predates this plugin's subscription never fires `agent/created` here, and an untracked
    // agent is an unmounted project server (see `adoptLiveAgents`).
    adoptLiveAgents()
    const servers = configuredServers(ctx)

    // Act only on a state observed twice in a row. A Loader recomposition can
    // mount this row with a transient empty config; acting on that would
    // unmount live servers that are still configured.
    //
    // The key deliberately ignores `phase`: the Loader updates it on its own schedule, and
    // a phase change is not a reason to tear down a working connection and rebuild it.
    const observedServersKey = serverSetKey(servers)
    let serversChanged = false
    if (force) {
      committedServers = servers
      committedServersKey = observedServersKey
      pendingServersKey = null
      serversChanged = true
      for (const [agent, entry] of agents) mountForAgent(agent, entry)
    } else if (observedServersKey === committedServersKey) {
      pendingServersKey = null
    } else if (observedServersKey === pendingServersKey) {
      committedServers = servers
      committedServersKey = observedServersKey
      pendingServersKey = null
      serversChanged = true
      for (const [agent, entry] of agents) mountForAgent(agent, entry)
    } else {
      pendingServersKey = observedServersKey
    }

    if (firstTick || serversChanged) {
      firstTick = false
      const mountedCount = [...agents.values()].reduce((total, entry) => total + stopsOf(entry).length, 0)
      lastBeat = {
        at: new Date().toISOString(),
        observed: { servers: servers.map((s) => s.serverName) },
        changed: { servers: serversChanged },
        // Only the project tier is mounted by this plugin now: global rows are connected by
        // the Loader, so counting them here would double-count what the Loader already owns.
        mounted: mountedCount,
        rootScope: Boolean(ctx.root && ctx.root !== ctx),
        agents: [...agents.values()].map((entry) => ({ cwd: entry.cwd, mounted: stopsOf(entry).length })),
        migration: { ...serverMigrationState },
        discovery: discoveryInfo,
        lastOp,
      }
      // The heartbeat file is a diagnostic side channel: it is not the profile patch and is
      // safe to write from the Host.
      beat(lastBeat)
    }
  }

  ctx.effect(() => {
    tick()
    const timer = setInterval(tick, 2000)
    return () => {
      clearInterval(timer)
      for (const entry of agents.values()) {
        for (const mounted of entry.mounted.values()) unmount(mounted.stops)
      }
      agents.clear()
    }
  })
}
