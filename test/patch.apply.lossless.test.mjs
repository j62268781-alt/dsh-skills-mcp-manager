/**
 * The profile patch is the user's real config file: a row edit must preserve
 * every other entry, every comment, and the file's overall shape.
 *
 * The write path uses `parseDocument`/`toString` (not parse/stringify) precisely
 * to keep formatting, so this test pins that behaviour down with a hazardous
 * fixture — comments, `!!js` tags, insert lists, nested maps — and, when
 * SMP_REAL_PATCH points at a real cordis.patch.yml, runs the same checks on it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { NAME, LEGACY_NAME } from '../src/identity.js'
import { applyRowOp, migratePanelConfig, setPatchIO } from '../src/patch/apply.js'

const YAML_JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }
const readPatch = (path) => parse(readFileSync(path, 'utf8'), { customTags: [YAML_JS_TAG] })

const HAZARDOUS = `# header comment that must survive
# second line of the header
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: turing-chat
    model: deepseek-v4.1-flash
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      turing:
        displayName: 图灵
        apiKeyEnv: TURING_API_KEY
        baseURL: https://example.invalid/api/v1
        models:
          - id: deepseek-v4.1-flash
            name: deepseek-v4.1-flash
            contextWindow: 1000000
      local:
        displayName: local
        api: openai-completions
        baseURL: !!js process.env.LOCAL_URL
- id: mcp-context7
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: context7
    transport: streamable-http
    url: https://mcp.context7.com/mcp
- id: bootstrap
  name: '@deepseek-ai/dsh-bootstrap'
  insert:
    - id: mcp-deepwiki
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deepwiki
        transport: streamable-http
        url: https://mcp.deepwiki.com/mcp
`

const makeProfile = (content) => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-lossless-'))
  writeFileSync(join(dir, 'cordis.patch.yml'), content)
  writeFileSync(join(dir, 'package.json'), '{}\n')
  return dir
}

const ctxFor = (dir) => ({ get: (name) => (name === 'profileContext' ? { dir } : undefined), logger: { info() {} } })

// applyRowOp writes through injected IO; point it at plain file writes and a
// scratch backup dir so the test never touches ~/.dsh. The backup dir MUST be
// injected: `backupPatch` does not go through `writeFileAtomic`, so without this
// the suite drops a backup into the real `$DSH_HOME` on every run (it used to).
const scratchBackup = mkdtempSync(join(tmpdir(), 'smp-lossless-bak-'))
const usePlainIO = () => setPatchIO({
  withFileLock: (_key, run) => run(),
  writeFileAtomic: async (path, text) => { writeFileSync(path, text, 'utf8') },
  backupDir: () => scratchBackup,
})

/** Find a row by id anywhere: panel rows may live inside an `insert:` list. */
const findRowDeep = (value, predicate) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object' && predicate(item)) return item
      const inner = findRowDeep(item, predicate)
      if (inner !== undefined) return inner
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const inner = findRowDeep(item, predicate)
      if (inner !== undefined) return inner
    }
  }
  return undefined
}

/** Deep copy with one row (and its subtree) removed, at any nesting depth. */
const dropById = (value, entryId) => {
  if (Array.isArray(value)) return value.filter((item) => item?.id !== entryId).map((item) => dropById(item, entryId))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = dropById(item, entryId)
    return out
  }
  return value
}

/** Entries other than `entryId` must be deep-equal before and after. */
const assertOnlyTargetChanged = (before, after, entryId) => {
  const strip = (entries) => JSON.parse(JSON.stringify(entries.filter((entry) => entry?.id !== entryId)))
  assert.deepEqual(strip(after), strip(before), '其它条目必须原样保留')
}

