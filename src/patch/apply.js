/**
 * Applying one queued row operation to the profile patch.
 *
 * Everything here touches the user's real config file, so the write path is:
 * lock -> re-parse and validate -> `writeFileAtomic` (with a backup first).
 * The lock/atomic-write helpers are injected (`setPatchIO`) so the logic
 * can be exercised against a temp directory in tests.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'

/** The directory holding this plugin's own backup artifacts. */
export function backupDir() {
  return io.backupDir()
}

/**
 * Where the previous patch content is kept: a single rolling file.
 *
 * One file, not one per write. The backup exists to undo *the operation that just
 * ran* — its job is to hold the content that was in place immediately before the
 * current one — so a second, third and hundredth copy of the same bytes buys
 * nothing. The previous scheme wrote a timestamped copy on every write and had
 * accumulated 135 files holding only 5 distinct contents (130 of them byte-identical
 * duplicates, one content repeated 99 times), which is noise, not safety.
 *
 * The trade-off, stated plainly: a rolling file only goes back one step. If a write
 * goes wrong *and* you save again before noticing, the good state is overwritten by
 * the bad one. Versioned history would cover that, but at the cost that made this
 * unreadable in the first place; a config file is also under the user's own version
 * control and DSH's profile backups, which is where long-range history belongs.
 */
export function backupPath() {
  return join(backupDir(), 'cordis.patch.yml.bak')
}

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
  /**
   * Where backups are kept.
   *
   * Injectable on purpose: the backup path is the one side effect of this module
   * that does not go through `writeFileAtomic`, so without a seam here a test that
   * exercises `applyRowOp` silently writes into the developer's (or user's) real
   * `$DSH_HOME`. That is not hypothetical — `patch.apply.lossless.test.mjs` declared
   * a "scratch backup dir" in a comment for exactly this reason, but no such seam
   * existed, so every run of the suite dropped another backup into the real home.
   */
  backupDir: () => join(dshHome(), 'skills-mcp-panel.backups'),
}

/** Inject the host's file-lock / atomic-write implementation. */
export function setPatchIO(next) {
  io = { ...io, ...next }
}

/**
 * Keep the content that was in place before the write about to happen.
 *
 * Overwrites the single rolling file (see {@link backupPath}) — no timestamped
 * copies, so a day of panel edits leaves exactly one file instead of 135.
 */
