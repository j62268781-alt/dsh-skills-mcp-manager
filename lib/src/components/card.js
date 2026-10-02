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

/** Detail pairs for a global MCP row (a profile patch entry). */
export function rowDetailPairs(row = {}) {
  const transport = row.transport || 'streamable-http'
  const stdio = transport === 'stdio'
  return [
    ['行 id', String(row.entryId ?? '').replace(/^include:/, '')],
    ['传输', transport],
    ['地址', stdio ? '—' : (row.target || '—')],
    ['命令', stdio ? (row.target || '—') : '—'],
    ['参数', row.args ? row.args : '—'],
    ['环境变量', maskEnv(row.env)],
    ['范围', '全局（配置文件行）'],
    ['状态', row.enabled === false ? '已停用' : '已启用'],
  ]
}

/** Detail pairs for a project-level entry (managed by the panel itself). */
export function entryDetailPairs(server = {}, scopeLabel = '') {
  const transport = server.transport || 'streamable-http'
  const stdio = transport === 'stdio'
  const args = Array.isArray(server.args) ? server.args.join(' ') : (server.args ?? '')
  return [
    ['传输', transport],
    ['地址', stdio ? '—' : (server.url || '—')],
    ['命令', stdio ? (server.command || '—') : '—'],
    ['参数', args !== '' ? args : '—'],
    ['环境变量', maskEnv(server.env)],
    ['范围', scopeLabel !== '' ? scopeLabel : '项目级'],
    ['状态', server.enabled === false ? '已停用' : '已启用'],
  ]
}

/** Flatten label/value pairs into alternating key and value nodes. */
export function detailNodes(pairs, h, keyPrefix = 'd') {
  return pairs.flatMap(([key, value]) => [
    h('span', { className: 'smp-detailsKey', key: `${keyPrefix}-k-${key}` }, key),
    h('span', { className: 'smp-detailsValue', key: `${keyPrefix}-v-${key}` }, value || '—'),
  ])
}
