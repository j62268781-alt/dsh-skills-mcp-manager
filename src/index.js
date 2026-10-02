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
})

/** Bookkeeping for the skill files this plugin owns. */
const stateFile = () => join(resolveDshHome(), 'skills-mcp-panel.state.json')

/** Nearest ancestor holding `.git` — the same project-root rule as the skill provider. */
function projectRootOf(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(dir)
    current = parent
  }
}

/** The skills directory one scope writes into. */
function scopeRoot(scope) {
  return scope === 'global' ? join(resolveDshHome(), 'skills') : join(projectRootOf(scope), '.agents', 'skills')
}

/** Frontmatter plus body, exactly what the filesystem skill provider parses. */
function renderSkill(skill) {
  const description = skill.description || skill.name
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${(skill.body || '').trim()}\n`
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8'))
  } catch {
    return { files: [] }
  }
}

/**
 * Diagnostics: every tick records what it observed and what it did, so the
 * running app can be inspected without a console. Remove once the volatile
 * config read path is proven stable.
 */
const beatFile = () => join(resolveDshHome(), 'skills-mcp-panel.heartbeat.json')

async function beat(payload) {
  try {
    await mkdir(dirname(beatFile()), { recursive: true })
    await writeFile(beatFile(), `${JSON.stringify(payload, null, 2)}\n`)
  } catch {
    // diagnostics never break the plugin
  }
}

/** Create or update every enabled skill, then delete files this plugin owned before. */
async function reconcileSkills(ctx, skills) {
  const wanted = new Map()
  for (const skill of skills) {
    if (skill.enabled === false || !skill.name) continue
    wanted.set(join(scopeRoot(skill.scope), skill.name, 'SKILL.md'), renderSkill(skill))
  }

  const previous = await readState()
  const owned = []
  const result = { wanted: [...wanted.keys()], written: [], kept: [], removed: [], failed: [] }

  for (const [path, text] of wanted) {
    try {
      const current = await readFile(path, 'utf8').catch(() => undefined)
      if (current !== text) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
        result.written.push(path)
        ctx.logger.info('skills-mcp-panel: wrote %s', path)
      } else {
        result.kept.push(path)
      }
      owned.push(path)
    } catch (error) {
      result.failed.push(`${path}: ${error?.message ?? error}`)
      ctx.logger.error('skills-mcp-panel: cannot write %s', path)
      ctx.logger.error(error)
    }
  }

  for (const path of previous.files ?? []) {
    if (wanted.has(path)) continue
    try {
      await rm(dirname(path), { recursive: true, force: true })
      result.removed.push(path)
      ctx.logger.info('skills-mcp-panel: removed %s', dirname(path))
    } catch (error) {
      result.failed.push(`${path}: ${error?.message ?? error}`)
      ctx.logger.warn('skills-mcp-panel: cannot remove %s', path)
    }
  }
  return result

  await mkdir(dirname(stateFile()), { recursive: true })
  await writeFile(stateFile(), `${JSON.stringify({ files: owned }, null, 2)}\n`)
}

/** The shipped mcp-client plugin, re-mounted per server inside this scope. */
const mcpPlugin = {
  name: mcpClient.name,
  apply: mcpClient.apply,
  inject: mcpClient.inject,
  Config: mcpClient.Config,
}

/** Stable identity of the global servers that should be mounted. */
function mountedKeyOf(servers) {
  return JSON.stringify(servers.filter((server) => server.scope === 'global' && server.enabled !== false))
}








/**
 * stdio mount config.
 *
 * `npx`-style commands prefer the harness's own runtime (`node` + `pnpx`), which
 * works regardless of the user's shell PATH and of a broken shared npm cache.
 * Anything else resolves through the login shell.
 */
function stdioMountConfig(server) {
  const raw = String(server.command ?? '')
  const args = Array.isArray(server.args) ? server.args : []
  const userEnv = parseEnv(server.env)
  const base = raw.split('/').pop() ?? ''
  const npmFamily = /^(npx|npm|pnpx|pnpm)(-cli)?(\.(js|cjs|mjs))?$/.test(base)
  // Some published servers break under pnpm's strict dependency layout
  // (ERR_PACKAGE_PATH_NOT_EXPORTED), so an entry may opt into the user's npx.
  const runtime = server.runtime === 'system' ? null : bundledRuntime()
  if (runtime !== null && npmFamily) {
    // `npx -y <pkg> …` → `<node> <pnpx.mjs> <pkg> …`
    const cleaned = args.filter((arg) => arg !== '-y' && arg !== '--yes')
    return {
      transport: 'stdio', serverName: server.serverName,
      command: runtime.node,
      args: [runtime.pnpx, ...cleaned],
      // the shims run `exec node …`, so the runtime's bin dir must be on PATH
      env: { PATH: `${runtime.binDir}:${loginPath() || '/usr/bin:/bin'}`, ...userEnv },
    }
  }
  const resolved = resolveCommand(raw)
  return {
    transport: 'stdio', serverName: server.serverName, command: resolved, args,
    env: { ...commandEnv(resolved), ...userEnv },
  }
}

/**
 * Project-level MCP config files, per tool, as those tools document them.
 *
 * Only tools that actually read a project-scoped file are listed; the rest keep
 * their MCP servers in user-level config, which is out of scope for this import.
 */
const IMPORT_SOURCES = [
  { id: 'claude', label: 'Claude', project: ['.mcp.json'], global: ['~/.claude.json'], keys: ['mcpServers'] },
  { id: 'codex', label: 'Codex', project: ['.codex/config.toml'], global: ['~/.codex/config.toml'], keys: [], supported: false },
  { id: 'chatgpt', label: 'ChatGPT', project: [], global: [], keys: [] },
  { id: 'cursor', label: 'Cursor', project: ['.cursor/mcp.json'], global: ['~/.cursor/mcp.json'], keys: ['mcpServers'] },
  { id: 'gemini', label: 'Gemini CLI', project: ['.gemini/settings.json'], global: ['~/.gemini/settings.json'], keys: ['mcpServers'] },
  { id: 'antigravity', label: 'Google Antigravity', project: ['.antigravity/mcp.json'], global: [], keys: ['mcpServers'] },
  { id: 'reasonix', label: 'Reasonix', project: [], global: [], keys: [] },
  { id: 'opencode', label: 'opencode', project: ['opencode.json'], global: ['~/.config/opencode/opencode.json'], keys: ['mcp'], shape: 'opencode' },
  { id: 'mimocode', label: 'MimoCode', project: ['.mimo/mcp.json'], global: [], keys: ['mcpServers'] },
  { id: 'teleagent', label: 'TeleAgent', project: [], global: [], keys: [] },
  { id: 'kilo', label: 'Kilo Code', project: [], global: [], keys: ['mcpServers'] },
  { id: 'zcode', label: 'ZCode', project: [], global: [], keys: [] },
  { id: 'grok', label: 'Grok', project: [], global: [], keys: [] },
  { id: 'openclaw', label: 'OpenClaw', project: [], global: [], keys: [] },
  { id: 'pi', label: 'Pi', project: [], global: [], keys: [] },
  { id: 'hermes', label: 'Hermes', project: [], global: [], keys: [] },
  { id: 'kimi', label: 'KIMI', project: ['.kimi/mcp.json'], global: ['~/.kimi/mcp.json'], keys: ['mcpServers'] },
  { id: 'qoder', label: 'Qoder', project: ['.qoder/mcp.json'], global: ['~/.qoder/mcp.json'], keys: ['mcpServers'] },
  { id: 'workbuddy', label: 'WorkBuddy', project: [], global: [], keys: [] },
  { id: 'qwen', label: 'Qwen', project: ['.qwen/settings.json'], global: ['~/.qwen/settings.json'], keys: ['mcpServers'] },
  { id: 'continue', label: 'Continue', project: ['.continue/config.json'], global: ['~/.continue/config.json'], keys: ['mcpServers'] },
  { id: 'cline', label: 'Cline', project: [], global: [], keys: ['mcpServers'] },
  { id: 'goose', label: 'goose', project: [], global: ['~/.config/goose/config.yaml'], keys: [], supported: false },
  { id: 'zed', label: 'Zed', project: ['.zed/settings.json'], global: ['~/.config/zed/settings.json'], keys: ['context_servers'], shape: 'zed' },
  { id: 'crush', label: 'Crush', project: ['crush.json', '.crush.json'], global: ['~/.config/crush/crush.json'], keys: ['mcp'] },
  { id: 'vscode', label: 'VS Code', project: ['.vscode/mcp.json'], global: ['~/Library/Application Support/Code/User/mcp.json'], keys: ['servers', 'mcpServers'] },
]

/** Absolute path for a source entry: `~/…` is user-level, otherwise project-relative. */
function importFilePath(relative, project) {
  return relative.startsWith('~/') ? join(homedir(), relative.slice(2)) : join(project, relative)
}

/** JSON.parse that tolerates the comments/trailing commas editors allow. */
function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(cleaned)
}

/** HTTP headers record -> the panel's KEY=VALUE lines. */
function headerLines(headers) {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return ''
  return Object.entries(headers).map(([key, value]) => `${key}=${String(value)}`).join('\n')
}

/** Env record -> the panel's KEY=VALUE lines. */
function envLines(env) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return ''
  return Object.entries(env).map(([key, value]) => `${key}=${String(value)}`).join('\n')
}

/** One tool's entry -> the panel's server shape, or null when unsupported. */
function adaptImportedEntry(name, spec, shape) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return null
  if (shape === 'zed') {
    const command = spec.command
    if (typeof command === 'string') {
      return { serverName: name, transport: 'stdio', command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], env: envLines(spec.env), url: '', headers: '' }
    }
    if (command !== null && typeof command === 'object' && typeof command.path === 'string') {
      return { serverName: name, transport: 'stdio', command: command.path, args: Array.isArray(command.args) ? command.args.map(String) : [], env: envLines(command.env), url: '', headers: '' }
    }
    if (typeof spec.url === 'string' && spec.url !== '') {
      return { serverName: name, transport: 'streamable-http', url: spec.url, headers: headerLines(spec.headers), command: '', args: [], env: '' }
    }
    return null
  }
  if (shape === 'opencode') {
    if (Array.isArray(spec.command) && spec.command.length > 0) {
      const [command, ...args] = spec.command.map(String)
      return { serverName: name, transport: 'stdio', command, args, env: envLines(spec.environment ?? spec.env), url: '', headers: '' }
    }
    if (typeof spec.url === 'string' && spec.url !== '') {
      return { serverName: name, transport: 'streamable-http', url: spec.url, headers: headerLines(spec.headers), command: '', args: [], env: '' }
    }
    return null
  }
  if (typeof spec.url === 'string' && spec.url !== '') {
    return { serverName: name, transport: 'streamable-http', url: spec.url, headers: headerLines(spec.headers), command: '', args: [], env: '' }
  }
  if (typeof spec.command === 'string' && spec.command !== '') {
    return { serverName: name, transport: 'stdio', command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], env: envLines(spec.env), url: '', headers: '' }
  }
  return null
}

/**
 * Scan one tool's project files. Returns what exists, what parsed, what the
 * panel would import (as project-scoped panel entries) and why anything failed.
 */
function scanImportSource(scope, project, sourceId) {
  const source = IMPORT_SOURCES.find((item) => item.id === sourceId)
  if (source === undefined) return { files: [], servers: [], error: `unknown import source "${sourceId}"` }
  const paths = (scope === 'global' ? source.global : source.project) ?? []
  if (paths.length === 0) return { files: [], servers: [], error: `${source.label} 目前没有已知的${scope === 'global' ? '用户级' : '项目级'} MCP 配置文件（该工具把 MCP 配置放在别处或仅支持全局）` }
  if (source.supported === false) return { files: paths.map((path) => ({ path, exists: existsSync(importFilePath(path, project)), servers: [], unsupported: 0, error: '' })), servers: [], error: `${source.label} 目前只有 TOML 配置，暂不支持自动导入` }
  const files = []
  const servers = []
  const taken = new Set()
  for (const relative of paths) {
    const file = importFilePath(relative, project)
    const report = { path: relative, exists: existsSync(file), servers: [], unsupported: 0, error: '' }
    if (report.exists) {
      try {
        const document = parseJsonLoose(readFileSync(file, 'utf8'))
        for (const key of source.keys) {
          const table = document?.[key]
          if (table === null || typeof table !== 'object' || Array.isArray(table)) continue
          for (const [name, spec] of Object.entries(table)) {
            const adapted = adaptImportedEntry(name, spec, source.shape ?? 'default')
            if (adapted === null || !/^[A-Za-z0-9_-]{1,32}$/.test(adapted.serverName) || taken.has(adapted.serverName)) {
              report.unsupported += 1
              continue
            }
            taken.add(adapted.serverName)
            report.servers.push(adapted.serverName)
            servers.push({
              scope: scope === 'global' ? 'global' : project,
              id: adapted.serverName, serverName: adapted.serverName,
              enabled: true, runtime: 'auto',
              source: relative, transport: adapted.transport, url: adapted.url, command: adapted.command,
              args: adapted.args, env: adapted.env, headers: adapted.headers,
            })
          }
        }
      } catch (error) {
        report.error = String(error?.message ?? error)
      }
    }
    files.push(report)
  }
  return { files, servers }
}

/** Translate one panel entry into the shipped mcp-client config, or null when unusable. */
function serverMountConfig(server) {
  if (!server?.serverName) return null
  const mountConfig = server.transport === 'stdio'
    ? stdioMountConfig(server)
    : {
        transport: 'streamable-http', serverName: server.serverName, url: server.url,
        headers: parseEnv(server.headers),
      }
  const missing = mountConfig.transport === 'stdio' ? !mountConfig.command : !mountConfig.url
  return missing ? null : mountConfig
}

/** The agent's working directory, tolerating the Session shapes in play. */
function workingDirectoryOf(agent) {
  const session = agent?.session
  return session?.cwd ?? session?.header?.cwd ?? agent?.cwd ?? agent?.options?.cwd ?? null
}

/**
 * Project-scoped servers that apply to a working directory.
 *
 * A configured project scope is matched as a directory prefix, so a session
 * started anywhere inside the project — not only at its root — gets the servers.
 */
function projectServersFor(servers, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return []
  return servers.filter((server) => {
    const scope = server.scope
    if (!scope || scope === 'global' || server.enabled === false) return false
    const base = scope.replace(/\/+$/, '')
    return cwd === base || cwd.startsWith(`${base}/`)
  })
}
















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
  ctx.inject(['settings'], (inner) => {
    // Seed from the value already stored in this namespace: a recomposition must
    // not re-write identical rows, or the write would trigger the next reload.
    const stored = config?.profileServers?.get?.() ?? config?.profileServers
    const storedSpaces = config?.workspaces?.get?.() ?? config?.workspaces
    let published = JSON.stringify([Array.isArray(stored) ? stored : [], Array.isArray(storedSpaces) ? storedSpaces : []])
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

      if (error !== undefined) projection.error = error
      const key = JSON.stringify([plain, spaces, currentWorkspace])
      if (key === published) return
      // Never erase a good projection because the Loader read came back empty.
      if (plain.length === 0 && !loaderFound) {
        projection.error = projection.error ?? 'loader unavailable'
        return
      }
      Promise.resolve(inner.settings.update('skills-mcp-panel', { profileServers: plain, workspaces: spaces, currentWorkspace }))
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
