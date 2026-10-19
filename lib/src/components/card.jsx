/**
 * Card content builders: the detail rows shown when a card is expanded.
 *
 * Pure data (label/value pairs) so the rendering sites stay thin and the shapes
 * can be unit-tested. `env` values are masked — the panel never shows secrets in
 * full once they are in the config file.
 */

/** Mask every `KEY=value` value while keeping the key. */
export function maskEnv(env) {
  if (typeof env !== 'string' || env.trim() === '') return '—'
  return env.replace(/=.*/g, '=***')
}

/**
 * Mask a header line list, keeping the key.
 *
 * Headers are a separate shape from environment variables, so they need their own
 * masker: reusing the env one would leave `Authorization: Bearer sk-…` in plain
 * sight, because it only strips on `=`. The projection writes `KEY=VALUE` while a
 * config object renders as `KEY: VALUE`, so both separators are handled.
 */
export function maskHeaders(headers) {
  const text = headersText(headers)
  if (text.trim() === '') return '—'
  return text.replace(/([=:])[^\n]*/g, '$1***')
}

/** Render a headers value (an object from the config, or the form's text) as lines. */
export function headersText(headers) {
  if (headers === null || headers === undefined) return ''
  if (typeof headers === 'string') return headers
  if (typeof headers !== 'object') return ''
  return Object.entries(headers).map(([key, value]) => `${key}: ${String(value)}`).join('\n')
}

/**
 * Split a stdio row's `env` into the variables the user configured and the `PATH`
 * the Host injects on its own.
 *
 * Every stdio row gets a `PATH` written into it: a desktop-launched Host inherits a
 * PATH without `node`, so a row whose command is `npx` would die in its
 * `#!/usr/bin/env node` shebang. That value is the *machine's* login PATH, often
 * hundreds of characters long and identical for every row — showing it under
 * 「环境变量」 reads as if the user configured it, and buries the variables they did
 * configure. So the two are separated and reported differently.
 *
 * @returns `{ own, path }` where `own` is the user's `KEY=VALUE` lines and `path` is
 *   the injected PATH (empty when there is none).
 */
export function splitEnv(env) {
  const text = typeof env === 'string' ? env : ''
  const own = []
  let path = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    if (key.toUpperCase() === 'PATH') path = trimmed.slice(at + 1).trim()
    else own.push(trimmed)
  }
  return { own: own.join('\n'), path }
}

/** Whether an env text carries a PATH line (the Host injects one for stdio rows). */
export function hasInjectedPath(env) {
  return splitEnv(env).path !== ''
}

/**
 * Fields that only exist for one transport.
 *
 * A transport's own fields are omitted entirely for the other transport rather
 * than shown as `—`: an http row has no command or arguments, and a stdio row has
 * no address, so printing placeholders only adds noise to the expanded card.
 * Optional fields (arguments, headers, env) appear only once they have a value.
 */
function transportPairs(transport, values) {
  if (transport === 'stdio') {
    const pairs = [['命令', values.command || '—']]
    if (values.args !== '') pairs.push(['参数', values.args])
    // Only the user's own variables get the 「环境变量」 row; the Host-injected PATH
    // is reported separately (see `splitEnv`) so it cannot be mistaken for config.
    const { own, path } = splitEnv(values.env)
    if (own !== '') pairs.push(['环境变量', maskEnv(own)])
    // The key stays short on purpose: the label column is 76px wide, and a longer
    // key wrapped onto two lines and broke the grid's alignment.
    if (path !== '') pairs.push(['PATH', 'DSH 自动注入 · 跟随系统 PATH，让 npx/node 能被找到'])
    return pairs
  }
  const pairs = [['地址', values.url || '—']]
  if (values.headers !== '') pairs.push(['请求头', maskHeaders(values.headers)])
  return pairs
}

/** Detail pairs for a global MCP row (a profile patch entry). */
export function rowDetailPairs(row = {}) {
  const transport = row.transport || 'streamable-http'
  return [
    ['行 id', String(row.entryId ?? '').replace(/^include:/, '')],
    ['传输', transport],
    ...transportPairs(transport, {
      // For a stdio row the projection merges command + args into `target`.
      command: transport === 'stdio' ? (row.target || '') : '',
      args: row.args ?? '',
      env: row.env ?? '',
      url: transport === 'stdio' ? '' : (row.target || ''),
      headers: row.headersText ?? '',
    }),
    // The scope *is* the tier now: `global` means the Loader connects this row and every
    // agent sees it; an absolute path means this plugin mounts it for the agent whose
    // working directory falls under it. One row, one list — so the card states which.
    ['作用域', scopeLabelOf(row.scope)],
    // 没有「状态」行：卡片右侧的开关就是启用状态的唯一真源。再写一行字等于同一件事有
    // 两个出处，而它们会漂移（开关是乐观更新的，文字来自投影，中间必然有一段时间不一致）。
  ]
}

