/**
 * Host half of the Skills & MCP panel.
 *
 * State lives in this entry's own `config` (two `.volatile()` fields), so the
 * panel page edits it through the standard settings remote and every change is
 * persisted into the active profile's patch. This half turns that state into
 * reality:
 *
 *   skills  → `<root>/<name>/SKILL.md` files (project root or the harness home)
 *   mcp     → one mounted `@deepseek-ai/dsh-mcp-client` instance per enabled
 *             global server, mounted in this plugin's own scope
 *
 * No profile-patch rewriting and no third-party dependencies: MCP rows are
 * mounted in-process through the shipped client package, so tool naming,
 * discovery, reconnection and image handling stay identical to a configured row.
 *
 * @module dsh-skills-mcp-manager
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { commandEnv, parseEnv, resolveCommand, setHomeResolver, spawnEnv, splitArgs } from './runtime/env.js'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { applyRowOp, migrateServerEntries, migratePanelConfig, setPatchIO } from './patch/apply.js'
import { IMPORT_SOURCES, adaptImportedEntry, envLines, headerLines, importFilePath, parseJsonLoose } from './import/sources.js'
import { scanImportSource } from './import/scan.js'
import { beat, beatFile } from './diagnostics/heartbeat.js'
import { agentsHome, projectRootOf, reconcileSkills } from './skills/reconcile.js'
import { bodyOf, discoverSkills } from './skills/discover.js'
import { createSkill, deleteSkill, renameSkill, updateSkill, writableRoots } from './skills/write.js'
import { registerSkillRoute } from './skills/route.js'
import { serverMountConfig, setMountClient, workingDirectoryOf } from './project/mount.js'
import { GLOBAL_SCOPE, projectServersFor, serverRows, serverSetKey } from './mcp/serverRows.js'
import { connectionDraftOf } from './mcp/connection.js'
import { toolsByServer } from './mcp/tools.js'
import { registerRuntimeRoute } from './mcp/runtime.js'
import { registerRowRoute } from './mcp/rows.js'
import { installShadow, isMcpName, judge, liveToolNames } from './mcp/filter.js'
import { PROBE_STATE, createConnectionProbe } from './mcp/probe.js'
import { authDetailText } from './mcp/auth.js'
import { createAuthProbe } from './mcp/authprobe.js'
import { SERVER_STATUS, deriveStatus, reconnectBudgetMs, remainingSeconds } from './mcp/status.js'

setMountClient(mcpClient)

setPatchIO({ withFileLock, writeFileAtomic })
import { isMap, isSeq, parseDocument } from 'yaml'

import { NAME as name } from './identity.js'
export { name }

/** The Loader is core, so requiring it costs nothing and never blocks startup. */
export const inject = ['loader']

/** One MCP server the panel manages. */
const Server = z.object({
  /** 'global' or an absolute project directory. */
  scope: z.string().default('global'),
  /** Stable identity of this entry. */
  id: z.string().required(),
  serverName: z.string().required(),
  transport: z.union(['streamable-http', 'stdio']).default('streamable-http'),
  url: z.string().default(''),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  /** Extra child environment, one `KEY=VALUE` per line (tokens live here). */
  env: z.string().default(''),
  /** `auto` = harness runtime (pnpx), `system` = the user's own npx. */
  runtime: z.string().default('auto'),
  /** Where a discovered entry came from (e.g. `.mcp.json`); empty for panel entries. */
  source: z.string().default(''),
  /** HTTP headers, one `KEY=VALUE` per line. */
  headers: z.string().default(''),
  /** Reject activation when the first connection or tool sync fails. */
  failOnStartupError: z.boolean().default(false),
  /** Reconnect numbers, kept as the panel's text inputs ('' = client default). */
  reconnectInitialDelayMs: z.string().default(''),
  reconnectMaxDelayMs: z.string().default(''),
  reconnectMaxAttempts: z.string().default(''),
  /** Per-call tool timeout for this server ('' = the client's own default). */
  toolCallTimeoutMs: z.string().default(''),
  enabled: z.boolean().default(true),
})

/** One skill the panel writes to disk. */
const Skill = z.object({
  scope: z.string().default('global'),
  /**
   * Which of the two roots under `scope` this entry belongs to: `dsh` or `agents`.
   *
   * Both roots are real and DSH's provider reads both, so the root has to travel with the
   * entry — `reconcileSkills` rewrites disk from this list, and without it an entry written
   * to `~/.agents/skills` would be moved under `~/.dsh/skills` on the next pass.
   *
   * Defaults to `dsh`: that is what every entry created before this field existed means.
   */
  id: z.string().default('dsh'),
  name: z.string().required(),
  description: z.string().default(''),
  body: z.string().default(''),
  enabled: z.boolean().default(true),
})

