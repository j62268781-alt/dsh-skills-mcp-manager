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
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { commandEnv, parseEnv, resolveCommand, setHomeResolver, spawnEnv, splitArgs } from './runtime/env.js'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { applyRowOp, setPatchIO } from './patch/apply.js'
import { IMPORT_SOURCES, adaptImportedEntry, envLines, headerLines, importFilePath, parseJsonLoose } from './import/sources.js'
import { scanImportSource } from './import/scan.js'
import { beat, beatFile } from './diagnostics/heartbeat.js'
import { projectRootOf, reconcileSkills, scopeRoot } from './skills/reconcile.js'
import { bodyOf, discoverSkills } from './skills/discover.js'
import { createSkill, deleteSkill, renameSkill, updateSkill, writableRoots } from './skills/write.js'
import { mountedKeyOf, projectServersFor, serverMountConfig, setMountClient, workingDirectoryOf } from './project/mount.js'
import { connectionDraftOf } from './mcp/connection.js'
import { toolsByServer } from './mcp/tools.js'
import { installShadow, isMcpName, judge, liveToolNames } from './mcp/filter.js'
import { installConnectionWatch } from './mcp/watch.js'
import { SERVER_STATUS, deriveStatus, reconnectBudgetMs, remainingSeconds } from './mcp/status.js'

setMountClient(mcpClient)

setPatchIO({ withFileLock, writeFileAtomic })
import { isMap, isSeq, parseDocument } from 'yaml'

export const name = 'skills-mcp-panel'

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
  enabled: z.boolean().default(true),
})

/** One skill the panel writes to disk. */
const Skill = z.object({
  scope: z.string().default('global'),
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
})

setHomeResolver(resolveDshHome)

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
  skillRequest: z.object({
    op: z.string().default(''),
    scope: z.string().default(''),
    id: z.string().default(''),
    project: z.string().default(''),
    name: z.string().default(''),
    prevName: z.string().default(''),
    description: z.string().default(''),
    body: z.string().default(''),
    nonce: z.string().default(''),
  }).default({}).volatile(),
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
   * 每个已配置 MCP 服务器当前注册到 harness 的工具清单。
   *
   * 数据源是 harness 自己的工具注册表（`ctx.tools.schemas()`）：MCP 客户端把工具
   * 以 `mcp__<serverName>__<tool>` 的名字注册进去，所以这里按前缀归到各自的服务器。
   * 面板只读展示，不参与任何写回。
   */
  serverTools: z.array(z.object({
    serverName: z.string().default(''),
    tools: z.array(z.object({
      name: z.string().default(''),
      description: z.string().default(''),
    })).default([]),
  })).default([]).volatile(),
  /**
   * 工具清单读不到时的原因（空串 = 读取正常）。
   *
   * 单独一个字段是必要的：「注册表读不到」与「该服务器没有工具」在界面上长得一样，
   * 但前者可操作（重启 / 排查冲突），后者只是一个事实。只有列表的话两者无法区分。
   */
  serverToolsError: z.object({
    reason: z.string().default(''),
    detail: z.string().default(''),
  }).default({ reason: '', detail: '' }).volatile(),
  /**
   * 每个 MCP 服务器的连接状态，供面板打告警标签。
   *
   * 为什么要发布这个：`dsh-mcp-client` 在重试预算用尽后会**永久放弃**
   * （"giving up after N consecutive failed reconnect attempts — reload the plugin or
   * restart the Host to reconnect"），而这件事在界面上原本**完全不可见** —— 用户只
   * 看到工具没了，不知道是没连上、正在重试、还是已经放弃。实测一个启动时连不上的
   * deepwiki 就是这样静默失效 15 分钟以上的。
   *
   * `status` 是**推导**值（客户端把重试计数关在闭包里，见 `src/mcp/status.js`），
   * 所以带 `remainingMs` 这类预计量，界面措辞也必须说成「预计」。
   */
  serverStatus: z.array(z.object({
    serverName: z.string().default(''),
    /** `global`（Loader 行）或 `project`（本插件挂载）。 */
    tier: z.string().default(''),
    scope: z.string().default(''),
    status: z.string().default(''),
    toolCount: z.number().default(0),
    /** 从首次观测到「未连接」起已过去多久。 */
    elapsedMs: z.number().default(0),
    /** 该服务器配置下的重试预算总长。 */
    budgetMs: z.number().default(0),
    /** 按预算预计还能重试多久（秒）；仅 `retrying` 有意义。 */
    remainingSeconds: z.number().default(0),
    detail: z.string().default(''),
  })).default([]).volatile(),
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
  watchState: z.object({
    installed: z.boolean().default(false),
    reason: z.string().default(''),
    instances: z.array(z.string()).default([]),
  }).default({ installed: false, reason: '', instances: [] }).volatile(),
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
    if (process.env.SMP_DEBUG) console.error('[skills-mcp-panel] workspace registry unavailable', error)
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