export async function backupPatch(before) {
  try {
    await mkdir(backupDir(), { recursive: true })
    await writeFile(backupPath(), before)
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
      // `scope` is a row's tier, and it lives *in* the row's config — the client's schema
      // does not list it, but it does not strip unknown keys either (verified against the
      // shipped schema: `Config({…, scope}).scope` survives), and this plugin reads the raw
      // `options.config`. `global` is the default, so it is not written: a row without the
      // key reads as global, which keeps every pre-existing row valid unchanged.
      const projectScoped = typeof op.scope === 'string' && op.scope !== '' && op.scope !== 'global'
      if (projectScoped) config.scope = op.scope
      // A project row must not be instantiated by the Loader: this plugin mounts it into
      // the agent whose cwd the scope covers, and an enabled row would connect the same
      // server a second time. `disabled` skips instantiation while leaving the config
      // readable in `loader.entries()` — which is where the mount path finds it.
      changed = insertRow(document, op.entryId !== '' ? op.entryId : `mcp-${op.serverName}`, config, { disabled: projectScoped })
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
        // 环境变量：只有客户端确认「用户改过」时才动，清空即删键。
        // 未改动时保持原样，否则一个没回填这些字段的旧面板会把已配好的值抹掉。
        if (op.envChanged === true) {
          const env = spawnEnv(parseEnv(op.env))
          fields.env = Object.keys(env).length > 0 ? env : null
        } else if (op.env !== '') {
          fields.env = spawnEnv(parseEnv(op.env))
        }
      } else {
        fields.url = op.url
        fields.command = null
        fields.args = null
        if (op.headersChanged === true) {
          const headers = parseEnv(op.headers)
          fields.headers = Object.keys(headers).length > 0 ? headers : null
        } else if (op.headers !== '') {
          fields.headers = parseEnv(op.headers)
        }
      }
      // Scope is editable on an existing row too: moving a server between tiers is a normal
      // edit, not a delete-and-recreate. `null` clears the key, which reads as global.
      if (op.scopeChanged === true) {
        const scope = op.scope === '' || op.scope === 'global' ? null : op.scope
        fields.scope = scope
      }
      for (const [field, value] of Object.entries(fields)) {
        changed = setRowConfigField(document, op.entryId, field, value) || changed
      }
      // Connection policy on edit: only when the panel says the user actually
      // changed it. A blank number means "back to the client default" (the key is
      // cleared), but an untouched form must stay untouched — its fields may not
      // even have been prefilled, and treating blank as "clear" would silently
      // wipe a configured value on an unrelated edit such as changing the URL.
      if (op.connectionChanged === true) {
        changed = setRowConfigField(document, op.entryId, 'failOnStartupError', connection.failOnStartupError === true ? true : null) || changed
        changed = setRowConfigField(document, op.entryId, 'reconnect', connection.reconnect ?? null) || changed
        // 顶层键，和上面两个一样只在「用户确实改过」时写；空值=清键回客户端默认。
        changed = setRowConfigField(document, op.entryId, 'toolCallTimeoutMs', connection.toolCallTimeoutMs ?? null) || changed
      }
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

/**
 * Turn this plugin's legacy `config.servers` entries into `mcp-client` rows.
 *
 * ## Why every entry becomes a row
 *
 * Project servers used to live in a field this plugin owned, while global ones were rows.
 * Both tiers are rows now, and `scope` says which is which — so the migration converts
 * *every* legacy entry, including the global ones, or the two sources would still coexist
 * for exactly the servers the user sees first.
 *
 * ## Shape mapping
 *
 * The legacy entry is a panel-shaped object (`args` as a string, `env`/`headers` as
 * `KEY=VALUE` lines); a row's config is the client's shape (an argv array, dicts). The
 * conversion reuses the same helpers `applyRowOp` uses for the add path, so a migrated row
 * is byte-for-byte what adding the same server by hand would produce.
 *
 * @returns `{ migrated, ids }` — the number of rows written and their entry ids.
 */
export async function migrateServerEntries(ctx, entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => (
    entry !== null && typeof entry === 'object' && typeof entry.serverName === 'string' && entry.serverName !== ''
  ))
  if (list.length === 0) return { migrated: 0, ids: [] }
  const profile = ctx.get?.('profileContext') ?? ctx.profileContext
  const dir = profile?.dir
  if (typeof dir !== 'string' || dir === '') throw new Error('profileContext unavailable')
  const path = join(dir, 'cordis.patch.yml')
  return io.withFileLock(join(dir, 'package.json'), async () => {
    const before = await readFile(path, 'utf8')
    const document = parseDocument(before, { customTags: [YAML_JS_TAG] })
    if (document.errors[0] !== undefined) throw document.errors[0]
    // Never clobber a row that is already there: a migration that runs twice, or that meets
    // a row the user has since created by hand, must be a no-op rather than an overwrite.
    const existing = new Set(
      [...(document.contents?.items ?? [])]
        .flatMap((item) => {
          const out = []
          if (isMap(item) && item.get('id') !== undefined) out.push(String(item.get('id')))
          const insert = isMap(item) ? item.get('insert') : undefined
          if (isSeq(insert)) for (const row of insert.items) if (isMap(row) && row.get('id') !== undefined) out.push(String(row.get('id')))
          return out
        }),
    )
    const ids = []
    for (const entry of list) {
      const id = `mcp-${String(entry.serverName).replace(/[^A-Za-z0-9_-]/g, '-')}`
      if (existing.has(id)) continue
      const transport = entry.transport === 'stdio' ? 'stdio' : 'streamable-http'
      const config = { serverName: entry.serverName, transport }
      if (transport === 'stdio') {
        config.command = String(entry.command ?? '') === '' ? 'npx' : String(entry.command)
        // The legacy entry keeps `args` as an **array**, while `splitArgs` parses the
        // panel's space-separated *string*. Passing the array straight in produced one
        // mangled argument (`["-y,server-filesystem,/tmp"]`) — which would have broken
        // every migrated stdio server silently. Accept both shapes explicitly.
        config.args = Array.isArray(entry.args)
          ? entry.args.map((arg) => String(arg))
          : splitArgs(entry.args)
        const envLines = entry.env === null || entry.env === undefined
          ? ''
          : typeof entry.env === 'string'
            ? entry.env
            : Object.entries(entry.env).map(([key, value]) => `${key}=${String(value)}`).join('\n')
        const env = parseEnv(envLines)
        if (Object.keys(env).length > 0) config.env = spawnEnv(env)
      } else {
        config.url = String(entry.url ?? '')
        const headerLines = entry.headers === null || entry.headers === undefined
          ? ''
          : typeof entry.headers === 'string'
            ? entry.headers
            : Object.entries(entry.headers).map(([key, value]) => `${key}=${String(value)}`).join('\n')
        const headers = parseEnv(headerLines)
        if (Object.keys(headers).length > 0) config.headers = headers
      }
      Object.assign(config, connectionFields(entry))
      const projectScoped = typeof entry.scope === 'string' && entry.scope !== '' && entry.scope !== 'global'
      if (projectScoped) config.scope = entry.scope
      // Same reason as the add path: a project row is mounted by this plugin, so the
      // Loader must not instantiate it, or the server is connected twice.
      insertRow(document, id, config, { disabled: projectScoped })
      existing.add(id)
      ids.push(id)
    }
    if (ids.length === 0) return { migrated: 0, ids: [] }
    const after = document.toString()
    parseDocument(after, { customTags: [YAML_JS_TAG] })
    await backupPatch(before)
    await io.writeFileAtomic(path, after, {})
    ctx.logger.info('dsh-skills-mcp-manager: migrated %d panel server(s) into profile rows', ids.length)
    return { migrated: ids.length, ids }
  })
}
