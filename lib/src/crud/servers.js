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

/**
 * In-flight key for a row.
 *
 * The same row has two id shapes depending on where the list came from: a Loader entry is
 * `include:mcp-<name>`, while a row read straight from the patch file is `mcp-<name>`.
 * In-flight bookkeeping must not care which one is current, or the optimistic add card and
 * the real card both render (they never compare equal) — normalize to the bare id.
 */
export function inflightKeyForRow(entryId) {
  return String(entryId).replace(/^include:/, '')
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
    toolCallTimeoutMs: text(source?.toolCallTimeoutMs),
    // 布尔，不走 `text()`：它是开关不是输入框，`text(false)` 会变成字符串 "false"
    // 而让 `=== true` 永远不成立 —— 勾选框会静默失效。
    allowInsecureTokenEndpoint: source?.allowInsecureTokenEndpoint === true,
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
    || next.toolCallTimeoutMs !== before.toolCallTimeoutMs
    // 漏掉这一行 = 勾选框能点、能回填，但**永远不会被写入**。
    // 这个仓库已经因为「手写字段清单漏一项」出过两次问题，所以这里显式列全。
    || next.allowInsecureTokenEndpoint !== before.allowInsecureTokenEndpoint
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
    /**
     * stdio 用哪个 npm 家族。
     *
     * **这一项原先没有**，所以面板上那个「运行时」下拉是个纯装饰：值只活在 draft 里，
     * 既不出现在命令里、也不落盘，Host 一律按自己的默认分支走 —— 用户选「跟随 Harness」
     * 却仍然用系统 npx（或反过来），而且看不出任何异常。用户说「选了启动不起来，那不就是
     * 有 bug 了吗」是对的，这就是那个 bug。
     */
    runtime: draft.runtime === 'auto' ? 'auto' : 'system',
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
    /**
     * stdio 用哪个 npm 家族。默认 `system` —— **不是** `auto`。
     *
     * `auto` 走的是 Harness 自带的 `node + pnpx`（内置 runtime 里没有 npm，所以当初只能
     * 换 pnpx），而 pnpx 解析 pnpm store 里那份包时依赖没有被链接进去，
     * `server-memory` / `server-filesystem` 会直接 `Cannot find package 'zod'` 退出。
     * 默认值放在这一层，是因为面板之外的调用方（导入、旧面板）也会走到这里 ——
     * 只改 UI 的话，从导入进来的行仍然会试图用 pnpx。
     *
     * **必须回填行里的实际值**：写死 `'system'` 会让「用户选过 auto、编辑一次就被悄悄改回
     * 系统」—— 这是最坏的一类回归，因为改动发生在用户没碰过的控件上。
     */
    runtime: row.runtime === 'auto' ? 'auto' : 'system',
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