function configuredMcpRows(ctx) {
  const loader = loaderOf(ctx)
  if (loader === null || typeof loader.entries !== 'function') return { loaderFound: false, rows: [] }
  try {
    const rows = [...(loader.entries() ?? [])]
      .filter((entry) => entry?.options?.name === '@deepseek-ai/dsh-mcp-client' && entry.options.group === undefined)
      .map((entry) => {
        const row = entry.options.config ?? {}
        const args = Array.isArray(row.args) ? row.args.map((arg) => String(arg)) : []
        const envMap = row.env !== null && typeof row.env === 'object' && !Array.isArray(row.env) ? row.env : {}
        // http 行的鉴权头：面板要能回填，否则一次「只改 URL」的保存会把已配好的
        // Authorization 静默删掉（与 env 同理）。按 KEY=VALUE 交给表单。
        const headersMap = row.headers !== null && typeof row.headers === 'object' && !Array.isArray(row.headers) ? row.headers : {}
        return {
          entryId: String(entry.id),
          serverName: typeof row.serverName === 'string' ? row.serverName : '',
          transport: typeof row.transport === 'string' ? row.transport : 'streamable-http',
          target: typeof row.url === 'string' && row.url !== ''
            ? row.url
            : [typeof row.command === 'string' ? row.command : '', ...args].filter((part) => part !== '').join(' '),
          command: typeof row.command === 'string' ? row.command : '',
          args: args.join(' '),
          env: Object.entries(envMap).map(([key, value]) => `${key}=${String(value)}`).join('\n'),
          headersText: Object.entries(headersMap).map(([key, value]) => `${key}=${String(value)}`).join('\n'),
          // Connection policy travels with the row so 编辑 can show what is set.
          ...connectionDraftOf(row),
          enabled: !entry.disabled,
          phase: phaseOf(entry),
        }
      })
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
  const readServers = () => config?.servers?.get?.() ?? config?.servers ?? []
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
    ctx.logger.info('skills-mcp-panel: MCP tool filter installed (%d pre-existing MCP tool(s))', filterState.preExisting.length)
  } else {
    // Reported, never swallowed: "filtering is off" and "filtering could not be
    // installed" look identical in the UI otherwise, and only one of them is the
    // user's configuration.
    ctx.logger.warn('skills-mcp-panel: MCP tool filter not installed — %s', shadow.reason)
  }
  ctx.effect(() => () => shadow.restore(), 'skills-mcp-panel.tool-filter')

  /**
   * Connection watch, installed next to the filter and for the same ordering
   * reason: `dsh-mcp-client` publishes its connection to `mcpResources` while it
   * starts, so the shadow has to be in place before the first MCP row loads.
   *
   * This is what lets the panel warn about a server that quietly died. The client
   * gives up permanently once its retry budget runs out, and until now that was
   * invisible: the tools simply disappeared and nothing said whether the server was
   * still retrying or already dead.
   */
  const watch = installConnectionWatch(ctx, { warn: (message) => ctx.logger.warn(message) })
  ctx.effect(() => () => watch.restore(), 'skills-mcp-panel.connection-watch')
  if (!watch.installed) {
    // Reported, never swallowed: "no server is down" and "we cannot tell" must not
    // look the same, or the status tag would show a confident lie.
    ctx.logger.warn('skills-mcp-panel: MCP connection watch not installed — %s', watch.reason)
  }

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
   * Ask a server whether it is connected, at most once per TTL.
   *
   * Fire-and-forget on purpose: `publish` is synchronous and must not await a
   * remote round-trip. The tag renders from the last known answer, which is at most
   * one TTL stale — a few seconds on a status label nobody needs to the millisecond.
   */
  const refreshProbe = (serverName) => {
    if (!watch.installed) return
    const cached = probeCache.get(serverName)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return
    if (probing.has(serverName)) return
    probing.add(serverName)
    Promise.resolve(watch.probe(serverName))
      .then((result) => {
        probeCache.set(serverName, { at: Date.now(), state: result.state, detail: result.detail })
      })
      .catch((error) => {
        probeCache.set(serverName, { at: Date.now(), state: 'unknown', detail: String(error?.message ?? error) })
      })
      .finally(() => probing.delete(serverName))
  }

  const probeStateOf = (serverName) => {
    if (!watch.has(serverName)) return { connected: false, known: watch.installed }
    const cached = probeCache.get(serverName)
    if (!watch.installed || cached === undefined) return { connected: null, known: watch.installed }
    if (cached.state === 'connected') return { connected: true, known: true }
    if (cached.state === 'down') return { connected: false, known: true }
    return { connected: null, known: false }
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
    const expected = new Set()
    for (const entry of agents.values()) {
      if (typeof entry.cwd !== 'string' || entry.cwd === '') continue
      for (const server of projectServersFor(committedServers, entry.cwd)) {
        if (server.enabled !== false && typeof server.serverName === 'string') expected.add(server.serverName)
      }
    }
    const targets = [
      ...rows.map((row) => ({
        tier: 'global', scope: '', serverName: String(row.serverName ?? ''),
        enabled: row.enabled !== false, expected: true, source: row,
        // The Loader's own verdict, which is what makes "activation failed" a fact
        // rather than an inference. See deriveStatus.
        phase: String(row.phase ?? ''),
      })),
      ...entries.map((entry) => ({
        tier: 'project', scope: String(entry.scope ?? ''), serverName: String(entry.serverName ?? ''),
        enabled: entry.enabled !== false,
        expected: expected.has(entry.serverName),
        source: entry,
        phase: mountedPhaseOf(String(entry.serverName ?? '')),
      })),
    ]
    const reported = []
    const seen = new Set()
    for (const target of targets) {
      if (target.serverName === '') continue
      const key = `${target.tier}\u0000${target.scope}\u0000${target.serverName}`
      if (seen.has(key)) continue
      seen.add(key)
      const hasInstance = watch.has(target.serverName)
      const probe = probeStateOf(target.serverName)
      const toolCount = toolCounts.get(target.serverName) ?? 0
      const connected = target.tier === 'global' && toolCount > 0 ? true : probe.connected
      if (connected !== true) refreshProbe(target.serverName)
      if (connected === true) {
        downSince.delete(target.serverName)
      } else if (!downSince.has(target.serverName)) {
        downSince.set(target.serverName, now)
      }
      const elapsedMs = connected === true ? 0 : Math.max(0, now - (downSince.get(target.serverName) ?? now))
      const budgetMs = reconnectBudgetMs(target.source)
      const status = deriveStatus({
        enabled: target.enabled,
        expected: target.expected,
        observed: watch.installed,
        phase: target.phase,
        hasInstance,
        connected,
        elapsedMs,
        budgetMs,
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
        // Only carry a detail that explains a non-connected verdict; a healthy server
        // that merely refuses `resources/list` must not look like a problem.
        detail: status === SERVER_STATUS.connected ? '' : String(cached?.detail ?? ''),
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

  let stops = []
  let mountedKey = null
  let committedServers = []
  let committedServersKey = null
  let skillsKey = null
  /** Live agents, with the project servers mounted into each one's scope. */
  const agents = new Map()

  /** Mount one server into `host`, appending its disposer to `sink`. */
  const mountInto = (host, server, sink, where) => {
    const mountConfig = serverMountConfig(server)
    if (mountConfig === null) {
      ctx.logger.warn('skills-mcp-panel: server %s has no name/%s, skipped', server.id, server.transport === 'stdio' ? 'command' : 'url')
      return false
    }
    try {
      const fiber = host.plugin(mcpPlugin, mountConfig)
      recordMount(server.serverName, fiber)
      sink.push(typeof fiber === 'function' ? fiber : () => fiber?.dispose?.())
      ctx.logger.info('skills-mcp-panel: mounted mcp server %s (%s) in %s', server.serverName, mountConfig.transport, where)
      return true
    } catch (error) {
      ctx.logger.error('skills-mcp-panel: cannot mount mcp server %s in %s', server.serverName, where)
      ctx.logger.error(error)
      return false
    }
  }

  const unmount = (sink) => {
    for (const stop of sink.reverse()) {
      try {
        stop()
      } catch (error) {
        ctx.logger.warn('skills-mcp-panel: unmount failed')
        ctx.logger.warn(error)
      }
    }
    sink.length = 0
  }

  /** Global tier: the root scope, so every agent inherits the tools. */
  const mountGlobal = (servers) => {
    unmount(stops)
    const root = ctx.root && ctx.root !== ctx ? ctx.root : ctx
    for (const server of servers) {
      if (server.scope !== 'global' || server.enabled === false) continue
      mountInto(root, server, stops, 'root scope')
    }
  }

  /** Project tier: one agent's scope, re-derived whenever that agent or the config changes. */
  const mountForAgent = (agent, entry) => {
    const desired = projectServersFor(committedServers, entry.cwd)
    const key = JSON.stringify(desired)
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
        agentsHome: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
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
      if (process.env.SMP_DEBUG) console.error('[skills-mcp-panel] skill scan failed', error)
      discoveredSkills = []
    }
  }

  ctx.inject(['settings'], (inner) => {
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

    const publish = () => {
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
        userAgents: join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills'),
      }
      // Live tool inventory, keyed by serverName. A failure carries its reason so
      // the panel can say *why* it is unknown instead of showing a bare "unreadable"
      // — "the registry is missing" is actionable, "this server has no tools" is not
      // a failure at all, and the two must never look the same.
      const entries = readServers()
      const inventory = toolsByServer(ctx, plain.map((row) => row.serverName))
      const serverTools = inventory.ok ? inventory.servers : []
      const serverToolsError = inventory.ok
        ? { reason: '', detail: '' }
        : { reason: String(inventory.reason ?? ''), detail: String(inventory.detail ?? '') }
      if (!inventory.ok) {
        projection.toolsError = `${serverToolsError.reason}${serverToolsError.detail === '' ? '' : `: ${serverToolsError.detail}`}`
      } else {
        projection.toolsError = null
      }
      const toolCounts = new Map(serverTools.map((entry) => [entry.serverName, entry.tools.length]))
      const serverStatus = computeServerStatus({ rows: plain, entries, toolCounts })
      // The filter may only judge servers the panel can see, so its cached name set
      // is refreshed on the same slow tick that publishes everything else.
      refreshFilterServers(readServers())
      const filterStateOut = {
        installed: filterState.installed,
        reason: filterState.reason,
        dropped: [...filterState.dropped],
        preExisting: [...filterState.preExisting],
      }
      // The watch's own health travels with the projection: "no server is down" and
      // "we cannot tell" must never render the same, and `instances` is the evidence
      // that separates a genuinely absent instance from a missed registration.
      const watchStateOut = {
        installed: watch.installed,
        reason: watch.reason,
        instances: watch.instances(),
      }
      const key = JSON.stringify([plain, serverTools, serverToolsError, serverStatus, filterStateOut, watchStateOut, spaces, currentWorkspace, discoveredSkills, skillDirs, discoveryInfo])
      if (key === published) return
      // Never erase a good projection because the Loader read came back empty.
      if (plain.length === 0 && !loaderFound) {
        projection.error = projection.error ?? 'loader unavailable'
        return
      }
      Promise.resolve(inner.settings.update('skills-mcp-panel', {
          profileServers: plain, serverTools, serverToolsError, serverStatus, filterState: filterStateOut, watchState: watchStateOut, workspaces: spaces, currentWorkspace, discoveredSkills, skillDirs, discoveryInfo,
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
          ctx.logger.warn('skills-mcp-panel: cannot publish profile rows: %s', projection.error)
        })
    }
    publish()
    // Announce the capability once per load, independently of the projection diff.
    if ((config?.rowOpsReady?.get?.() ?? config?.rowOpsReady) !== true) {
      Promise.resolve(inner.settings.update('skills-mcp-panel', { rowOpsReady: true })).catch(() => {})
    }
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
      Promise.resolve(inner.settings.update('skills-mcp-panel', { rowOps: [] }))
        .then(() => new Promise((resolve) => setTimeout(resolve, 1200)))
        .then(async () => {
          for (const op of queue) {
            try {
              await applyRowOp(ctx, op)
              rowOps.applied += 1
            } catch (error) {
              rowOps.error = String(error?.message ?? error)
              ctx.logger.warn('skills-mcp-panel: row %s failed: %s', op.op, rowOps.error)
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
          try { tick(); publish() } catch (error) { console.error('[skills-mcp-panel] post-drain refresh failed:', error) }
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

    const clearReconnectRequest = () => Promise.resolve(inner.settings.update('skills-mcp-panel', {
      reconnectRequest: { tier: '', serverName: '', scope: '', nonce: '', at: '' },
      reconnectResult: { ...reconnectResult },
    }))

    const finishReconnect = (nonce, error) => {
      reconnectResult = { nonce, ok: error === undefined, error: error === undefined ? '' : String(error) }
      if (error !== undefined) ctx.logger.warn('skills-mcp-panel: reconnect failed: %s', reconnectResult.error)
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
            ctx.logger.warn('skills-mcp-panel: post-reconnect refresh failed: %s', String(refreshError?.message ?? refreshError))
          }
        })
        .catch((writeError) => {
          ctx.logger.warn('skills-mcp-panel: cannot clear the reconnect request: %s', String(writeError?.message ?? writeError))
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
            agentsHome: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
            projectRoot: skillReq?.project === '' ? '' : projectRootOf(String(skillReq.project)),
          })
          const target = roots.find((entry) => entry.scope === skillReq?.scope && entry.id === skillReq?.id)
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
                  if (process.env.SMP_DEBUG) console.error('[skills-mcp-panel] read rescan failed', error)
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
            else if (String(skillReq?.scope ?? '') === 'project' && String(skillReq?.project ?? '') === '') {
              // Never guess: an empty project used to fall back to the cwd and wrote
              // the skill into the wrong workspace.
              result = { ok: false, reason: '未选择项目，无法写入项目级技能', name: '', body: '', nonce: skillNonce , at: new Date().toISOString() }
            }
            else if (target === undefined) {
              result = { ok: false, reason: '未知的写入区域', name: '', body: '', nonce: skillNonce , at: new Date().toISOString() }
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
              result = { ok: done.ok === true, reason: String(done.reason ?? ''), name: String(done.name ?? ''), body: '', nonce: skillNonce , at: new Date().toISOString() }
            }
            // A skill op must never throw out of here: an exception used to escape
            // the plugin load and DSH exited with "fatal load failure", taking the
            // whole app (and every other plugin) down with it.
            try {
              await Promise.resolve(inner.settings.update('skills-mcp-panel', {
                skillResult: result,
                // Clear the request in the same write so a restart cannot replay it.
                skillRequest: { op: '', scope: '', id: '', project: '', path: '', name: '', prevName: '', description: '', body: '', nonce: '' },
              }))
              // A `read` does not touch the disk, and the periodic scan already covers
              // every project. Re-scanning from the request's own roots shrank the
              // list to global-only, which made project skills vanish mid-preview.
              if (op !== 'read') {
                const projectScopes = [...new Set(discoveredSkills
                  .map((entry) => entry.scope)
                  .filter((scope) => typeof scope === 'string' && scope !== '' && scope !== 'global'))]
                await refreshDiscovered([...new Set([
                  ...roots.map((entry) => projectRootOf(entry.dir)),
                  ...projectScopes,
                ])].filter((root) => typeof root === 'string' && root !== ''))
              }
              lastOp = {
                op: String(op ?? ''), name: String(skillReq?.name ?? ''),
                nonce: String(result?.nonce ?? ''), ok: result?.ok === true,
                at: new Date().toISOString(),
              }
              // Publish immediately: waiting for the 5s publish interval was the
              // entire reason a save took ~4.6s to show up in the panel.
              try { publish() } catch (error) { console.error('[skills-mcp-panel] immediate publish failed:', error) }
            } catch (error) {
              console.error('[skills-mcp-panel] skill op failed:', error)
            }
           } catch (error) {
            console.error('[skills-mcp-panel] skill request failed:', error)
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
      Promise.resolve(inner.settings.update('skills-mcp-panel', { importResult: payload }))
        .catch((error) => ctx.logger.warn('skills-mcp-panel: import scan failed: %s', String(error?.message ?? error)))
    }, 600)
    inner.effect(() => () => clearInterval(importTimer))
  })

  let lastReconcile = null
  let pendingServersKey = null
  let pendingSkillsKey = null
  let firstTick = true

  const tick = () => {
    const servers = readServers()
    const skills = readSkills()

    // Act only on a state observed twice in a row. A Loader recomposition can
    // mount this row with a transient empty config; acting on that would
    // unmount live servers and delete skill files that are still configured.
    //
    // The debounce watches the WHOLE server list, while the global remount is
    // gated on its own key: a config holding only project servers still has to
    // commit, or agents would never receive them.
    const observedServersKey = JSON.stringify(servers)
    let serversChanged = false
    if (observedServersKey === committedServersKey) {
      pendingServersKey = null
    } else if (observedServersKey === pendingServersKey) {
      committedServers = servers
      committedServersKey = observedServersKey
      pendingServersKey = null
      serversChanged = true
      const globalKey = mountedKeyOf(servers)
      if (globalKey !== mountedKey) {
        mountGlobal(servers)
        mountedKey = globalKey
      }
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
        mounted: stops.length,
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
      }
      beat(lastBeat)
    }

    if (skillsChanged) {
      reconcileSkills(ctx, skills)
        .then((result) => { lastReconcile = result })
        .catch((error) => {
          lastReconcile = { error: String(error?.message ?? error) }
          ctx.logger.error('skills-mcp-panel: skill reconciliation failed')
          ctx.logger.error(error)
        })
    }
  }

  ctx.effect(() => {
    tick()
    const timer = setInterval(tick, 2000)
    return () => {
      clearInterval(timer)
      unmount(stops)
      for (const entry of agents.values()) unmount(entry.stops)
      agents.clear()
    }
  })
}
