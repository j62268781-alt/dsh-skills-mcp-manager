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
 * @module @local/dsh-skills-mcp-panel
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
import { discoverSkills } from './skills/discover.js'
import { mountedKeyOf, projectServersFor, serverMountConfig, setMountClient, workingDirectoryOf } from './project/mount.js'

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
  target: z.string().default(''),
  args: z.string().default(''),
  env: z.string().default(''),
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
    nonce: z.string().default(''),
  }).default({}).volatile(),
  /** The scan answer for the latest request. */
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
  } catch {
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
        return {
          entryId: String(entry.id),
          serverName: typeof row.serverName === 'string' ? row.serverName : '',
          transport: typeof row.transport === 'string' ? row.transport : 'streamable-http',
          target: typeof row.url === 'string' && row.url !== ''
            ? row.url
            : [typeof row.command === 'string' ? row.command : '', ...args].filter((part) => part !== '').join(' '),
          args: args.join(' '),
          env: Object.entries(envMap).map(([key, value]) => `${key}=${String(value)}`).join('\n'),
          enabled: !entry.disabled,
          phase: String(entry.fiberPhase ?? ''),
        }
      })
    return { loaderFound: true, rows }
  } catch (error) {
    return { loaderFound: true, rows: [], error: String(error?.message ?? error) }
  }
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

  /**
   * Import scan state. The panel asks for one source at a time through the
   * settings document (its only channel to the Host); the answer is written back
   * into the same document, so no editor file is ever mounted behind the user's
   * back — imports are explicit and land in the panel's own project entries.
   */
  const importState = { nonce: '', result: null }

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
  const projection = { loaderFound: null, rows: null, wrote: false, error: null }
  const rowOps = { pending: 0, applied: 0, error: null }
  /** Latest disk-skill scan, refreshed on a timer (the scan itself is async). */
  let discoveredSkills = []
  const refreshDiscovered = async (projectRoots) => {
    try {
      discoveredSkills = await discoverSkills({
        projectRoots: projectRoots.slice(0, 12),
        dshHome: resolveDshHome(),
        agentsHome: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
      })
    } catch {
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
      const spaces = configuredWorkspaces(ctx)
      const cwds = [...agents.values()].map((entry) => entry.cwd).filter((cwd) => typeof cwd === 'string' && cwd !== '')
      const currentWorkspace = cwds[0] ?? ''
      const currentProjectRoot = currentWorkspace === '' ? '' : projectRootOf(currentWorkspace)

      if (error !== undefined) projection.error = error
      const key = JSON.stringify([plain, spaces, currentWorkspace, discoveredSkills])
      if (key === published) return
      // Never erase a good projection because the Loader read came back empty.
      if (plain.length === 0 && !loaderFound) {
        projection.error = projection.error ?? 'loader unavailable'
        return
      }
      Promise.resolve(inner.settings.update('skills-mcp-panel', { profileServers: plain, workspaces: spaces, currentWorkspace, discoveredSkills }))
        .then(() => {
          published = key
          projection.wrote = true
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

    // Project MCP import: the panel posts a request, this half scans one tool's
    // project files and writes the answer back for the panel to preview.
    let seenNonce = ''
    const importTimer = setInterval(() => {
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
