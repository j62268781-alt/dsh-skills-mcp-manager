/**
 * `runtime` 这条字段的**整条链路**：面板选择 → 命令 → yml → 读回 → 实际启动命令。
 *
 * ## 为什么需要专门一组测试
 *
 * 这个字段原先只存在于面板的 draft 里：`commonFields` 不发它、`RowOp` schema 里没有它、
 * `serverFromRow` 也不读它。于是那个「运行时」下拉是**纯装饰** —— 用户选什么都不会生效：
 *
 *   · 选「跟随 Harness」，实际仍走系统 npx（或反过来）；
 *   · 两者在 yml 里都不留痕迹，界面上也看不出异常。
 *
 * 用户的原话是「我选择 stdio 选择 harness 运行时，启动不起来，那不就是有 bug 了吗」——
 * 是 bug，而且是「控件不接线」这一类最难自己发现的 bug。这组测试把每一层都钉住，
 * 任何一层漏掉都会失败。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { applyRowOp, setPatchIO } from '../src/patch/apply.js'
import { serverRows } from '../src/mcp/serverRows.js'
import { stdioMountConfig } from '../src/project/mount.js'
import { addServerOp, draftFromRow } from '../lib/src/crud/servers.js'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'smp-rt-'))
  setPatchIO({ backupDir: () => join(dir, 'backups') })
  const patch = join(dir, 'cordis.patch.yml')
  await writeFile(patch, '[]\n')
  return { dir, patch, ctx: { get: () => ({ dir }), logger: { info: () => {}, warn: () => {} } } }
}

async function rowConfig(patch, serverName) {
  const doc = parseDocument(await readFile(patch, 'utf8'))
  for (const top of doc.contents.items) {
    const insert = top.get?.('insert')
    const candidates = insert ? insert.items : [top]
    for (const row of candidates) {
      const json = row.toJSON()
      if (json?.config?.serverName === serverName) return json.config
    }
  }
  return null
}

const draft = (runtime) => ({
  serverName: `probe-${runtime}`, transport: 'stdio', command: 'npx', args: '-y pkg',
  env: '', headers: '', url: '', runtime,
})

test('面板选择会进入命令（这是原先断掉的第一环）', () => {
  assert.equal(addServerOp(draft('system')).runtime, 'system')
  assert.equal(addServerOp(draft('auto')).runtime, 'auto')
  // 没传时按 system（可靠的那一侧），不是 pnpx
  assert.equal(addServerOp({ ...draft('auto'), runtime: undefined }).runtime, 'system')
})

test('system 不写键（默认），auto 落盘 runtime: auto', async () => {
  const { patch, ctx } = await scratch()
  await applyRowOp(ctx, addServerOp(draft('system')))
  await applyRowOp(ctx, addServerOp(draft('auto')))

  const sys = await rowConfig(patch, 'probe-system')
  const auto = await rowConfig(patch, 'probe-auto')
  assert.equal(sys.runtime, undefined, 'system 是默认值，不该写进 yml')
  assert.equal(auto.runtime, 'auto', 'auto 必须落盘，否则读回来就丢了')
})

test('从 yml 读回时 system 是缺省值（旧配置不能意外变成 pnpx）', () => {
  const entry = (config) => [{ id: 'mcp-x', options: { name: '@deepseek-ai/dsh-mcp-client', config } }]
  // 没有 runtime 键的旧行 → system
  assert.equal(serverRows(entry({ serverName: 'x', transport: 'stdio', command: 'npx' }))[0].runtime, 'system')
  // 显式 auto → auto
  assert.equal(serverRows(entry({ serverName: 'x', transport: 'stdio', command: 'npx', runtime: 'auto' }))[0].runtime, 'auto')
  // 乱七八糟的值 → 回落到 system，不猜
  assert.equal(serverRows(entry({ serverName: 'x', transport: 'stdio', command: 'npx', runtime: 'pnpx' }))[0].runtime, 'system')
})

test('最终启动命令：system 走系统 npx，auto 换成内置 node + pnpx', () => {
  const make = (runtime) => serverRows([{
    id: 'mcp-x', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], runtime } },
  }])[0]

  const viaSystem = stdioMountConfig(make('system'))
  assert.match(viaSystem.command, /npx$/, `system 应走系统 npx（收到 ${viaSystem.command}）`)

  const viaAuto = stdioMountConfig(make('auto'))
  assert.match(viaAuto.command, /node$/, `auto 应换成内置 node（收到 ${viaAuto.command}）`)
  assert.ok(viaAuto.args.some((a) => /pnpx\.mjs$/.test(a)), 'auto 应走 pnpx')
})

test('编辑读回：draftFromRow 保留 auto，不会被重置成 system', () => {
  const row = {
    serverName: 'x', transport: 'stdio', command: 'npx', args: '-y pkg', env: '', headersText: '',
    runtime: 'auto', target: 'npx -y pkg', enabled: true, phase: '',
  }
  assert.equal(draftFromRow(row).runtime, 'auto', '用户选过的 auto 必须回填，否则一编辑就被悄悄改掉')
})