/** One MCP row the profile already configures outside this panel (read-only here). */
const ProfileRow = z.object({
  entryId: z.string().default(''),
  serverName: z.string().default(''),
  transport: z.string().default('streamable-http'),
  /** url (http) or `command + args` (stdio) — what the card shows. */
  target: z.string().default(''),
  /** Raw stdio executable: `target` merges it with `args`, so editing needs both. */
  command: z.string().default(''),
  args: z.string().default(''),
  env: z.string().default(''),
  /** Connection policy read back from the row, so the edit form can prefill it. */
  failOnStartupError: z.boolean().default(false),
  reconnectInitialDelayMs: z.string().default(''),
  reconnectMaxDelayMs: z.string().default(''),
  reconnectMaxAttempts: z.string().default(''),
  /** Per-call tool timeout for this server ('' = the client's own default). */
  toolCallTimeoutMs: z.string().default(''),
  enabled: z.boolean().default(true),
  phase: z.string().default(''),
})

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
  /** Connection policy written into the row's config (see src/mcp/connection.js). */
  failOnStartupError: z.boolean().default(false),
  reconnectInitialDelayMs: z.string().default(''),
  reconnectMaxDelayMs: z.string().default(''),
  reconnectMaxAttempts: z.string().default(''),
  /** Per-call tool timeout for this server ('' = the client's own default). */
  toolCallTimeoutMs: z.string().default(''),
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
 * One skill write request, shared by the settings-queue channel and the HTTP route.
 *
 * Defining it once is the point: `mcp/rows.js` learned this the hard way — two paths that
 * validate separately drift, and the drift shows up as a field that works on one channel and
 * silently disappears on the other. Both channels now validate with *this* schema.
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
  /**
   * `.volatile()` is **required** — this field travels through the settings document.
   *
   * The settings service only accepts writes to fields declared volatile
   * (`isVolatilePath` in `@deepseek-ai/dsh-settings`), and every other queue-driven field here
   * carries it. The inline schema this replaced had it on the whole object; extracting the
   * definition without re-applying it made every queue write throw
   * `Config field "skillRequest" is not volatile`. `op: 'read'` still travels the queue, so that
   * is what the editor hit.
   */
}).default({}).volatile()

export const Config = z.object({
  servers: z.array(Server).default([]).volatile(),
  skills: z.array(Skill).default([]).volatile(),
  /**
   * Queue of edits the panel issues against profile-configured rows. The client
   * can only reach the Host through settings, so commands ride the same channel
   * and this half clears the queue once the patch write settles.
   */
  rowOps: z.array(RowOp).default([]).volatile(),
  /**
   * Capability marker: written by this Host half once it can apply `rowOps`, so
   * the panel only offers 编辑 / 删除 on profile rows when the running Host
   * actually honours them (an older Host would leave a queue behind).
   */
  rowOpsReady: z.boolean().default(false).volatile(),
  /** One explicit import request (the panel's "扫描项目 MCP" action). */
  importRequest: z.object({
    source: z.string().default(''),
    /** `global` reads the tool's user-level file, `project` the selected workspace. */
    scope: z.string().default('project'),
    project: z.string().default(''),
    /** For `op: 'read'`: the SKILL.md path, which must be in the current scan. */
    path: z.string().default(''),
    nonce: z.string().default(''),
  }).default({}).volatile(),
  /** The scan answer for the latest request. */
  /** Skill write request from the panel (create/update/rename/delete on disk). */
  skillRequest: SkillRequest,
  skillResult: z.object({
    ok: z.boolean().default(false),
    reason: z.string().default(''),
    name: z.string().default(''),
    /** Body text, only for the on-demand `read` op (never stored in the list). */
    body: z.string().default(''),
    /** When the Host produced this receipt; lets the client match by freshness. */
    at: z.string().default(''),
    nonce: z.string().default(''),
  }).default({}).volatile(),
  importResult: z.object({
    nonce: z.string().default(''),
    source: z.string().default(''),
    scope: z.string().default('project'),
    project: z.string().default(''),
    at: z.string().default(''),
    files: z.array(z.object({
      path: z.string().default(''),
      exists: z.boolean().default(false),
      servers: z.array(z.string()).default([]),
      unsupported: z.number().default(0),
      error: z.string().default(''),
    })).default([]),
    servers: z.array(Server).default([]),
    error: z.string().default(''),
  }).default({}).volatile(),
  /** MCP servers discovered in project-level editor files (`.mcp.json`, …). */
  workspaceServers: z.array(z.object({
    project: z.string().default(''),
    file: z.string().default(''),
    serverName: z.string().default(''),
    transport: z.string().default('streamable-http'),
    target: z.string().default(''),
    args: z.string().default(''),
    env: z.string().default(''),
    headers: z.string().default(''),
  })).default([]).volatile(),
  /** cwd of the session's agent: the panel preselects that workspace. */
  currentWorkspace: z.string().default('').volatile(),
  /** Workspaces the registry knows: the panel's project picker reads these. */
  workspaces: z.array(z.object({
    id: z.string().default(''),
    title: z.string().default(''),
    path: z.string().default(''),
  })).default([]).volatile(),
  /**
   * Projection of the MCP rows already configured in the active profile, kept
   * current by this Host half. It is written into the settings document because
   * a third-party bundle has no remote namespace of its own to reach the client
   * with, and the panel should show what the profile already configures.
   */
  profileServers: z.array(ProfileRow).default([]).volatile(),
  /**
   * 面板请求重连一台服务器。
   *
   * 与 `rowOps` 同构：面板写、Host 排空后清空。全局行只能靠让 Loader 重建实例
   * （停用 → 启用）才拿得到新的重试预算，项目级条目则由本插件失效挂载 key 重挂。
   * 两条路都不需要重启 DSH。
   */
  reconnectRequest: z.object({
    tier: z.string().default(''),
    serverName: z.string().default(''),
    scope: z.string().default(''),
    nonce: z.string().default(''),
    at: z.string().default(''),
  }).default({ tier: '', serverName: '', scope: '', nonce: '', at: '' }).volatile(),
  /** Capability marker：Host 能处理 reconnectRequest 时才为 true。 */
  reconnectReady: z.boolean().default(false).volatile(),
  /**
   * 连接观测机制自身的状态，供面板如实展示。
   *
   * 与 `filterState` 同理：这个监听是「服务器是否还活着」的唯一事实来源，如果它没装上，
   * 面板**必须说不知道**，而不是把「观测不到」当成「服务器死了」。`instances` 列出它
   * 实际看到的实例名 —— 排查「标签说未连接但其实连着」这类问题时，这是唯一能区分
   * 「真的没实例」和「监听漏了」的证据。
   */
  probeState: z.object({
    installed: z.boolean().default(false),
    reason: z.string().default(''),
    /** 最近一轮探测的逐服务器结果，是排查「标签说未连接但其实连着」的唯一证据。 */
    results: z.array(z.object({
      serverName: z.string().default(''),
      state: z.string().default(''),
      detail: z.string().default(''),
    })).default([]),
  }).default({ installed: false, reason: '', results: [] }).volatile(),
  /** 上一次重连的结果（按 nonce 回给发起的那个面板）。 */
  reconnectResult: z.object({
    nonce: z.string().default(''),
    ok: z.boolean().default(false),
    error: z.string().default(''),
  }).default({ nonce: '', ok: false, error: '' }).volatile(),
  /**
   * 每个服务器的工具过滤规则：`{ [serverName]: { mode, tools } }`。
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
  /**
   * 过滤器的实际状态，供面板如实展示。
   *
   * `installed` 为 false 时是「没装上」而不是「没生效的必要」——这两者在界面上必须
   * 区分，否则用户以为过滤在工作而实际没有，正是这类插件最坏的失败方式。
   */
  filterState: z.object({
    installed: z.boolean().default(false),
    reason: z.string().default(''),
    /** 被挡下的工具名（去重、按服务器归组在面板侧做）。 */
    dropped: z.array(z.string()).default([]),
    /** shadow 装上时已经注册的 MCP 工具：它们永远过滤不到。 */
    preExisting: z.array(z.string()).default([]),
  }).default({ installed: false, reason: '', dropped: [], preExisting: [] }).volatile(),
  /**
   * Resolved skill directories, so the UI can show real OS-correct paths instead
   * of "$DSH_HOME"/"~" (Windows uses backslashes and %USERPROFILE%).
   */
  skillDirs: z.object({
    userDsh: z.string().default(''),
    userAgents: z.string().default(''),
  }).default({ userDsh: '', userAgents: '' }).volatile(),
  /**
   * Diagnostics for the disk-skill scan, published so the truth is readable from
   * the profile patch itself: which roots were scanned, how many skills came back,
   * and the error text when the scan failed (it used to fail silently).
   */
  discoveryInfo: z.object({
    at: z.string().default(''),
    roots: z.array(z.string()).default([]),
    count: z.number().default(0),
    error: z.string().default(''),
  }).default({}).volatile(),
  /** Read-only: skills already on disk in DSH's roots (not managed by this panel). */
  discoveredSkills: z.array(z.object({
    name: z.string().default(''),
    description: z.string().default(''),
    path: z.string().default(''),
    source: z.string().default(''),
    scope: z.string().default('global'),
  })).default([]).volatile(),
})

