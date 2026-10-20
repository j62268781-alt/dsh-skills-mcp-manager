/**
 * 导入 → 写入 profile patch 的**端到端**测试。
 *
 * ## 为什么需要这一条
 *
 * 导入被拆成了两段：`POST /import` 只**扫描**（返回预览，绝不写盘），面板再对每一台调
 * `POST /rows` 的 add。两段各自都有测试，但**接缝**没有 —— 而接缝正是最容易坏的地方：
 *
 *   · 扫描出来的字段名（`args` 是数组、`env`/`headers` 是对象）与 `RowOp` 的字段名
 *     （`args` 是空格串、`env`/`headers` 是 `KEY=VALUE` 多行串）**不一样**，转换只发生在
 *     面板那一行 `addServerOp({...})` 里；
 *   · 转换错了不会报错：行照样写进 yml，只是 stdio 行少了参数、http 行丢了 Authorization，
 *     表现为「导入成功但服务器连不上」。
 *
 * 所以这里从真实的外部配置文件开始，走完整条链路，最后断言 **yml 里的每个字段**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { applyRowOp, setPatchIO } from '../src/patch/apply.js'
import { scanImportSource } from '../src/import/scan.js'
import { addServerOp } from '../lib/src/crud/servers.js'

/** 一个临时 profile：`cordis.patch.yml` 为空列表，备份写到自己的目录。 */
async function scratchProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'smp-import-'))
  setPatchIO({ backupDir: () => join(dir, 'backups') })
  const patch = join(dir, 'cordis.patch.yml')
  await writeFile(patch, '[]\n')
  return { dir, patch, ctx: { get: () => ({ dir }), logger: { info: () => {}, warn: () => {} } } }
}

/** 把 patch 里的 mcp-client 行读成 `{ id, disabled, config }`。 */
async function rowsOf(patch) {
  const doc = parseDocument(await readFile(patch, 'utf8'))
  assert.equal(doc.errors.length, 0, '写出来的 patch 必须是合法 YAML')
  const out = []
  for (const top of doc.contents.items) {
    const insert = top.get?.('insert')
    if (insert === undefined || insert === null) continue
    for (const row of insert.items) out.push(row.toJSON())
  }
  return out
}

const noopLog = { info: () => {}, warn: () => {} }

test('导入：扫描结果经面板转换后，stdio 的 command/args/env 正确落进 yml', async () => {
  /**
   * 面板那一行 `addServerOp({ args: (server.args ?? []).join(' '), env: server.env ?? '' })`
   * 是**唯一**做形状转换的地方。写错了 yml 照样生成，只是启动时 npx 没有参数、少了环境变量
   * —— 看起来「导入成功」，实际连不上。所以这里逐字段断言落盘结果。
   */
  const { dir, patch, ctx } = await scratchProfile()
  const project = join(dir, 'proj')
  await mkdir(join(project, '.cursor'), { recursive: true })
  await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'stdio-srv': { command: 'npx', args: ['-y', '@scope/pkg'], env: { TOKEN: 'abc' } },
    },
  }))

  const scan = scanImportSource('project', project, 'cursor')
  assert.equal(scan.servers.length, 1, `扫描应识别出 1 台：${JSON.stringify(scan)}`)
  const server = scan.servers[0]

  // 面板的转换，逐字照抄 lib/src/client.js 里 导入 的 onClick
  await applyRowOp(ctx, addServerOp({
    serverName: server.serverName, transport: server.transport,
    url: server.transport === 'stdio' ? '' : server.url,
    command: server.transport === 'stdio' ? server.command : '',
    args: server.transport === 'stdio' ? (server.args ?? []).join(' ') : '',
    env: server.env ?? '', headers: server.headers ?? '',
    scope: project, scopeChanged: true,
  }))

  const rows = await rowsOf(patch)
  assert.equal(rows.length, 1, '应写入一行')
  const [row] = rows
  assert.equal(row.config.serverName, 'stdio-srv')
  assert.equal(row.config.transport, 'stdio')
  assert.equal(row.config.command, 'npx')
  assert.deepEqual(row.config.args, ['-y', '@scope/pkg'], `args 必须还原成数组（收到 ${JSON.stringify(row.config.args)}）`)
  assert.equal(row.config.env.TOKEN, 'abc', 'env 里的用户变量不能丢')
  assert.equal(row.config.scope, project, '项目级导入必须带上 scope')
  assert.equal(row.disabled, true, '项目行必须是 disabled: true（否则 Loader 会重复连接）')
  assert.equal(noopLog.info(), undefined)
})

