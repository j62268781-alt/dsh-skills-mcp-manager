/**
 * Per-server MCP tool filtering.
 *
 * ## Why this exists here
 *
 * `@deepseek-ai/dsh-mcp-client` registers every tool a connected server lists,
 * unconditionally, and its `Config` has no allowlist field — verified against the
 * shipped zod union for both transports (`allowedTools`, `includeTools`,
 * `excludeTools`: no occurrences). The neighbouring `ctx.tools.restrict()` cannot
 * stand in: it requires a **scoped** context and throws on a global one by design
 * ("a context-global restriction would mask every agent"), and it only *masks* a
 * definition that stays registered and introspectable.
 *
 * So the only seam that keeps a tool out of the registry is `register` itself. This
 * panel is a **bundle-layer** plugin while the MCP rows live in the profile's own
 * patch, and the profile composes bundle patches first, then the profile's patches.
 * That ordering is what lets the shadow be installed before any MCP client
 * registers its first generation.
 *
 * ## What it deliberately does not do
 *
 * It never talks to a server, so it never changes what a server lists — only what
 * this process registers. It judges by name at registration only; it never inspects
 * a schema or an argument. It never throws into a registration: a name it cannot
 * judge is forwarded unchanged, because the safe direction for a filter is to leave
 * a tool it cannot place alone.
 *
 * @module dsh-skills-mcp-manager/mcp/filter
 */

/** The namespace every MCP tool's public name starts with. */
export const MCP_PREFIX = 'mcp__'

/** The separator between the server name and the raw tool name. */
export const SERVER_SEPARATOR = '__'

/** How a server's tool list is narrowed. */
export const FILTER_MODES = ['off', 'allow', 'deny']

/** Name of the setting that turns filtering into a per-agent-scoped one. */
export const MODE_OFF = 'off'
export const MODE_ALLOW = 'allow'
export const MODE_DENY = 'deny'

/** Whether a tool name is in the MCP namespace at all. */
export function isMcpName(name) {
  return typeof name === 'string' && name.startsWith(MCP_PREFIX)
}

/**
 * Attribute a public tool name to the server that owns it.
 *
 * `mcp-client` registers each tool as `mcp__<serverName>__<rawName>`, so the server
 * is recoverable from the prefix. Two servers where one name is a `__`-separated
 * extension of the other (`github` and `github__enterprise`) both prefix the same
 * name, so the **longest** matching prefix wins — the only assignment that keeps a
 * tool with the server that most specifically named it.
 *
 * @param name - a public tool name.
 * @param serverNames - candidate server names.
 * @returns the owning server name and the leaf, or `undefined` when none match.
 */
export function matchServer(name, serverNames) {
  if (!isMcpName(name) || !Array.isArray(serverNames)) return undefined
  let best
  for (const serverName of serverNames) {
    if (typeof serverName !== 'string' || serverName === '') continue
    const prefix = `${MCP_PREFIX}${serverName}${SERVER_SEPARATOR}`
    if (!name.startsWith(prefix)) continue
    const leaf = name.slice(prefix.length)
    // `mcp__github__` with nothing after it is not a tool this server listed;
    // treating it as an empty leaf would let a malformed name match a rule that
    // could never have contained it.
    if (leaf === '') continue
    if (best !== undefined && prefix.length <= best.prefixLength) continue
    best = { serverName, leaf, prefixLength: prefix.length }
  }
  if (best === undefined) return undefined
  return { serverName: best.serverName, leaf: best.leaf }
}

/**
 * The filter's validated view of one server's rule.
 *
 * `off` and an absent rule both mean "do not filter this server" — the panel keeps
 * them apart in the *config* (so a user can find the switch again) but not here.
 */
function ruleFor(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const mode = entry.mode
  if (mode !== MODE_ALLOW && mode !== MODE_DENY) return null
  const raw = Array.isArray(entry.tools) ? entry.tools : []
  const tools = raw.filter((name) => typeof name === 'string' && name !== '')
  // An allow rule with nothing selected would silently unregister every tool of
  // that server. That is a real configuration, but it is never what someone means
  // when they flip a switch and have not picked anything yet, so it is treated as
  // "not yet configured" and the server passes through untouched.
  if (mode === MODE_ALLOW && tools.length === 0) return null
  return { mode, tools: new Set(tools) }
}

/**
 * Decide whether one registration is admitted.
 *
 * Pure and total: every input yields a verdict, and every path that cannot judge
 * admits. That is the fail-open direction — a filter that drops a tool it could not
 * classify would turn its own bug into a missing capability.
 *
 * @param name - the value read off the definition (any type).
 * @param rules - the panel's per-server rules: `{ [serverName]: { mode, tools } }`.
 * @param serverNames - every configured MCP server name (needed to attribute names).
 * @returns `{ admit: true }`, or `{ admit: false, serverName, leaf, reason }`.
 */