/** Bookkeeping for the skill files this plugin owns. */
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
  const loader = loaderOf(ctx)
  if (loader === null || typeof loader.entries !== 'function') return { loaderFound: false, rows: [] }
  try {
    const rows = serverRows([...(loader.entries() ?? [])]).map((server) => ({
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
      enabled: server.enabled,
      phase: server.phase,
    }))
    return { loaderFound: true, rows }
  } catch (error) {
    return { loaderFound: true, rows: [], error: String(error?.message ?? error) }
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
  const readSkills = () => config?.skills?.get?.() ?? config?.skills ?? []
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

  /**
   * Import scan state. The panel asks for one source at a time through the
   * settings document (its only channel to the Host); the answer is written back
   * into the same document, so no editor file is ever mounted behind the user's
   * back — imports are explicit and land in the panel's own project entries.
   */
  const importState = { nonce: '', result: null }
  /** Nonce of the last skill write we executed (the panel polls by changing it). */
  let seenSkillNonce = ''

  let committedServers = []
  let committedServersKey = null
  let skillsKey = null
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
   */
  const mountForAgent = (agent, entry) => {
    const desired = projectServersFor(committedServers, entry.cwd)
    const key = serverSetKey(desired)
    if (entry.key === key) return
    unmount(entry.stops)
    for (const server of desired) mountInto(agent.ctx, server, entry.stops, `agent scope ${entry.cwd}`)
    entry.key = key
  }

  const attachAgent = (agent) => {
    if (agent === undefined || agent === null || agents.has(agent)) return
    const entry = { cwd: workingDirectoryOf(agent), stops: [], key: null }
    agents.set(agent, entry)
    mountForAgent(agent, entry)
  }

  const detachAgent = (agent) => {
    const entry = agents.get(agent)
    if (entry === undefined) return
    unmount(entry.stops)
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

  /**
   * Publish the profile's own MCP rows into this namespace so the panel can show
   * them. Settings is the only client-facing channel a third-party bundle
   * reaches (no custom remote namespace), so it doubles as the read model.
   */
  /** Published on every transition; the heartbeat file surfaces it for debugging. */
  let lastBeat = { at: '', observed: { servers: [], skills: [] }, changed: {}, mounted: 0, agents: [] }
  const projection = { loaderFound: null, rows: null, wrote: false, error: null, toolsError: null }
  const rowOps = { pending: 0, applied: 0, error: null }
  /** Latest disk-skill scan, refreshed on a timer (the scan itself is async). */
  let discoveredSkills = []
  /** Last skill/import op, surfaced on the heartbeat for outside diagnosis. */
  let lastOp = null
  let discoveryInfo = { at: '', roots: [], count: 0, error: '' }
  /** When the projection last reached the settings document (diagnostics). */
  let publishedAt = ''
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
      beat({ ...lastBeat, at: new Date().toISOString(), publishedAt, discovery: discoveryInfo })
    } catch (error) {
      // A failed scan must not look like "there are no skills on disk", and the
      // reason must survive into the published diagnostics.
      discoveryInfo = { at: new Date().toISOString(), roots, count: 0, error: String(error?.message ?? error) }
      beat({ ...lastBeat, at: new Date().toISOString(), publishedAt, discovery: discoveryInfo })
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
    projection.toolsError = inventory.ok ? null : `${serverToolsError.reason}: ${serverToolsError.detail}`
    const toolCounts = new Map(serverTools.map((entry) => [entry.serverName, entry.tools.length]))
    const serverStatus = computeServerStatus({ rows: plain, entries: readServers(), toolCounts })
    return { serverTools, serverToolsError, serverStatus }
  }
  // Optional injection keeps non-web profiles usable; never fall back to writing tools.
  ctx.inject(['webServer', 'connection'], (inner) => registerRuntimeRoute(inner, readRuntime))

  ctx.inject(['settings'], (inner) => {
    /**
     * One-time migration: this plugin's own `config.servers` entries become rows.
     *
     * Project servers used to live in a field this plugin owned while global ones were
     * rows — the same feature stored two ways, which is why the panel had to merge two
     * arrays into one list and a scope-less registry read could not see project tools at
     * all. Both tiers are rows now; this moves the leftovers and then clears the field, so
     * exactly one source remains.
     *
     * Runs after a short delay: the startup projection writes the same patch file, and the
     * two would contend for its lock. Only a non-empty field triggers it, and it is a no-op
     * once the field is cleared.
     */
    inner.effect(() => {
      /**
       * Checked on a recurring tick, **not** on a one-shot `setTimeout`.
       *
       * A one-shot timer here never survived: `publish()` writes the patch immediately on
       * startup, `dsh-hmr` reacts by reloading the profile, and the reload disposes this
       * plugin's effects — clearTimeout() removed the pending migration before it could
       * fire. The disposal is invisible because the *other* effect in this inject uses
       * `setInterval`, so a reload simply re-registers it and its side effects continue,
       * while a one-shot job is lost for good.
       *
       * A recurring check has neither problem: it re-arms after every reload, and it is
       * idempotent (`migrated === 0` once the field is empty, and `migrateServerEntries`
       * never overwrites an existing row).
       */
      const attempt = () => {
        const legacy = config?.servers?.get?.() ?? config?.servers
        serverMigrationState.source = Array.isArray(legacy) ? legacy.length : -1
        if (!Array.isArray(legacy) || legacy.length === 0) {
          serverMigrationState.status = 'nothing-to-do'
          return
        }
        if (serverMigrationState.status === 'running') return
        serverMigrationState.status = 'running'
        Promise.resolve(migrateServerEntries(ctx, legacy))
          .then((result) => {
            serverMigrationState.migrated = result.migrated
            serverMigrationState.status = result.migrated === 0 ? 'already-present' : 'migrated'
            // Clear the field whenever every entry is accounted for — including when the
            // rows were already there (`migrated === 0`).
            //
            // Returning early on `migrated === 0` left a trap: if the rows landed but this
            // very write failed (it did once — "timed out waiting for the writer lock"),
            // the next attempt would find the rows present, report `already-present`, and
            // never clear the field. The stale entries would then be re-checked on every
            // tick forever, and the panel would keep showing servers twice (once from the
            // field, once from the rows).
            //
            // Only clearing after the rows are safely on disk is still the rule: the write
            // above has already succeeded by the time we get here.
            return Promise.resolve(inner.settings.update(name, { servers: [] }))
              .then(() => ctx.logger.info('dsh-skills-mcp-manager: %d panel server(s) moved into profile rows', result.migrated))
          })
          .catch((error) => {
            serverMigrationState.status = 'failed'
            serverMigrationState.reason = String(error?.message ?? error)
            ctx.logger.warn('dsh-skills-mcp-manager: cannot migrate panel servers into rows: %s', serverMigrationState.reason)
          })
      }
      // First attempt after a short delay (the startup projection holds the patch lock),
      // then keep re-checking until the field is empty.
      const timer = setTimeout(attempt, 3000)
      const repeat = setInterval(attempt, 5000)
      return () => { clearTimeout(timer); clearInterval(repeat) }
    }, 'dsh-skills-mcp-manager.server-migration')

    // Seed from the value already stored in this namespace: a recomposition must
    // not re-write identical rows, or the write would trigger the next reload.
    const stored = config?.profileServers?.get?.() ?? config?.profileServers
    const storedSpaces = config?.workspaces?.get?.() ?? config?.workspaces
    let published = JSON.stringify([Array.isArray(stored) ? stored : [], Array.isArray(storedSpaces) ? storedSpaces : []])
    inner.effect(() => {
      const scan = () => {
        const roots = []
        const add = (dir) => {
          if (typeof dir !== 'string' || dir === '') return
          const root = projectRootOf(dir)
          if (!roots.includes(root)) roots.push(root)
        }
        for (const entry of agents.values()) add(entry.cwd)
        for (const workspace of configuredWorkspaces(ctx)) {
          // configuredWorkspaces returns { path, title } objects
          add(typeof workspace === "string" ? workspace : workspace?.path)
        }
        void refreshDiscovered(roots)
      }
      scan()
      const timer = setInterval(scan, 5000)
      return () => clearInterval(timer)
    })

    let runtimeCleaned = false
    let runtimeCleanupPending = false
    let projectionAlive = true
    inner.effect(() => () => { projectionAlive = false })
    const publish = () => {
      if (!projectionAlive) return
      if (!runtimeCleaned) {
        if (runtimeCleanupPending) return
        runtimeCleanupPending = true
        Promise.resolve(migratePanelConfig(ctx))
          .then(() => { runtimeCleaned = true; publish() })
          .catch((error) => ctx.logger.warn('dsh-skills-mcp-manager: runtime cleanup failed: %s', String(error?.message ?? error)))
          .finally(() => { runtimeCleanupPending = false })
        return
      }
      const { loaderFound, rows, error } = configuredMcpRows(ctx)
      projection.loaderFound = loaderFound
      projection.rows = rows.length
      // Loader config values can be YAML nodes (Scalar & friends carry iterators);
      // the settings validator only accepts plain JSON, so normalise first.
      const plain = JSON.parse(JSON.stringify(rows))
      const spaces = configuredWorkspaces(ctx).map((workspace) => ({
        ...workspace,
        agentsSkillsDir: workspace.path === '' ? '' : join(workspace.path, '.agents', 'skills'),
      }))
      const cwds = [...agents.values()].map((entry) => entry.cwd).filter((cwd) => typeof cwd === 'string' && cwd !== '')
      const currentWorkspace = cwds[0] ?? ''
      const currentProjectRoot = currentWorkspace === '' ? '' : projectRootOf(currentWorkspace)

      if (error !== undefined) projection.error = error
      const skillDirs = {
        userDsh: join(resolveDshHome(), 'skills'),
        userAgents: join(agentsHome(), 'skills'),
      }
      // Keep background probes warm even when no panel is open.
      readRuntime()
      // The filter may only judge servers the panel can see, so its cached name set
      // is refreshed on the same slow tick that publishes everything else.
      refreshFilterServers(readServers())
      const filterStateOut = {
        installed: filterState.installed,
        reason: filterState.reason,
        dropped: [...filterState.dropped],
        preExisting: [...filterState.preExisting],
      }
      // The probe's own health travels with the projection: "no server is down" and
      // "we cannot tell" must never render the same, and the per-server results are the
      // evidence that separates a genuinely absent instance from a missed one.
      const probeStateOut = {
        installed: probe.available(),
        reason: probe.reason(),
        results: [...probeCache.entries()].map(([serverName, cached]) => ({
          serverName,
          state: String(cached?.state ?? ''),
          detail: String(cached?.detail ?? ''),
        })),
      }
      const { at: scanAt, ...discoveryState } = discoveryInfo
      const key = JSON.stringify([plain, filterStateOut, probeStateOut, spaces, currentWorkspace, discoveredSkills, skillDirs, discoveryState])
      if (key === published) return
      // Never erase a good projection because the Loader read came back empty.
      if (plain.length === 0 && !loaderFound) {
        projection.error = projection.error ?? 'loader unavailable'
        return
      }
      Promise.resolve(inner.settings.update(name, {
          profileServers: plain, filterState: filterStateOut, probeState: probeStateOut, workspaces: spaces, currentWorkspace, discoveredSkills, skillDirs, discoveryInfo,
          // Re-assert every publish: this marker has been lost by a later rewrite
          // before, and losing it hides the row actions in the panel.
          rowOpsReady: true,
          reconnectReady: true,
        }))
        .then(() => {
          published = key
          projection.wrote = true
          publishedAt = new Date().toISOString()
          projection.error = null
        })
        .catch((writeError) => {
          projection.error = String(writeError?.message ?? writeError)
          ctx.logger.warn('dsh-skills-mcp-manager: cannot publish profile rows: %s', projection.error)
        })
    }
    publish()
    const timer = setInterval(publish, 5000)
    inner.effect(() => () => clearInterval(timer))

    // Panel commands against profile-configured rows.
    let applying = false
    const drain = () => {
      const ops = config?.rowOps?.get?.() ?? config?.rowOps
      const queue = Array.isArray(ops) ? ops : []
      if (applying || queue.length === 0) return
      applying = true
      rowOps.pending = queue.length
      // Clear the queue BEFORE writing the patch: the clear is itself a settings
      // write, and writing the patch first nests HMR transactions ("HMR
      // transactions cannot be nested"), which left the queue replaying forever.
      Promise.resolve(inner.settings.update(name, { rowOps: [] }))
        .then(() => new Promise((resolve) => setTimeout(resolve, 1200)))
        .then(async () => {
          for (const op of queue) {
            try {
              await applyRowOp(ctx, op)
              rowOps.applied += 1
            } catch (error) {
              rowOps.error = String(error?.message ?? error)
              ctx.logger.warn('dsh-skills-mcp-manager: row %s failed: %s', op.op, rowOps.error)
            }
          }
        })
        .catch((error) => {
          rowOps.error = String(error?.message ?? error)
        })
        .finally(() => {
          rowOps.pending = 0
          // Row ops change the profile; recompute and publish at once instead of
          // waiting for the 2s tick plus the 5s publish timer (that pair made the first
          // create look slow while the write itself had long finished).
          try { tick(); publish() } catch (error) { console.error('[dsh-skills-mcp-manager] post-drain refresh failed:', error) }
          applying = false
          beat({ ...lastBeat, at: new Date().toISOString(), rowOps })
          // The Loader hot-reloads the patch a moment after the write; republish
          // then, so the panel list reflects the change without a page switch.
          setTimeout(() => { try { publish() } catch { /* projection retries on the tick */ } }, 800)
        })
    }
    drain()
    const opTimer = setInterval(drain, 500)
    inner.effect(() => () => clearInterval(opTimer))

    /**
     * Row commands over HTTP — the short path, beside the queue above.
     *
     * The write takes ~1–5 ms (measured). The queue route wrapped 2–4 s of *waiting* around it:
     * a 500 ms drain poll, a fixed 1200 ms pause (see the comment above `drain`), the Loader's
     * reload of the patch, and then the panel's own poll before it saw anything. During all of
     * that the panel could only show a spinner. Same service DSH's own plugins use for their
     * routes, same trust check as the runtime read route, and the **same `RowOp` schema** the
     * queue validated with — so the two channels cannot disagree about what a command means.
     *
     * The queue keeps draining: a panel that only knows that channel still works, and it stays
     * the fallback when this route is unavailable (an older Host, or a profile with no web
     * server).
     */
    ctx.inject(['webServer', 'connection'], (routeCtx) => registerRowRoute(routeCtx, {
      schema: (payload) => RowOp(payload),
      apply: async (op) => {
        await applyRowOp(routeCtx, op)
        // The patch changed outside the settings channel, so refresh the projection now rather
        // than waiting for the 2 s tick: the list is built from it, and a short round-trip is
        // the whole point of this route.
        try { tick(); publish() } catch (error) {
          routeCtx.logger.warn('dsh-skills-mcp-manager: post-command refresh failed: %s', String(error?.message ?? error))
        }
        return { ok: true, reason: '' }
      },
    }))

    /**
     * Panel requests to reconnect one MCP server.
     *
     * Why the instance has to be recreated instead of "nudged": the retry state lives
     * inside the client's closure (`failedAttempts`, `reconnectTimer`) and there is no
     * API to reset it. Worse, `dispose()` clears the pending reconnect timer, so once
     * a server has given up only a **new plugin instance** gets a fresh budget. For a
     * global row that means letting the Loader rebuild the row; for a project entry
     * this plugin owns the mount and can drop it directly.
     *
     * The global sequence is two writes (disable, then re-enable) that are deliberately
     * spread across ticks: `dsh-hmr` watches the patch file, and a value written and
     * immediately restored can coalesce into "no change" and never reload at all. It
     * also waits for the disable to actually show up in the Loader before re-enabling,
     * so the re-enable can never land while the old instance is still alive.
     */
    let reconnectTask = null
    let seenReconnectNonce = ''
    let reconnectResult = { nonce: '', ok: false, error: '' }
    /** How long to wait for the Loader to reflect a disable before giving up on it. */
    const RECONNECT_STEP_TIMEOUT_MS = 25000

    const clearReconnectRequest = () => Promise.resolve(inner.settings.update(name, {
      reconnectRequest: { tier: '', serverName: '', scope: '', nonce: '', at: '' },
      reconnectResult: { ...reconnectResult },
    }))

    const finishReconnect = (nonce, error) => {
      reconnectResult = { nonce, ok: error === undefined, error: error === undefined ? '' : String(error) }
      if (error !== undefined) ctx.logger.warn('dsh-skills-mcp-manager: reconnect failed: %s', reconnectResult.error)
      reconnectTask = null
      // Refresh first so the tag moves immediately, then clear the request so the panel
      // stops showing it as in flight. A leftover `disabled: true` is never acceptable,
      // so any failure path still lands here having restored the row.
      clearReconnectRequest()
        .then(() => {
          try {
            tick()
            publish()
          } catch (refreshError) {
            ctx.logger.warn('dsh-skills-mcp-manager: post-reconnect refresh failed: %s', String(refreshError?.message ?? refreshError))
          }
        })
        .catch((writeError) => {
          ctx.logger.warn('dsh-skills-mcp-manager: cannot clear the reconnect request: %s', String(writeError?.message ?? writeError))
        })
    }

    const remountProject = (serverName) => {
      let touched = 0
      for (const [agent, entry] of agents) {
        const desired = projectServersFor(committedServers, entry.cwd)
        if (!desired.some((server) => server.serverName === serverName)) continue
        // Re-mounting is per-agent and covers that agent's whole project set: the mount
        // bookkeeping keeps one disposer list per agent, so a single server cannot be
        // swapped on its own. A manual reconnect is rare and every server involved gets
        // a fresh budget, which is the safer direction.
        entry.key = null
        mountForAgent(agent, entry)
        touched += 1
      }
      return touched
    }

    const advanceReconnect = () => {
      const task = reconnectTask
      if (task === null) return
      if (task.stage === 'project') {
        const touched = remountProject(task.serverName)
        finishReconnect(task.nonce, touched === 0 ? `没有会话正在使用项目级服务器 ${task.serverName}，无需重连` : undefined)
        return
      }
      // Global row: disable → wait for the Loader to confirm → re-enable.
      if (task.stage === 'stop') {
        if (applying) return // never interleave patch writes with the row-op drain
        const row = configuredMcpRows(ctx).rows.find((item) => item.serverName === task.serverName)
        if (row === undefined || row.entryId === '') {
          finishReconnect(task.nonce, `profile 里找不到服务器 ${task.serverName} 对应的行`)
          return
        }
        if (row.enabled === false) {
          finishReconnect(task.nonce, `服务器 ${task.serverName} 处于停用状态，先在面板里启用它`)
          return
        }
        task.entryId = row.entryId
        task.stage = 'await-stop'
        task.sentAt = Date.now()
        Promise.resolve(applyRowOp(ctx, { op: 'toggle', entryId: row.entryId, enabled: false }))
          .catch((error) => finishReconnect(task.nonce, String(error?.message ?? error)))
        return
      }
      if (task.stage === 'await-stop') {
        const row = configuredMcpRows(ctx).rows.find((item) => item.entryId === task.entryId)
        const stopped = row === undefined || row.enabled === false
        if (!stopped && Date.now() - task.sentAt < RECONNECT_STEP_TIMEOUT_MS) return
        task.stage = 'start'
        // Re-enable even on timeout: leaving the row disabled would turn a failed
        // reconnect into a worse regression than the one the user was fixing.
        Promise.resolve(applyRowOp(ctx, { op: 'toggle', entryId: task.entryId, enabled: true }))
          .then(() => finishReconnect(task.nonce, stopped ? undefined : '停用后未等到 Loader 卸载该行，已重新启用，请再试一次'))
          .catch((error) => finishReconnect(task.nonce, String(error?.message ?? error)))
      }
    }

    const drainReconnect = () => {
      const request = config?.reconnectRequest?.get?.() ?? config?.reconnectRequest
      const nonce = typeof request?.nonce === 'string' ? request.nonce : ''
      if (reconnectTask === null && nonce !== '' && nonce !== seenReconnectNonce) {
        seenReconnectNonce = nonce
        const serverName = String(request?.serverName ?? '')
        const tier = String(request?.tier ?? '')
        if (serverName === '') {
          finishReconnect(nonce, '请求里没有服务器名')
          return
        }
        reconnectTask = { nonce, serverName, tier, entryId: '', stage: tier === 'project' ? 'project' : 'stop', sentAt: Date.now() }
      }
      advanceReconnect()
    }
    drainReconnect()
    const reconnectTimer = setInterval(drainReconnect, 500)
    inner.effect(() => () => clearInterval(reconnectTimer))

    /**
     * Apply one skill write, shared by the HTTP route and the settings-queue fallback.
     *
     * Extracted so the two channels cannot drift: they used to differ in ways that mattered
     * (the queue path re-scanned roots, the direct path must too), and a fix in one place
     * silently missing the other is exactly the failure mode this plugin has hit before with
     * `serverRows.js`'s two field lists.
     *
     * `read` is **not** handled here — it stays on the queue (see `skills/route.js`).
     */
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
        // Re-scan so the projection can show it now. A `read` never reaches here, and the
        // periodic scan already covers every project — but a write must refresh the roots it
        // touched, or the new skill is invisible until the next 5 s scan.
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

    /** Record what just happened (diagnostics) and push the projection out now. */
    const finishSkillOp = (op, skillReq, result) => {
      lastOp = {
        op: String(op ?? ''), name: String(skillReq?.name ?? ''),
        nonce: String(result?.nonce ?? ''), ok: result?.ok === true,
        at: new Date().toISOString(),
      }
      // Publish immediately: waiting for the 5s publish interval was the
      // entire reason a save took ~4.6s to show up in the panel.
      try { tick(); publish() } catch (error) { console.error('[dsh-skills-mcp-manager] immediate publish failed:', error) }
    }

    /**
     * Skill writes over HTTP — same reasoning as the row route above.
     *
     * Writing one file takes **1 ms** (measured); the queue round-trip took up to **9.1 s**
     * because it stacked four polls (600 ms request drain + the panel's settings poll + the
     * 2 s reconcile tick + the 5 s publish). Adding a skill is a click, so it should not wait
     * on four timers. Deleting only *felt* fast — it has an optimistic tombstone; it used the
     * same slow channel.
     *
     * The queue keeps draining, so an older panel still works and this route stays an
     * optimisation rather than a requirement.
     */
    ctx.inject(['webServer', 'connection'], (skillRouteCtx) => registerSkillRoute(skillRouteCtx, {
      schema: (payload) => SkillRequest(payload),
      apply: async (request) => {
        const op = String(request?.op ?? '')
        // `read` is a read: it stays on the settings channel (that is where the panel asks for
        // it, and it is not the slow path anyone complained about). Refusing it here keeps the
        // route's contract to "writes only", so a mis-routed request fails loudly.
        if (op === 'read') return { ok: false, reason: 'read 不走此路由', name: '', body: '', nonce: String(request?.nonce ?? ''), at: new Date().toISOString() }
        const result = await applySkillWrite(request)
        finishSkillOp(op, request, result)
        return result
      },
    }))

    // Project MCP import: the panel posts a request, this half scans one tool's
    // project files and writes the answer back for the panel to preview.
    let seenNonce = ''
    const importTimer = setInterval(() => {
      {
        const skillReq = config?.skillRequest?.get?.() ?? config?.skillRequest
        const skillNonce = typeof skillReq?.nonce === 'string' ? skillReq.nonce : ''
        if (skillNonce !== '' && skillNonce !== seenSkillNonce) {
          seenSkillNonce = skillNonce
          const op = String(skillReq?.op ?? '')
          const roots = writableRoots({
            dshHome: resolveDshHome(),
            agentsHome: agentsHome(),
            projectRoot: skillReq?.project === '' ? '' : projectRootOf(String(skillReq.project)),
          })
          void (async () => {
           try {
            let result
            if (op === 'read') {
              // Only ever read a file the scan actually found — but the in-memory list
              // can lag a just-created skill, so rescan once before refusing (using the
              // same root sources as the periodic scan).
              const wanted = String(skillReq?.path ?? '')
              const isKnown = () => Array.isArray(discoveredSkills) && discoveredSkills.some((entry) => entry.path === wanted)
              const known = isKnown()
              if (!known) {
                try {
                  const extra = []
                  for (const agent of agents.values()) extra.push(projectRootOf(agent.cwd))
                  for (const workspace of configuredWorkspaces(ctx)) extra.push(projectRootOf(String(workspace?.path ?? workspace?.dir ?? '')))
                  const scopes = discoveredSkills.map((entry) => entry.scope).filter((scope) => typeof scope === 'string' && scope !== '' && scope !== 'global')
                  const nextRoots = [...new Set([...roots.map((entry) => projectRootOf(entry.dir)), ...scopes, ...extra])]
                    .filter((root) => typeof root === 'string' && root !== '')
                  await refreshDiscovered(nextRoots)
                } catch (error) {
                  if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] read rescan failed', error)
                }
              }
              if (!isKnown()) {
                result = { ok: false, reason: '该技能不在当前扫描结果里', name: '', body: '', nonce: skillNonce , at: new Date().toISOString() }
              } else {
                try {
                  const text = await readFile(wanted, 'utf8')
                  result = { ok: true, reason: '', name: '', body: bodyOf(text), nonce: skillNonce , at: new Date().toISOString() }
                } catch (error) {
                  result = { ok: false, reason: String(error?.message ?? error), name: '', body: '', nonce: skillNonce , at: new Date().toISOString() }
                }
              }
            }
            else {
              // Writes share one implementation with the HTTP route (`applySkillWrite`), so a
              // fix cannot land in one channel and miss the other.
              result = await applySkillWrite(skillReq)
            }
            // A skill op must never throw out of here: an exception used to escape
            // the plugin load and DSH exited with "fatal load failure", taking the
            // whole app (and every other plugin) down with it.
            try {
              await Promise.resolve(inner.settings.update(name, {
                skillResult: result,
                // Clear the request in the same write so a restart cannot replay it.
                skillRequest: { op: '', scope: '', id: '', project: '', path: '', name: '', prevName: '', description: '', body: '', nonce: '' },
              }))
              // A `read` never touches the disk, so it must not move the projection —
              // re-scanning from the request's own roots shrank the list to global-only,
              // which made project skills vanish mid-preview.
              if (op !== 'read') finishSkillOp(op, skillReq, result)
            } catch (error) {
              console.error('[dsh-skills-mcp-manager] skill op failed:', error)
            }
           } catch (error) {
            console.error('[dsh-skills-mcp-manager] skill request failed:', error)
           }
          })()
        }
      }

      const request = config?.importRequest?.get?.() ?? config?.importRequest
      const nonce = typeof request?.nonce === 'string' ? request.nonce : ''
      if (nonce === '' || nonce === seenNonce) return
      seenNonce = nonce
      const source = typeof request?.source === 'string' ? request.source : ''
      const scope = request?.scope === 'global' ? 'global' : 'project'
      const project = typeof request?.project === 'string' ? request.project : ''
      let payload
      try {
        payload = { nonce, source, scope, project, at: new Date().toISOString(), ...scanImportSource(scope, project, source) }
      } catch (error) {
        payload = { nonce, source, scope, project, at: new Date().toISOString(), files: [], servers: [], error: String(error?.message ?? error) }
      }
      Promise.resolve(inner.settings.update(name, { importResult: payload }))
        .catch((error) => ctx.logger.warn('dsh-skills-mcp-manager: import scan failed: %s', String(error?.message ?? error)))
    }, 600)
    inner.effect(() => () => clearInterval(importTimer))
  })

  let lastReconcile = null
  let pendingServersKey = null
  let pendingSkillsKey = null
  let firstTick = true

  const tick = () => {
    // Before anything is decided: make sure every live agent is tracked. An agent that
    // predates this plugin's subscription never fires `agent/created` here, and an untracked
    // agent is an unmounted project server (see `adoptLiveAgents`).
    adoptLiveAgents()
    const servers = readServers()
    const skills = readSkills()

    // Act only on a state observed twice in a row. A Loader recomposition can
    // mount this row with a transient empty config; acting on that would
    // unmount live servers and delete skill files that are still configured.
    //
    // The debounce watches the WHOLE server list, while the global remount is
    // gated on its own key: a config holding only project servers still has to
    // commit, or agents would never receive them.
    // The key deliberately ignores `phase`: the Loader updates it on its own schedule, and
    // a phase change is not a reason to tear down a working connection and rebuild it.
    const observedServersKey = serverSetKey(servers)
    let serversChanged = false
    if (observedServersKey === committedServersKey) {
      pendingServersKey = null
    } else if (observedServersKey === pendingServersKey) {
      committedServers = servers
      committedServersKey = observedServersKey
      pendingServersKey = null
      serversChanged = true
      // Global rows are connected by the Loader itself (they *are* `mcp-client` rows), so
      // this plugin mounts only the project tier. Mounting a global row here too would
      // double-connect it — two clients, two tool generations, one namespace.
      for (const [agent, entry] of agents) mountForAgent(agent, entry)
    } else {
      pendingServersKey = observedServersKey
    }

    const skillsKeyNext = JSON.stringify(skills)
    let skillsChanged = false
    if (skillsKeyNext === skillsKey) {
      pendingSkillsKey = null
    } else if (skillsKeyNext === pendingSkillsKey) {
      skillsKey = skillsKeyNext
      pendingSkillsKey = null
      skillsChanged = true
    } else {
      pendingSkillsKey = skillsKeyNext
    }

    if (firstTick || serversChanged || skillsChanged) {
      firstTick = false
      lastBeat = {
        at: new Date().toISOString(),
        observed: { servers: servers.map((s) => s.serverName), skills: skills.map((s) => `${s.scope}:${s.name}`) },
        changed: { servers: serversChanged, skills: skillsChanged },
        // Only the project tier is mounted by this plugin now: global rows are connected by
        // the Loader, so counting them here would double-count what the Loader already owns.
        // `agents[].mounted` is the number that actually reflects this plugin's work.
        mounted: [...agents.values()].reduce((total, entry) => total + entry.stops.length, 0),
        rootScope: Boolean(ctx.root && ctx.root !== ctx),
        agents: [...agents.values()].map((entry) => ({ cwd: entry.cwd, mounted: entry.stops.length })),
        projection,
        rowOps,
        lastReconcile,
      }
      // Also carry the diagnostics on the heartbeat file: it is readable straight
      // from disk, so the truth survives even when a settings write does not land.
      lastBeat = {
        ...lastBeat,
        publishedAt,
        discovery: discoveryInfo,
        lastOp,
        skillResult: config?.skillResult?.get?.() ?? config?.skillResult ?? null,
        serverMigration: { ...serverMigrationState },
      }
      beat(lastBeat)
    }

    if (skillsChanged) {
      reconcileSkills(ctx, skills)
        .then((result) => { lastReconcile = result })
        .catch((error) => {
          lastReconcile = { error: String(error?.message ?? error) }
          ctx.logger.error('dsh-skills-mcp-manager: skill reconciliation failed')
          ctx.logger.error(error)
        })
    }
  }

  ctx.effect(() => {
    tick()
    const timer = setInterval(tick, 2000)
    return () => {
      clearInterval(timer)
      for (const entry of agents.values()) unmount(entry.stops)
      agents.clear()
    }
  })
}