/**
 * A row's scope as the card should read it.
 *
 * `global` (or a missing value) is the every-agent case; anything else is a project path.
 *
 * The key already says 「作用域」, so the value must not repeat the word 「工作区」 — repeating
 * the label inside its own value makes the column read as `作用域 | 工作区：…`, i.e. the same
 * fact twice, and pushes the actual path further right where it is harder to scan.
 */
export function scopeLabelOf(scope) {
  const value = typeof scope === 'string' ? scope : ''
  if (value === '' || value === 'global') return '全局'
  return value
}

/** Detail pairs for a project-level entry (managed by the panel itself). */
export function entryDetailPairs(server = {}, scopeLabel = '') {
  const transport = server.transport || 'streamable-http'
  const args = Array.isArray(server.args) ? server.args.join(' ') : (server.args ?? '')
  return [
    ['传输', transport],
    ...transportPairs(transport, {
      command: server.command ?? '',
      args,
      env: server.env ?? '',
      url: server.url ?? '',
      headers: headersText(server.headers),
    }),
    ['范围', scopeLabel !== '' ? scopeLabel : '项目级'],
    // 同上：项目条目也有自己的开关，不再用文字重复一遍启停状态。
  ]
}

/** Flatten label/value pairs into alternating key and value nodes (JSX). */
export function detailNodes(pairs, keyPrefix = 'd') {
  return pairs.flatMap(([key, value]) => [
    <span className="smp-detailsKey" key={`${keyPrefix}-k-${key}`}>{key}</span>,
    <span className="smp-detailsValue" key={`${keyPrefix}-v-${key}`}>{value || '—'}</span>,
  ])
}

/**
 * The tool inventory for one server.
 *
 * Four outcomes, which the panel must keep visually distinct:
 *
 *   `{ state: 'listed', tools }`  — the registry was read; this is the answer
 *   `{ state: 'unreadable', kind: 'host-stale' }`   — the Host predates this feature
 *   `{ state: 'unreadable', kind: 'reported', ... }` — the Host reported a failure
 *   `{ state: 'absent' }`         — the Host is current but has no row for this server
 *
 * The stale/absent split is the subtle one, and getting it wrong sends the user
 * debugging a healthy registry. The tell is **whether the error field exists at
 * all**: a current Host always publishes `serverToolsError` (empty reason on
 * success), so its absence — not an empty reason — means the Host is old. An empty
 * reason on a *present* field means the read succeeded, and a missing row is then
 * just a server the projection has not caught up with.
 */
export const TOOL_ERROR_REASONS = {
  /** The Host published no error field: it is an older build than this panel. */
  hostStale: 'host-stale',
  /** The Host reported a concrete failure while reading the registry. */
  reported: 'reported',
}

/** Human text for a Host-reported reason code (kept in step with the Host table). */
const REASON_TEXT = {
  'loading': '正在读取当前工具清单',
  'runtime-unavailable': '无法读取 Host 运行时数据（请确认 Host 已更新且连接正常）',
  'lookup-failed': '无法访问工具服务（cordis 服务尚未注入）',
  'service-missing': '当前配置里没有工具注册表（dsh-tools 未挂载）',
  'api-missing': '工具注册表版本过旧，没有 schemas() 接口',
  'read-failed': '读取工具注册表出错',
  'bad-shape': '工具注册表返回了意外的数据形状',
}

export function toolsForServer(serverTools, serverName, serverToolsError = undefined) {
  const listed = Array.isArray(serverTools) ? serverTools : []
  const entry = listed.find((item) => item?.serverName === serverName)
  if (entry !== undefined) {
    return { state: 'listed', tools: Array.isArray(entry.tools) ? entry.tools : [] }
  }
  // No row for this server. A current Host always announces itself by publishing the
  // error field, so its absence is what identifies an old Host.
  if (serverToolsError === undefined || serverToolsError === null) {
    return { state: 'unreadable', kind: TOOL_ERROR_REASONS.hostStale, reason: '', detail: '' }
  }
  const reason = serverToolsError.reason
  if (typeof reason === 'string' && reason !== '') {
    return { state: 'unreadable', kind: TOOL_ERROR_REASONS.reported, reason, detail: String(serverToolsError.detail ?? '') }
  }
  // Field present, no error, yet no row: the Host is fine, the projection just has
  // not listed this server (typically one added moments ago).
  return { state: 'absent' }
}

/** One-line summary of an inventory result, including why it is unknown. */
export function toolsSummary(inventory) {
  if (inventory?.state === 'listed') {
    if (inventory.tools.length === 0) return '暂无已注册的工具（可能未连接或该服务器没有工具）'
    return `${inventory.tools.length} 个工具`
  }
  if (inventory?.state === 'absent') return '尚未发布该服务器的工具（刚添加的话稍等片刻）'
  if (inventory?.kind === TOOL_ERROR_REASONS.hostStale) {
    return '需要重启 DSH 后可见（当前运行的 Host 是旧版本）'
  }
  const text = REASON_TEXT[inventory?.reason]
  if (text === undefined) return '工具清单不可读'
  return inventory?.detail ? `${text}：${inventory.detail}` : text
}