test('备份目录可被注入：测试不得把备份写进真实的 $DSH_HOME', async () => {
  // 这条防的是一个真实发生过的事故：backupPatch 不走 writeFileAtomic，
  // 此前没有注入点，于是每跑一次测试就往真实的 $DSH_HOME 丢一个备份
  // （一天下来堆了 135 个，其中 130 个是完全相同的内容）。
  const beforeReal = process.env.DSH_HOME
  const fakeReal = mkdtempSync(join(tmpdir(), 'smp-fake-real-home-'))
  process.env.DSH_HOME = fakeReal
  try {
    const scratch = mkdtempSync(join(tmpdir(), 'smp-scratch-bak-'))
    setPatchIO({
      withFileLock: (_key, run) => run(),
      writeFileAtomic: async (path, text) => { writeFileSync(path, text, 'utf8') },
      backupDir: () => scratch,
    })
    const dir = makeProfile(HAZARDOUS)
    await applyRowOp(ctxFor(dir), { op: 'toggle', entryId: 'mcp-context7', enabled: false })

    // 备份落在注入的 scratch 目录里
    assert.deepEqual(readdirSync(scratch), ['cordis.patch.yml.bak'])
    // 而真实 home（这里用替身代表）一个字节都不该被写
    assert.deepEqual(readdirSync(fakeReal), [], '真实 $DSH_HOME 不该出现任何备份目录')
  } finally {
    if (beforeReal === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = beforeReal
  }
})

test('真实危险夹具：toggle 一行只改那一行，注释与 !!js 标签都保留', async () => {
  usePlainIO()
  const dir = makeProfile(HAZARDOUS)
  const path = join(dir, 'cordis.patch.yml')
  const before = readPatch(path)

  await applyRowOp(ctxFor(dir), { op: 'toggle', entryId: 'mcp-context7', enabled: false })

  const text = readFileSync(path, 'utf8')
  assert.match(text, /^# header comment that must survive$/m, '头部注释必须保留')
  assert.match(text, /^# second line of the header$/m, '第二行注释必须保留')
  assert.match(text, /!!js process\.env\.LOCAL_URL/, '!!js 表达式必须原样保留')
  assertOnlyTargetChanged(before, readPatch(path), 'mcp-context7')
  // `disabled` is a row-level loader field, not a config field.
  assert.equal(readPatch(path).find((e) => e.id === 'mcp-context7').disabled, true)
  // 行数不应大幅变化（只多一行 disabled）
  assert.ok(Math.abs(text.split('\n').length - HAZARDOUS.split('\n').length) <= 2, '行数变化应在 2 行内')
})

test('add 再 delete 同一行：文件回到"其它条目完全一致"的状态', async () => {
  usePlainIO()
  const dir = makeProfile(HAZARDOUS)
  const path = join(dir, 'cordis.patch.yml')
  const before = readPatch(path)

  await applyRowOp(ctxFor(dir), { op: 'add', entryId: 'mcp-probe', serverName: 'probe', transport: 'streamable-http', url: 'https://example.invalid/mcp' })
  await applyRowOp(ctxFor(dir), { op: 'delete', entryId: 'mcp-probe' })

  const after = readPatch(path)
  assert.deepEqual(after, before, '增删同一行后应与初始文档语义完全一致')
  assert.match(readFileSync(path, 'utf8'), /^# header comment that must survive$/m)
})

test('删除 insert 列表里唯一的行时，连带空掉的 insert 指令一起移除', async () => {
  usePlainIO()
  const dir = makeProfile(HAZARDOUS)
  const path = join(dir, 'cordis.patch.yml')
  await applyRowOp(ctxFor(dir), { op: 'delete', entryId: 'mcp-deepwiki' })
  const ids = readPatch(path).map((entry) => entry.id)
  assert.equal(ids.includes('mcp-deepwiki'), false)
  assert.equal(ids.includes('bootstrap'), false, '空掉的 insert 外框也应移除')
  assert.deepEqual(ids, ['agent-default-model', 'llm-pi-ai', 'mcp-context7'])
})

test('改动不存在的行必须抛错且不写文件', async () => {
  usePlainIO()
  const dir = makeProfile(HAZARDOUS)
  const path = join(dir, 'cordis.patch.yml')
  const original = readFileSync(path, 'utf8')
  await assert.rejects(() => applyRowOp(ctxFor(dir), { op: 'toggle', entryId: 'mcp-nope', enabled: false }), /not found/)
  assert.equal(readFileSync(path, 'utf8'), original, '失败时文件必须一字未改')
})

test('运行时字段清理及旧标识迁移兼容顶层和 insert 行，保留规则并且只写一次', async () => {
  for (const [nested, entryId] of [[false, NAME], [true, NAME], [false, LEGACY_NAME], [true, LEGACY_NAME]]) {
    usePlainIO()
    const row = `- id: ${entryId}
  config:
    # keep filter rules
    toolFilters:
      deepwiki: { mode: deny, tools: [private] }
    serverTools: [{ serverName: deepwiki, tools: [] }]
    serverToolsError: { reason: '', detail: '' }
    serverStatus: []
`
    const content = HAZARDOUS + (nested ? `- insert:\n${row.split('\n').filter(Boolean).map((line) => '    ' + line).join('\n')}\n` : row)
    const dir = makeProfile(content)
    const path = join(dir, 'cordis.patch.yml')
    const before = readPatch(path)
    assert.equal(await migratePanelConfig(ctxFor(dir)), entryId === LEGACY_NAME ? 4 : 3)
    const after = readPatch(path)
    const panel = findRowDeep(after, (item) => item.id === 'dsh-skills-mcp-manager')
    assert.deepEqual(panel.config, { toolFilters: { deepwiki: { mode: 'deny', tools: ['private'] } } })
    assert.deepEqual(dropById(after, NAME), dropById(before, entryId))
    const cleaned = readFileSync(path, 'utf8')
    assert.match(cleaned, /# keep filter rules/)
    assert.match(cleaned, /!!js process.env.LOCAL_URL/)
    assert.equal(await migratePanelConfig(ctxFor(dir)), 0)
    assert.equal(readFileSync(path, 'utf8'), cleaned)
  }
})

test('旧 config.servers/skills 迁移成行与 SKILL.md，并把配置键删掉', async () => {
  usePlainIO()
  const home = mkdtempSync(join(tmpdir(), 'smp-migrate-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const config = {
      skills: [{ name: 'demo', enabled: true, description: '演示', body: '# hi' }],
      servers: [{ serverName: 'demo', transport: 'stdio', command: 'node', args: 'server.js' }],
      toolFilters: { demo: { mode: 'deny', tools: ['private'] } },
    }
    const dir = makeProfile(HAZARDOUS + `- id: ${LEGACY_NAME} # keep row comment\n  config: ${JSON.stringify(config)}\n`)
    const path = join(dir, 'cordis.patch.yml')
    // 行标识 1 + servers 行 1 + servers 键 1 + SKILL.md 1 + skills 键 1
    assert.equal(await migratePanelConfig(ctxFor(dir)), 5)
    const after = readPatch(path)
    const panel = findRowDeep(after, (row) => row.id === NAME)
    assert.deepEqual(panel.config, { toolFilters: { demo: { mode: 'deny', tools: ['private'] } } })
    const row = findRowDeep(after, (row) => row.id === 'mcp-demo')
    assert.equal(row.config.serverName, 'demo')
    assert.equal(row.config.transport, 'stdio')
    assert.deepEqual(row.config.args, ['server.js'])
    assert.ok(existsSync(join(home, 'skills', 'demo', 'SKILL.md')), '技能正文应写成 SKILL.md')
    assert.match(readFileSync(path, 'utf8'), /# keep row comment/)
    // 幂等：第二次没有可迁移的东西
    assert.equal(await migratePanelConfig(ctxFor(dir)), 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

// 可选：SMP_REAL_PATCH=/path/to/cordis.patch.yml 时，在真实配置的副本上跑同样的无损检查
const realPatch = process.env.SMP_REAL_PATCH
test('可选：在真实 cordis.patch.yml 副本上验证无损（SMP_REAL_PATCH）', { skip: realPatch === undefined ? '未设置 SMP_REAL_PATCH' : false }, async () => {
  usePlainIO()
  const content = readFileSync(realPatch, 'utf8')
  const dir = makeProfile(content)
  const path = join(dir, 'cordis.patch.yml')
  const before = readPatch(path)
  const target = findRowDeep(before, (row) => typeof row.id === 'string' && row.id.startsWith('mcp-'))
  assert.ok(target !== undefined, '真实配置里应有 mcp- 行可测')
  const originalLines = content.split('\n').length

  await applyRowOp(ctxFor(dir), { op: 'toggle', entryId: target.id, enabled: false })
  const text = readFileSync(path, 'utf8')
  assert.deepEqual(dropById(readPatch(path), target.id), dropById(before, target.id), '除目标行外，整个文档（含 insert 内层）必须完全一致')
  const after = findRowDeep(readPatch(path), (row) => row.id === target.id)
  assert.equal(after.disabled, true, '目标行应被标记 disabled')
  assert.ok(Math.abs(text.split('\n').length - originalLines) <= 2, `行数变化应 ≤2（原 ${originalLines}，现 ${text.split('\n').length}）`)
  assert.match(text, /^# Your patch layer for this dsh profile/m, '原始头部注释必须保留')
  console.log(`    · 真实配置：${before.length} 个条目，目标行 ${target.id}，行数 ${originalLines} → ${text.split('\n').length}`)
})

test('迁移：清掉旧版本注入到 stdio 行里的 PATH（配置里不该有宿主机路径）', async () => {
  /**
   * 0.5.x 写 stdio 行时会把宿主机整条 PATH 塞进 `config.env` —— 桌面启动的 Host 环境里
   * 没有 node，当时的做法是把它写进配置。现在只在启动子进程时注入，配置里那份是冗余的，
   * 而且有害：profile 变成「只在这台机器上对」，面板还会把几百字符的宿主机路径显示给用户。
   *
   * 升级时必须主动清掉，否则老用户的配置会一直带着一条错 PATH —— 新代码不再写它，
   * 但也不会去改已经存在的键。
   */
  usePlainIO()
  const content = `- insert:
    - id: mcp-context7
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: context7
        transport: stdio
        command: npx
        env:
          PATH: "/Users/someone/.dsh/runtimes/x/bin:/usr/bin:/bin"
          TOKEN: keep-me
    - id: mcp-http
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: http
        transport: streamable-http
        url: https://x.invalid/mcp
`
  const dir = makeProfile(content)
  const path = join(dir, 'cordis.patch.yml')
  await migratePanelConfig(ctxFor(dir))

  const after = readPatch(path)
  const stdio = findRowDeep(after, (item) => item.id === 'mcp-context7')
  const http = findRowDeep(after, (item) => item.id === 'mcp-http')

  assert.equal(stdio.config.env.PATH, undefined, 'PATH 必须被删掉')
  assert.equal(stdio.config.env.TOKEN, 'keep-me', '用户自己填的变量必须保留')
  assert.equal(http.config.env, undefined, '没有 env 的行不该被凭空造出来')
  const text = readFileSync(path, 'utf8')
  assert.doesNotMatch(text, /\/Users\/someone/, '宿主机路径不得留在配置里')
})

test('迁移：env 里只有 PATH 时，整个 env 键一起去掉（不留 env: {}）', async () => {
  usePlainIO()
  const content = `- insert:
    - id: mcp-only-path
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: onlypath
        transport: stdio
        command: node
        env:
          PATH: "/usr/bin:/bin"
`
  const dir = makeProfile(content)
  const path = join(dir, 'cordis.patch.yml')
  await migratePanelConfig(ctxFor(dir))
  const row = findRowDeep(readPatch(path), (item) => item.id === 'mcp-only-path')
  assert.equal(row.config.env, undefined, '空 env 不该留下一个 `env: {}`')
})
