/**
 * The one place MCP servers come from: the profile patch's `mcp-client` rows.
 *
 * ## Why this module exists
 *
 * The plugin used to keep two kinds of configuration in two different places:
 *
 *   · **global** servers were written as `mcp-client` rows in the profile patch and let
 *     the Loader connect them;
 *   · **project** servers were written into this plugin's own `config.servers` field, and
 *     mounted by hand at runtime.
 *
 * Same feature, two storage formats, two lifecycles, two code paths — and the panel had to
 * merge two arrays to render one list. That asymmetry produced a stream of confusing
 * behaviour: project tools invisible to a scope-less registry read, a `serverStatus` that
 * had to special-case them, and a config field whose contents looked nothing like the rows
 * next to it in the same file.
 *
 * Both tiers are rows now. A row's `scope` says where it belongs, and that is the *only*
 * difference between the tiers:
 *
 *   scope: 'global' (or absent)  →  the Loader connects it; every agent sees the tools
 *   scope: '/abs/project/path'   →  this plugin mounts it into a matching agent's scope
 *
 * ## Why project rows are still mounted by this plugin
 *
 * A patch row is static: the Loader instantiates it once at load, and `!!js` expressions
 * are evaluated against the *Loader's* context, which has no notion of an agent or a
 * working directory (verified: `disabledOf()` → `evaluate(this.ctx, …)`, once, at load).
 * So no row can decide "only load me for the agent sitting in /work/api". Making a project
 * server apply exactly when someone opens a session in that project therefore needs a
 * runtime orchestrator — which is this plugin's actual job, not a workaround.
 *
 * ## On `scope` in the row's config
 *
 * `dsh-mcp-client`'s `Config` is a strict union that does **not** list `scope`, so the
 * first question was whether the key survives. It does: zod drops unknown keys only in
 * `.strict()` mode, and this schema is not strict — verified directly against the shipped
 * schema, where `Config({…base, scope: '/p'}).scope === '/p'`. `Config` also parses from a
 * *copy*, so the original `options.config` we read here keeps every key regardless.
 *
 * Pure: rows in, servers out. No cordis, no IO, so the two-tier rules are testable.
 *
 * @module dsh-skills-mcp-manager/mcp/serverRows
 */

/**
 * Whether the **user** wants this server on.
 *
 * `disabled` means two different things depending on the tier, and conflating them makes a
 * project server either unreachable or connected twice:
 *
 *   disabled + global scope   →  the user switched this server off   →  off
 *   disabled + project scope  →  "Loader, do not instantiate this row"  →  still on
 *
 * A project row *must* carry `disabled` for the Loader, because this plugin mounts it into
 * the matching agent instead — so `disabled` cannot also be the user's switch there. A
 * project row keeps its own `enabled` flag inside the config for that.
 */
function userEnabled(row, entry, scope) {
  return scope === GLOBAL_SCOPE ? entry?.disabled !== true : row.enabled !== false
}

/** The scope value that means "every agent". */
export const GLOBAL_SCOPE = 'global'

/**
 * One row's config reduced to the shape the rest of the plugin works with.
 *
 * `entryId` is the Loader entry id: it is what a row op targets, and the panel shows it
 * when a server name alone would be ambiguous.
 */
export function serverFromRow(entry) {
  const row = entry?.options?.config ?? {}
  const args = Array.isArray(row.args) ? row.args.map((value) => String(value)) : []
  const env = row.env !== null && typeof row.env === 'object' && !Array.isArray(row.env) ? row.env : {}
  const headers = row.headers !== null && typeof row.headers === 'object' && !Array.isArray(row.headers) ? row.headers : {}
  const scope = typeof row.scope === 'string' && row.scope !== '' ? row.scope : GLOBAL_SCOPE
  const transport = typeof row.transport === 'string' && row.transport !== '' ? row.transport : 'streamable-http'
  const url = typeof row.url === 'string' ? row.url : ''
  const command = typeof row.command === 'string' ? row.command : ''
  return {
    entryId: String(entry?.id ?? ''),
    id: String(entry?.id ?? ''),
    serverName: typeof row.serverName === 'string' ? row.serverName : '',
    scope,
    transport,
    url,
    command,
    args,
    env,
    headers,
    // The card shows one "target" line; stdio merges command and args.
    target: url !== '' ? url : [command, ...args].filter((part) => part !== '').join(' '),
    failOnStartupError: row.failOnStartupError === true,
    reconnect: row.reconnect ?? null,
    enabled: userEnabled(row, entry, scope),
    phase: phaseOf(entry),
    /** True for rows the Loader connects itself (global scope). */
    loaderManaged: scope === GLOBAL_SCOPE,
  }
}

