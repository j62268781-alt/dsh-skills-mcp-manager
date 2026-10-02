/**
 * In-flight tracking for operations that only land a couple of seconds later.
 *
 * The Host clears its queue *before* writing the profile patch, so the queue
 * alone would drop the spinner while the row still looks unchanged. The panel
 * therefore remembers what it asked for and waits until the projection actually
 * reflects it (with a safety timeout).
 */

export const DEFAULT_TIMEOUT = 15000
/** An `update` has no visible marker, so it stops spinning after this. */
export const UPDATE_GRACE = 4000

/** Record an operation, returning the new map. */
export function markInflight(map = {}, entryId, info = {}) {
  return { ...map, [entryId]: { at: Date.now(), ...info } }
}

/** Whether an entry currently has an operation in flight. */
export function isPending(map = {}, entryId) {
  return map[entryId] !== undefined
}

/** The spinner text for one in-flight entry. */
export function pendingLabel(info) {
  switch (info?.kind) {
    case 'delete': return '删除中…'
    case 'toggle': return '切换中…'
    case 'add': return '正在写入配置文件…'
    default: return '保存中…'
  }
}

/** Has one operation reached the state we were waiting for? */
export function hasSettled(info, row, now = Date.now()) {
  const age = now - (info?.at ?? now)
  switch (info?.kind) {
    case 'delete': return row === undefined
    // 行已消失（例如被别处删掉）时该操作已无意义，直接算完成，免得空转
    case 'toggle': return row === undefined || row.enabled === info.expectEnabled
    case 'add': return row !== undefined
    case 'update': return row !== undefined && (row.serverName === info.expectName || age > UPDATE_GRACE)
    default: return true
  }
}

/**
 * Drop entries whose effect is visible (or which outlived the safety timeout).
 * Returns the same map instance when nothing changed, so React can skip a render.
 */
export function settleInflight(map = {}, { profileRows = [], now = Date.now(), timeout = DEFAULT_TIMEOUT } = {}) {
  const entries = Object.entries(map)
  if (entries.length === 0) return map
  const kept = {}
  for (const [entryId, info] of entries) {
    const row = profileRows.find((candidate) => candidate.entryId === entryId)
    if (hasSettled(info, row, now)) continue
    if (now - (info?.at ?? now) >= timeout) continue
    kept[entryId] = info
  }
  return Object.keys(kept).length === entries.length ? map : kept
}

/** In-flight entries that are adds still waiting for their row to appear. */
export function pendingAdds(map = {}, profileRows = []) {
  return Object.entries(map)
    .filter(([entryId, info]) => info.kind === 'add' && !profileRows.some((row) => row.entryId === entryId))
}
