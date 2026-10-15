/**
 * Project-level MCP: which servers belong to a working directory, and how they
 * are mounted into an agent's scope.
 *
 * The MCP client itself is injected (`setMountClient`) so scope matching and the
 * mount config shapes can be unit-tested without the app runtime.
 */
import { join } from 'node:path'
import { bundledRuntime, commandEnv, loginPath, parseEnv, resolveCommand } from '../runtime/env.js'
import { connectionFields } from '../mcp/connection.js'

/** The host MCP client (name + scope mount entry points). */
let client = { name: '@deepseek-ai/dsh-mcp-client' }

/** Inject the host's mcp-client module. */
export function setMountClient(next) {
  client = { ...client, ...next }
}

export function mountedKeyOf(servers) {
  return JSON.stringify(servers.filter((server) => server.scope === 'global' && server.enabled !== false))
}
/**
 * A mount field (`env` / `headers`) as a plain object, whichever shape it arrives in.
 *
 * The two callers hand this module **different** shapes, and assuming one silently dropped the
 * other:
 *
 *   · `serverRows()` produces an already-parsed **object** (`config.env` straight off the row),
 *     which is what the real mount path passes in;
 *   · the panel draft / import path produces `KEY=VALUE` **lines**.
 *
 * `parseEnv({JAVA_HOME: '/jdk'})` returns `{}` — `String(object)` is `"[object Object]"`, which
 * has no `=`, so every line is skipped. That is how issue #2 happened: a project-scoped stdio
 * row's `JAVA_HOME` / `GHIDRA_INSTALL_DIR` never reached the child process, with no error
 * anywhere, while the same values worked on 0.5.4's `config.servers[]` path (which passed
 * strings). Accept both instead of picking one.
 *
 * A `null`/absent value is `{}` either way. Non-string scalars are stringified the same way the
 * YAML reader would, so a numeric value does not become `"[object Object]"`-style garbage.
 */
export function envObject(value) {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string') return parseEnv(value)
  if (typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key === '') continue
    if (raw === null || raw === undefined) continue
    out[key] = typeof raw === 'string' ? raw : String(raw)
  }
  return out
}

/**
 * stdio mount config.
 *
 * `npx`-style commands prefer the harness's own runtime (`node` + `pnpx`), which
 * works regardless of the user's shell PATH and of a broken shared npm cache.
 * Anything else resolves through the login shell.
 */
export function stdioMountConfig(server) {
  const raw = String(server.command ?? '')
  const args = Array.isArray(server.args) ? server.args : []
  const userEnv = envObject(server.env)
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
export function serverMountConfig(server) {
  if (!server?.serverName) return null
  const mountConfig = server.transport === 'stdio'
    ? stdioMountConfig(server)
    : {
        transport: 'streamable-http', serverName: server.serverName, url: server.url,
        // Same shape problem as `env` above — and here the stakes are an Authorization header
        // silently going missing, which shows up as 「需要授权」 on a server whose row carries
        // the credential.
        headers: envObject(server.headers),
      }
  const missing = mountConfig.transport === 'stdio' ? !mountConfig.command : !mountConfig.url
  if (missing) return null
  try {
    // failOnStartupError + reconnect.* ride along, so a mounted server reconnects
    // exactly like a configured row.
    return { ...mountConfig, ...connectionFields(server) }
  } catch {
    // A malformed number must never take the mount (or the reconcile loop) down:
    // the client's own defaults apply and the panel reports the field itself.
    return mountConfig
  }
}
/** The agent's working directory, tolerating the Session shapes in play. */
export function workingDirectoryOf(agent) {
  const session = agent?.session
  return session?.cwd ?? session?.header?.cwd ?? agent?.cwd ?? agent?.options?.cwd ?? null
}
/**
 * Project-scoped servers that apply to a working directory.
 *
 * A configured project scope is matched as a directory prefix, so a session
 * started anywhere inside the project — not only at its root — gets the servers.
 */
export function projectServersFor(servers, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return []
  return servers.filter((server) => {
    const scope = server.scope
    if (!scope || scope === 'global' || server.enabled === false) return false
    const base = scope.replace(/\/+$/, '')
    return cwd === base || cwd.startsWith(`${base}/`)
  })
}