/**
 * The phase the Loader reports for an entry.
 *
 * `fiber.state` is the authoritative value (`dsh-host-plugin-inventory` derives its
 * `fiberPhase` from it); reading a `fiberPhase` property off a raw entry yields `''`
 * forever, which is why the panel used to be unable to tell "connected with no tools" from
 * "never loaded".
 */
export function phaseOf(entry) {
  const state = entry?.fiber?.state
  if (state === undefined || state === null) return ''
  return state === 2 ? 'active' : state === 1 ? 'loading' : 'failed'
}

/**
 * Every MCP row the profile configures, both tiers, in a stable order.
 *
 * Grouped entries (`options.group !== undefined`) are skipped: they exist for patch
 * indexing, not as servers.
 */
export function serverRows(ctxLoaderEntries) {
  // Accept any iterable, not just an array. `loader.entries()` is a **generator**, and
  // requiring an array here meant a caller who forgot to spread got an empty server list
  // with no error at all — the panel simply showed nothing configured. An empty result is
  // far too quiet a failure mode for a function whose whole job is "what is configured".
  const entries = ctxLoaderEntries === null || ctxLoaderEntries === undefined
    ? []
    : Array.isArray(ctxLoaderEntries)
      ? ctxLoaderEntries
      : typeof ctxLoaderEntries?.[Symbol.iterator] === 'function'
        ? [...ctxLoaderEntries]
        : []
  return entries
    .filter((entry) => entry?.options?.name === '@deepseek-ai/dsh-mcp-client' && entry.options.group === undefined)
    .map(serverFromRow)
    .filter((server) => server.serverName !== '')
    .sort((left, right) => left.serverName.localeCompare(right.serverName))
}

/** Whether a project scope covers a working directory (a scope is a directory prefix). */
export function scopeCovers(scope, cwd) {
  if (typeof scope !== 'string' || scope === '' || scope === GLOBAL_SCOPE) return false
  if (typeof cwd !== 'string' || cwd === '') return false
  const base = scope.replace(/\/+$/, '')
  return cwd === base || cwd.startsWith(`${base}/`)
}

/**
 * The project servers that apply to one working directory.
 *
 * Unchanged in substance from the version that read `config.servers` — only its input
 * moved from a plugin field to the rows — because the matching rule was never the problem.
 */
export function projectServersFor(servers, cwd) {
  return (Array.isArray(servers) ? servers : []).filter((server) => (
    server.enabled !== false && scopeCovers(server.scope, cwd)
  ))
}

/**
 * The servers the Loader connects on its own: global scope and enabled.
 *
 * Everything else is either project-scoped (mounted per agent) or disabled (kept for its
 * configuration, deliberately not connected).
 */
export function loaderManagedServers(servers) {
  return (Array.isArray(servers) ? servers : []).filter((server) => (
    server.loaderManaged === true && server.enabled !== false
  ))
}

/**
 * Whether two configurations describe the same set of servers.
 *
 * Used to decide whether a mount pass is needed at all. Deliberately ignores `phase`, which
 * the Loader updates on its own schedule: a phase change is not a reason to tear down and
 * rebuild a working connection.
 */
export function serverSetKey(servers) {
  return JSON.stringify((Array.isArray(servers) ? servers : []).map((server) => ({
    entryId: server.entryId,
    serverName: server.serverName,
    scope: server.scope,
    transport: server.transport,
    target: server.target,
    env: server.env,
    headers: server.headers,
    failOnStartupError: server.failOnStartupError,
    reconnect: server.reconnect,
    enabled: server.enabled,
  })))
}
