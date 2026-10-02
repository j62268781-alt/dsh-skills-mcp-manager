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

/** The form draft for editing an existing row. */
export function draftFromRow(row) {
  return {
    serverName: row.serverName ?? '',
    transport: row.transport ?? 'streamable-http',
    url: row.url ?? row.target ?? '',
    command: row.command ?? '',
    args: typeof row.args === 'string' ? row.args : '',
    env: typeof row.env === 'string' ? row.env : '',
    runtime: 'auto',
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