test('导入：http 行的 url 与 headers 正确落进 yml', async () => {
  /**
   * `headers` 从对象转成 `KEY=VALUE` 多行串再解析回来，是一条容易丢东西的往返。
   * 丢了 Authorization 的 http 行能连上，但每次都被 401 —— 而面板会显示「已连接」以外的
   * 状态，用户很难联想到是导入时丢的。
   */
  const { dir, patch, ctx } = await scratchProfile()
  const project = join(dir, 'proj')
  await mkdir(join(project, '.cursor'), { recursive: true })
  await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      'http-srv': {
        url: 'https://api.example/mcp',
        headers: { Authorization: 'Bearer t', 'X-Trace': 'on' },
      },
    },
  }))

  const scan = scanImportSource('project', project, 'cursor')
  const server = scan.servers.find((item) => item.serverName === 'http-srv')
  assert.ok(server !== undefined, `扫描应识别出 http-srv：${JSON.stringify(scan)}`)

  await applyRowOp(ctx, addServerOp({
    serverName: server.serverName, transport: server.transport,
    url: server.url, command: '', args: '', env: '',
    headers: server.headers ?? '',
    scope: '', scopeChanged: false,
  }))

  const rows = await rowsOf(patch)
  const row = rows.find((item) => item.config.serverName === 'http-srv')
  assert.ok(row !== undefined, '应写入 http-srv 一行')
  assert.equal(row.config.transport, 'streamable-http')
  assert.equal(row.config.url, 'https://api.example/mcp')
  assert.deepEqual(row.config.headers, { Authorization: 'Bearer t', 'X-Trace': 'on' },
    `headers 不能丢（收到 ${JSON.stringify(row.config.headers)}）`)
  assert.equal(row.disabled, undefined, '全局行不该有 disabled')
  assert.equal(row.config.scope, undefined, 'global 不写 scope 键（缺省即全局）')
})

test('导入多台：一次导入把每一台都写进去，不互相覆盖', async () => {
  // 面板用 `for (const server of result.servers) void sendRowOp(...)` 逐台发命令，
  // 并发发出。每一台都必须自己成行 —— 写成「最后一条赢」就只剩一台。
  const { dir, patch, ctx } = await scratchProfile()
  const project = join(dir, 'proj')
  await mkdir(join(project, '.cursor'), { recursive: true })
  await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      alpha: { url: 'https://a.example/mcp' },
      beta: { url: 'https://b.example/mcp' },
      gamma: { command: 'node', args: ['server.js'] },
    },
  }))

  const scan = scanImportSource('project', project, 'cursor')
  assert.equal(scan.servers.length, 3, `扫描应识别 3 台：${JSON.stringify(scan.servers)}`)

  for (const server of scan.servers) {
    await applyRowOp(ctx, addServerOp({
      serverName: server.serverName, transport: server.transport,
      url: server.transport === 'stdio' ? '' : server.url,
      command: server.transport === 'stdio' ? server.command : '',
      args: server.transport === 'stdio' ? (server.args ?? []).join(' ') : '',
      env: server.env ?? '', headers: server.headers ?? '',
      scope: '', scopeChanged: false,
    }))
  }

  const rows = await rowsOf(patch)
  assert.deepEqual(
    rows.map((row) => row.config.serverName).sort(),
    ['alpha', 'beta', 'gamma'],
    `三台都要在（实际 ${JSON.stringify(rows.map((r) => r.config.serverName))}）`,
  )
})

test('导入同一台两次：按行 id 收敛，不会写出两行', async () => {
  /**
   * 「导入」可以被点两次（手滑、重试）。行 id 由服务器名推出（`mcp-<name>`），所以第二次
   * 应当是**同一个行**被替换，而不是多一行。多出来的一行会让同一个服务器被连接两次。
   */
  const { dir, patch, ctx } = await scratchProfile()
  const project = join(dir, 'proj')
  await mkdir(join(project, '.cursor'), { recursive: true })
  await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { dup: { url: 'https://first.example/mcp' } },
  }))

  const scan = scanImportSource('project', project, 'cursor')
  const server = scan.servers[0]
  const op = addServerOp({
    serverName: server.serverName, transport: server.transport,
    url: server.url, command: '', args: '', env: '', headers: '',
    scope: '', scopeChanged: false,
  })
  await applyRowOp(ctx, op)
  // 第二次：URL 变了，但仍是同一台服务器
  await applyRowOp(ctx, { ...op, url: 'https://second.example/mcp' })

  const rows = await rowsOf(patch)
  assert.equal(rows.filter((row) => row.config.serverName === 'dup').length, 1, '重名导入只能有一行')
  assert.equal(rows[0].config.url, 'https://second.example/mcp', '第二次导入应覆盖成最新配置')
})

test('导入扫描本身绝不写盘（写文件只能由 /rows 触发）', async () => {
  /**
   * 这是设计约束，不是巧合：扫描要能被用户**预览后取消**。如果扫描顺手写盘，
   * 点「扫描」就等于已经改了配置，「取消」无从谈起。而 `/import` 路由的 `scan` 回调
   * 明确「never writes anything」（见 src/import/route.js），这里把它钉住。
   */
  const { dir, patch } = await scratchProfile()
  const before = await readFile(patch, 'utf8')
  const project = join(dir, 'proj')
  await mkdir(join(project, '.cursor'), { recursive: true })
  await writeFile(join(project, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { x: { url: 'https://x/mcp' }, y: { command: 'node' } },
  }))

  const scan = scanImportSource('project', project, 'cursor')
  assert.ok(scan.servers.length > 0, '前提：扫描确实读到了东西')
  assert.equal(await readFile(patch, 'utf8'), before, '扫描不得改动 patch')
})