export function judge(name, rules, serverNames) {
  if (typeof name !== 'string') return { admit: true, reason: 'unnamed' }
  if (!isMcpName(name)) return { admit: true, reason: 'not-mcp' }
  const match = matchServer(name, serverNames)
  // A name whose server this panel does not manage is left alone: the panel can
  // only speak for the servers it can see configured.
  if (match === undefined) return { admit: true, reason: 'unknown-server' }
  const rule = ruleFor(rules?.[match.serverName])
  if (rule === null) return { admit: true, reason: 'unfiltered' }
  const listed = rule.tools.has(match.leaf)
  if (rule.mode === MODE_ALLOW) {
    return listed
      ? { admit: true, reason: 'allowlisted' }
      : { admit: false, serverName: match.serverName, leaf: match.leaf, reason: 'not-allowlisted' }
  }
  return listed
    ? { admit: false, serverName: match.serverName, leaf: match.leaf, reason: 'denylisted' }
    : { admit: true, reason: 'not-denylisted' }
}

/**
 * Install the registry shadow and return its disposer.
 *
 * The shadow goes on the tool service **instance**, never on the prototype: a
 * prototype belongs to whichever copy of the package happened to be imported, and
 * a caller that reaches the registry by name lookup at call time — which
 * `syncTools` does — only sees a write to the instance.
 *
 * @param ctx - a cordis context carrying the `tools` service.
 * @param decide - maps a tool name to a verdict; called inside a guard.
 * @param log - `{ warn }`, for the paths that must be reported rather than thrown.
 * @returns `{ installed, restore, reason }`; `installed` is false when the service
 *   is absent or its `register` cannot be shadowed (a frozen or sealed provider).
 */
export function installShadow(ctx, decide, log) {
  let view = null
  try {
    view = ctx.get?.('tools') ?? null
  } catch {
    // A bare service access throws in cordis before the service is injected.
    view = null
  }
  if (view === null || typeof view.register !== 'function') {
    return { installed: false, restore: () => {}, reason: 'tools service unavailable' }
  }
  // The traceable view forwards its reads to the instance behind it; the instance
  // is where a write has to land for every other reader to see it.
  const ORIGINAL = Symbol.for('cordis.original')
  let underlying = view
  try {
    const behind = Reflect.get(view, ORIGINAL)
    if (behind !== null && typeof behind === 'object') underlying = behind
  } catch {
    // No traceable target: the view itself is the instance.
  }
  let original
  try {
    original = underlying.register
  } catch {
    return { installed: false, restore: () => {}, reason: 'register is not readable' }
  }
  if (typeof original !== 'function') {
    return { installed: false, restore: () => {}, reason: 'register is not a function' }
  }
  const hadOwn = Object.hasOwn(underlying, 'register')
  const shadowed = function (definition) {
    let verdict
    try {
      verdict = decide(definition === null || definition === undefined ? undefined : definition.name)
    } catch (error) {
      log?.warn?.(`dsh-skills-mcp-manager: could not judge a registration, forwarding it unchanged: ${String(error?.message ?? error)}`)
      verdict = { admit: true }
    }
    // The forwarded call is deliberately outside the catch above: a duplicate-name
    // or reserved-name error from the registry belongs to the registry, and
    // swallowing it would turn a real conflict into a silent no-op.
    if (verdict.admit) return original.call(this, definition)
    // The caller keeps this disposer in a map and calls it on the next sync, so it
    // must exist and must be harmless: there is nothing to undo, and throwing here
    // would take down a re-sync.
    return () => {}
  }
  let wrote = false
  try {
    wrote = Reflect.set(underlying, 'register', shadowed)
  } catch (error) {
    return { installed: false, restore: () => {}, reason: `cannot shadow register: ${String(error?.message ?? error)}` }
  }
  // `Reflect.set` returns false — and, on a non-strict target, may also silently do
  // nothing — when the property is non-writable or non-configurable. Trusting the
  // absence of a throw here is exactly how a filter reports success while removing
  // nothing, so the write is verified instead of assumed.
  if (wrote !== true || underlying.register !== shadowed) {
    return { installed: false, restore: () => {}, reason: 'register is not writable on the tools service' }
  }
  const restore = () => {
    try {
      if (hadOwn) Reflect.set(underlying, 'register', original)
      else Reflect.deleteProperty(underlying, 'register')
    } catch (error) {
      log?.warn?.(`dsh-skills-mcp-manager: could not restore the tools service: ${String(error?.message ?? error)}`)
    }
  }
  return { installed: true, restore, reason: '' }
}

/**
 * The tool names currently in the registry, or an empty list when it cannot be read.
 *
 * Used to report what was already registered before the shadow went in — a name
 * that arrived too early can never be filtered, because a plugin cannot unregister
 * another plugin's tools.
 */
export function liveToolNames(ctx) {
  try {
    const view = ctx.get?.('tools')
    if (view === null || view === undefined || typeof view.schemas !== 'function') return []
    const schemas = view.schemas()
    return Array.isArray(schemas) ? schemas.map((schema) => schema?.name).filter((n) => typeof n === 'string') : []
  } catch {
    return []
  }
}
