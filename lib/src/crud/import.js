/**
 * MCP import CRUD logic, free of React so it can be unit-tested.
 *
 * The panel never overwrites: names it already manages (profile rows for the
 * global scope, panel entries for a project) are reported as `skipped`, and the
 * UI only offers to import `fresh` ones.
 */

/** Names already managed for this scope. */
export function takenNames({ scope, target, profileRows = [], servers = [] }) {
  if (scope === 'global') return new Set(profileRows.map((row) => row.serverName))
  return new Set(
    servers
      .filter((server) => (server.scope ?? 'global') === target)
      .map((server) => server.serverName),
  )
}

/** Split a scan result into new vs already-present servers. */
export function splitImport(found = [], taken = new Set()) {
  const fresh = found.filter((server) => !taken.has(server.serverName))
  const skipped = found.filter((server) => taken.has(server.serverName))
  return { fresh, skipped }
}

/** The request object the Host watches for a scan. */
export function importRequest({ source, scope, project, nonce }) {
  return { source, scope, project: scope === 'global' ? '' : project, nonce: String(nonce) }
}

/** A stable nonce so repeated scans of the same target still trigger the Host. */
export function nextNonce(source, at = Date.now()) {
  return `${source}-${at}`
}

/** Button label for the import action. */
export function importLabel({ scope, fresh, skipped }) {
  const suffix = skipped > 0 ? `（跳过 ${skipped} 个）` : ''
  return scope === 'global' ? `导入 ${fresh} 个到配置文件${suffix}` : `导入 ${fresh} 个${suffix}`
}
