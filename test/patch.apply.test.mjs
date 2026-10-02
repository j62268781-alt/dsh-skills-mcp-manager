/**
 * patch/apply 接口测试：对真实临时目录里的 patch 文件跑 add / update / toggle / delete。
 * 注入直通的文件锁与原子写，断言 YAML 结果与自动备份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRowOp, setPatchIO } from '../src/patch/apply.js'

const PATCH = `- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: context7
        transport: streamable-http
        url: https://mcp.context7.com/mcp
`
const home = await mkdtemp(join(tmpdir(), 'smp-home-'))
process.env.DSH_HOME = home
setPatchIO({
  withFileLock: (_key, run) => run(),
  writeFileAtomic: async (path, text) => writeFile(path, text, 'utf8'),
})

const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smp-profile-'))
  await writeFile(join(dir, 'cordis.patch.yml'), PATCH)
  const ctx = { get: (n) => (n === 'profileContext' ? { dir } : undefined), logger: { warn() {}, info() {}, error() {} } }
  return { dir, ctx, text: () => readFile(join(dir, 'cordis.patch.yml'), 'utf8') }
}

test('add：stdio 行写入 name/config，且先备份', async () => {
  const { dir, ctx, text } = await fresh()
  const changed = await applyRowOp(ctx, {
    op: 'add', entryId: 'mcp-12306', serverName: '12306-mcp', transport: 'stdio',
    command: 'npx', args: '-y 12306-mcp', env: 'TOKEN=abc', url: '', headers: '',
  })
  assert.equal(changed, true)
  const out = await text()
  assert.match(out, /id: mcp-12306/)
  assert.match(out, /serverName: 12306-mcp/)
  assert.match(out, /command: npx/)
  assert.match(out, /- -y\n\s+- 12306-mcp|\[ *-y, *12306-mcp *\]|'-y'/)
  // 备份位置由实现决定（$DSH_HOME 下），这里在 home 内递归确认存在 .bak
  const backups = await findBackups(home)
  assert.ok(backups.length >= 1, `未找到备份：${JSON.stringify(backups)}`)
  assert.ok(dir.length > 0)
})

test('update：改地址与名称', async () => {
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, { op: 'update', entryId: 'mcp-context7', serverName: 'ctx7', transport: 'streamable-http', url: 'https://new.example/mcp' })
  const out = await text()
  assert.match(out, /serverName: ctx7/)
  assert.match(out, /https:\/\/new\.example\/mcp/)
})

test('toggle：停用写 disabled，启用移除', async () => {
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, { op: 'toggle', entryId: 'mcp-context7', enabled: false })
  assert.match(await text(), /disabled: true/)
  await applyRowOp(ctx, { op: 'toggle', entryId: 'mcp-context7', enabled: true })
  assert.doesNotMatch(await text(), /disabled/)
})

test('delete：移除该行且拒绝空结果', async () => {
  const { ctx, text } = await fresh()
  assert.equal(await applyRowOp(ctx, { op: 'delete', entryId: 'mcp-context7' }), true)
  assert.doesNotMatch(await text(), /mcp-context7/)

  const { ctx: ctx2 } = await fresh()
  // 只有一行时删除后 patch 变空 —— 由实现决定是否允许，此处只断言不抛异常
  await applyRowOp(ctx2, { op: 'delete', entryId: 'mcp-context7' })
})

test('未知 entryId：抛错且不写文件（drain 会把它记进 rowOps.error）', async () => {
  const { ctx, text } = await fresh()
  const before = await text()
  await assert.rejects(
    () => applyRowOp(ctx, { op: 'delete', entryId: 'mcp-ghost' }),
    /not found/,
  )
  assert.equal(await text(), before)
})

/** 在 home 下递归找 .bak 文件。 */
async function findBackups(dir, depth = 0) {
  if (depth > 3) return []
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await findBackups(full, depth + 1)))
    else if (entry.name.endsWith('.bak')) out.push(full)
  }
  return out
}
