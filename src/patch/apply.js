/**
 * Applying one queued row operation to the profile patch.
 *
 * Everything here touches the user's real config file, so the write path is:
 * lock -> re-parse and validate -> `writeFileAtomic` (with a timestamped backup
 * first). The lock/atomic-write helpers are injected (`setPatchIO`) so the logic
 * can be exercised against a temp directory in tests.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

/**
 * MCP rows the active profile already configures with the shipped client.
 *
 * Read from the Loader (the panel's own settings document cannot see them,
 * because those rows declare no volatile fields), reduced to what a panel row
 * needs to show.
 */
const YAML_JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }
import { insertRow, removeRow, setRowConfigField, setRowDisabled } from './rows.js'
import { dshHome, parseEnv, spawnEnv, splitArgs } from '../runtime/env.js'
import { connectionFields } from '../mcp/connection.js'

let io = {
  withFileLock: (_key, run) => run(),
  writeFileAtomic: async (path, text) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, text, 'utf8')
  },
}

/** Inject the host's file-lock / atomic-write implementation. */
export function setPatchIO(next) {
  io = { ...io, ...next }
}

export async function backupPatch(before) {
  try {
    const dir = join(dshHome(), 'skills-mcp-panel.backups')
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await writeFile(join(dir, `cordis.patch.yml.${stamp}.bak`), before)
  } catch (error) {
    // a missing backup must not block a legitimate edit
  }
}

/**
 * Apply one panel command to the active profile patch.
 *
 * Uses the same lock and atomic write the official config editor uses, re-parses
 * the result before writing it, and keeps a backup of the previous content.
 */
export async function applyRowOp(ctx, op) {
  const profile = ctx.get?.('profileContext') ?? ctx.profileContext
  const dir = profile?.dir
  if (typeof dir !== 'string' || dir === '') throw new Error('profileContext unavailable')
  const path = join(dir, 'cordis.patch.yml')
  return io.withFileLock(join(dir, 'package.json'), async () => {
    const before = await readFile(path, 'utf8')
    const document = parseDocument(before, { customTags: [YAML_JS_TAG] })
    if (document.errors[0] !== undefined) throw document.errors[0]
    let changed = false
    if (op.op === 'add') {
      const transport = op.transport === '' ? 'streamable-http' : op.transport
      const config = { serverName: op.serverName, transport }
      if (transport === 'stdio') {
        config.command = op.command === '' ? 'npx' : op.command
        config.args = splitArgs(op.args)
        config.env = spawnEnv(parseEnv(op.env))
      } else {
        config.url = op.url
        const headers = parseEnv(op.headers)
        if (Object.keys(headers).length > 0) config.headers = headers
      }
      // Connection policy (failOnStartupError + reconnect.*). Validated before
      // anything is written: an out-of-range number would make the row fail to
      // load, and keys left unset keep the client's own defaults.
      Object.assign(config, connectionFields(op))
      changed = insertRow(document, op.entryId !== '' ? op.entryId : `mcp-${op.serverName}`, config)
    } else if (op.op === 'toggle') {
      changed = setRowDisabled(document, op.entryId, op.enabled === false)
    } else if (op.op === 'delete') {
      changed = removeRow(document, op.entryId)
    } else {
      // Validate the connection numbers up front: an out-of-range value has to
      // fail before anything is touched, not after the document was edited.
      const connection = connectionFields(op)
      const fields = {}
      if (op.serverName !== '') fields.serverName = op.serverName
      if (op.transport !== '') fields.transport = op.transport
      if (op.transport === 'stdio') {
        fields.command = op.command
        fields.args = splitArgs(op.args)
        fields.url = null
        if (op.env !== '') fields.env = spawnEnv(parseEnv(op.env))
      } else {
        fields.url = op.url
        fields.command = null
        fields.args = null
        if (op.headers !== '') fields.headers = parseEnv(op.headers)
      }
      for (const [field, value] of Object.entries(fields)) {
        changed = setRowConfigField(document, op.entryId, field, value) || changed
      }
      // Connection policy on edit: what the form left blank goes back to the
      // client default, so `null` clears the key instead of writing a value that
      // only restates it.
      changed = setRowConfigField(document, op.entryId, 'failOnStartupError', connection.failOnStartupError === true ? true : null) || changed
      changed = setRowConfigField(document, op.entryId, 'reconnect', connection.reconnect ?? null) || changed
    }
    if (!changed) throw new Error(`row "${op.entryId}" not found in the profile patch`)
    const after = document.toString()
    parseDocument(after, { customTags: [YAML_JS_TAG] })   // gate: never write invalid YAML
    await backupPatch(before)
    await io.writeFileAtomic(path, after, {})
    ctx.logger.info('skills-mcp-panel: %s profile row %s', op.op, op.entryId)
    return true
  })
}
