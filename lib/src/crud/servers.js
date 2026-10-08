/**
 * Global MCP row CRUD: turning panel actions into row operations.
 *
 * A global MCP lives in the profile patch as a Loader row, so every action
 * becomes an op the Host applies (lock -> validate -> atomic write + backup).
 * Keeping the construction here (pure, no React) makes the contract testable.
 */

/** Row id the Host writes for a server name. */
export function rowEntryId(serverName) {
  return `mcp-${serverName}`
}

/** In-flight key for a fresh add: the projection's entryId once it lands. */
export function inflightKeyForRow(entryId) {
  return entryId.startsWith('include:') ? entryId : `include:${entryId}`
}

/** A draft value as the text the Host expects ('' = leave the client default). */
function text(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

/**
 * Connection-policy fields a draft carries.
 *
 * They map straight onto the MCP client's `failOnStartupError` / `reconnect.*`
 * (see `src/mcp/connection.js` for the accepted range). A blank number means
 * "use the client default", so an untouched form never writes anything.
 */
export function connectionDraft(source) {
  return {
    failOnStartupError: source?.failOnStartupError === true,
    reconnectInitialDelayMs: text(source?.reconnectInitialDelayMs),
    reconnectMaxDelayMs: text(source?.reconnectMaxDelayMs),
    reconnectMaxAttempts: text(source?.reconnectMaxAttempts),
  }
}

/** Fields shared by add/update, from the form draft. */
function commonFields(draft) {
  return {
    serverName: draft.serverName,
    transport: draft.transport ?? 'streamable-http',
    command: draft.command ?? '',
    args: typeof draft.args === 'string' ? draft.args : '',
    env: typeof draft.env === 'string' ? draft.env : '',
    url: draft.url ?? '',
    headers: typeof draft.headers === 'string' ? draft.headers : '',
    ...connectionDraft(draft),
  }
}

/** Op that creates a new global row. */
export function addServerOp(draft, entryId = rowEntryId(draft.serverName)) {
  return { op: 'add', entryId, ...commonFields(draft) }
}

/** Op that rewrites an existing row (same row id, new content). */
export function updateServerOp(entryId, draft) {
  return { op: 'update', entryId, ...commonFields(draft) }
}

/** Op that enables/disables a row (Loader-level `disabled`). */
export function toggleServerOp(entryId, enabled) {
  return { op: 'toggle', entryId, enabled }
}

/** Op that removes a row. */
export function deleteServerOp(entryId) {
  return { op: 'delete', entryId }
}

/**
 * The form draft for editing an existing row.
 *
 * `target` merges a stdio row's command and arguments, so the address comes from
 * `url` for http rows and the executable from the row's own `command` field:
 * feeding `target` back into `command` would save `npx -y pkg` as the executable.
 */
export function draftFromRow(row) {
  const stdio = (row.transport ?? 'streamable-http') === 'stdio'
  return {
    serverName: row.serverName ?? '',
    transport: row.transport ?? 'streamable-http',
    url: stdio ? '' : (row.url ?? row.target ?? ''),
    command: row.command ?? '',
    args: typeof row.args === 'string' ? row.args : '',
    env: typeof row.env === 'string' ? row.env : '',
    runtime: 'auto',
    ...connectionDraft(row),
  }
}

/** Project-level entry update: replace one entry in `servers[]` by identity. */
export function replaceProjectEntry(servers, entry, patch) {
  return servers.map((item) => (item === entry ? { ...item, ...patch } : item))
}

/** Project-level entry removal. */
export function removeProjectEntry(servers, entry) {
  return servers.filter((item) => item !== entry)
}
