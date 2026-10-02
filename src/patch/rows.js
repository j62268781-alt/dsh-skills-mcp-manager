/**
 * Profile-patch row surgery: locating rows and editing them in place.
 *
 * Pure functions over a parsed `yaml` document — no cordis context, no file IO.
 * The file-level concerns (locking, backup, validation) live in `applyRowOp`,
 * which calls into this module.
 */
import { isMap, isSeq } from 'yaml'

/** The shipped MCP client every managed row instantiates. */
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Find a row by id, whether it sits at the top level or inside an `insert:` list. */
export function locateRow(document, rawEntryId) {
  const entryId = String(rawEntryId).replace(/^include:/, '')
  const tops = document.contents
  if (!isSeq(tops)) throw new Error('profile patch must be a YAML sequence')
  for (const [index, item] of tops.items.entries()) {
    if (!isMap(item)) continue
    if (document.getIn([index, 'id']) === entryId) return { container: tops, index, item, place: 'top' }
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    for (const [inner, row] of insert.items.entries()) {
      if (isMap(row) && row.get('id') === entryId) return { container: insert, index: inner, item: row, place: 'insert' }
    }
  }
  return null
}

/** Drop one row, and the now-empty `insert:` directive that carried it. */
export function removeRow(document, entryId) {
  const found = locateRow(document, entryId)
  if (found === null) return false
  found.container.items.splice(found.index, 1)
  if (found.place === 'insert' && found.container.items.length === 0) {
    const tops = document.contents
    const outer = tops.items.findIndex((item) => isMap(item) && item.get('insert') === found.container)
    if (outer >= 0) tops.items.splice(outer, 1)
  }
  return true
}

/** Set or clear one field inside a row's `config`, creating the map when absent. */
export function setRowConfigField(document, entryId, field, value) {
  const found = locateRow(document, entryId)
  if (found === null) return false
  let config = found.item.get('config')
  if (!isMap(config)) {
    found.item.set('config', {})
    config = found.item.get('config')
  }
  if (value === null) config.delete(field)
  else config.set(field, value)
  return true
}

/** Enable/disable a whole row (the Loader's own `disabled` flag). */
export function setRowDisabled(document, entryId, disabled) {
  const found = locateRow(document, entryId)
  if (found === null) return false
  if (disabled) found.item.set('disabled', true)
  else found.item.delete('disabled')
  return true
}

/** Append a fresh mcp-client row to the patch's first `insert:` instruction. */
export function insertRow(document, id, config) {
  const row = { id, name: MCP_MODULE, config }
  const contents = document.contents
  if (isSeq(contents)) {
    for (const item of contents.items) {
      if (isMap(item)) {
        const existing = item.get('insert', true)
        if (isSeq(existing)) {
          existing.add(row)
          return true
        }
      }
    }
    contents.add({ insert: [row] })
    return true
  }
  // Empty (or non-sequence) document: start a fresh sequence.
  document.contents = document.createNode([{ insert: [row] }])
  return true
}
