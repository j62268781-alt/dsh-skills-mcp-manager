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

/**
 * Whether the draft's connection fields differ from the entry they were loaded from.
 *
 * Only a real change is written on update. A blank number means "clear this key",
 * so a form whose fields were not prefilled — an older Host whose row projection
 * did not carry them — would otherwise wipe a configured value on an unrelated
 * edit such as changing the URL.
 *
 * A missing `original` answers `false` unconditionally: without the entry there is
 * nothing to diff against, and a silent no-op is recoverable while a silent rewrite
 * is not.
 */
export function connectionChanged(draft, original) {
  if (original === undefined || original === null) return false
  const next = connectionDraft(draft)
  const before = connectionDraft(original)
  return next.failOnStartupError !== before.failOnStartupError
    || next.reconnectInitialDelayMs !== before.reconnectInitialDelayMs
    || next.reconnectMaxDelayMs !== before.reconnectMaxDelayMs
    || next.reconnectMaxAttempts !== before.reconnectMaxAttempts
}

/** Fields shared by add/update, from the form draft. */
/**
 * The row's tier. `global` is the default and is not written (a row without the key reads
 * as global), so the two tiers really are one kind of thing with one field of difference.
 */
function scopeFields(draft) {
  const scope = typeof draft.scope === 'string' ? draft.scope : ''
  return { scope, scopeChanged: draft.scopeChanged === true }
}

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
  return { op: 'add', entryId, ...commonFields(draft), ...scopeFields(draft) }
}

/**
 * Whether a free-text field differs from the entry it was loaded from.
 *
 * Blank has to mean two different things: "delete this key" when the user
 * deliberately cleared a prefilled field, and "leave it alone" when the form never
 * showed it (an older Host that does not project the field). Only a diff can tell
 * them apart, so the client computes one and the Host trusts it.
 */
function textChanged(draft, original, key) {
  if (original === undefined || original === null) return false
  return text(draft[key]) !== text(original[key] ?? original[`${key}Text`])
}

/** Whether the draft's env lines differ from the entry's. */
export function envChanged(draft, original) {
  return textChanged(draft, original, 'env')
}

/** Whether the draft's request-header lines differ from the entry's. */
export function headersChanged(draft, original) {
  return textChanged(draft, original, 'headers')
}

/** Op that rewrites an existing row (same row id, new content).
 *
 * `original` is the row the form was filled from; the Host only touches the
 * connection fields when `connectionChanged` says the user actually edited them.
 */
export function updateServerOp(entryId, draft, original) {
  return {
    op: 'update',
    entryId,
    ...commonFields(draft),
    ...scopeFields(draft),
    connectionChanged: connectionChanged(draft, original),
    envChanged: envChanged(draft, original),
    headersChanged: headersChanged(draft, original),
  }
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
 *
 * A global stdio row carries a `PATH` the Host injected (see `splitEnv` in
 * card.jsx). It is prefilled here on purpose rather than hidden: it *is* part of the
 * row, and dropping it from the form would delete it on the next save. The form
 * labels it as automatic so it is not mistaken for something the user configured.
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
    // Headers are prefilled for the same reason the connection fields are: an
    // untouched field must round-trip, or saving an unrelated edit (say the URL)
    // would delete the authorization header the row was relying on.
    headers: stdio ? '' : headersDraft(row.headersText ?? row.headers),
    runtime: 'auto',
    ...connectionDraft(row),
  }
}

/** A headers value (object in the config, text in a draft) as the form's lines. */
export function headersDraft(headers) {
  if (headers === null || headers === undefined) return ''
  if (typeof headers === 'string') return headers
  if (typeof headers !== 'object' || Array.isArray(headers)) return ''
  return Object.entries(headers).map(([key, value]) => `${key}=${String(value)}`).join('\n')
}
