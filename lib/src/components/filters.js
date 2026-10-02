/**
 * Filtering helpers for the panel's search box and project picker.
 *
 * The panel searches by NAME only (a deliberate choice: matching description or
 * body made hits feel random), case-insensitively.
 */

/** Name-only match, case-insensitive; an empty query matches everything. */
export function matchesName(name, query) {
  const needle = (query ?? '').trim().toLowerCase()
  if (needle === '') return true
  if (typeof name !== 'string') return false
  return name.toLowerCase().includes(needle)
}

/** Filter any list by one of its name fields. */
export function filterByName(items = [], query, key = 'serverName') {
  return items.filter((item) => matchesName(item?.[key], query))
}

/** Tab counters, with the "0" case spelled out for the UI. */
export function tabLabel(title, count) {
  // 全角括号：与面板既有渲染一致（'MCP（5）'）
  return `${title}（${count}）`
}

/** Servers belonging to a scope: global rows are listed only under MCP/global. */
export function serversForScope(servers = [], scope) {
  return servers.filter((server) => (server.scope ?? 'global') === scope)
}
