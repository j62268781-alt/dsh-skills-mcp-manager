/**
 * patch/apply 接口测试：对真实临时目录里的 patch 文件跑 add / update / toggle / delete。
 * 注入直通的文件锁与原子写，断言 YAML 结果与自动备份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { applyRowOp, migrateServerEntries, setPatchIO } from '../src/patch/apply.js'

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

test('备份只留一个文件：反复操作不堆积，内容是「上一次操作前」的状态', async () => {
  const { ctx, text } = await fresh()
  const beforeFirst = await text()
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'first', transport: 'streamable-http',
    url: 'https://a.example/mcp',
  })

  const afterFirst = await findBackups(home)
  assert.equal(afterFirst.length, 1, `一次操作后只该有一个备份文件，实际 ${afterFirst.length}`)
  // 文件名固定、不带时间戳 —— 带时间戳正是此前堆积 135 个文件的成因
  assert.equal(basename(afterFirst[0]), 'cordis.patch.yml.bak')
  assert.equal(await readFile(afterFirst[0], 'utf8'), beforeFirst, '备份内容 = 上一次操作前的状态')

  // 再来一轮：文件数不能增长（真实环境里一天堆了 135 个，其中 130 个是纯重复）
  for (let round = 0; round < 8; round += 1) {
    await applyRowOp(ctx, {
      op: 'update', entryId: 'mcp-context7', serverName: `round${round}`, transport: 'streamable-http',
      url: `https://r${round}.example/mcp`,
    })
  }
  const later = await findBackups(home)
  assert.equal(later.length, 1, `9 次操作后仍应只有一个备份，实际 ${later.length}`)

  // 再写一次，确认滚动到「这一次之前」：单文件方案的语义就是撤销上一次操作
  const beforeFinal = await text()
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'final', transport: 'streamable-http',
    url: 'https://final.example/mcp',
  })
  const final = await findBackups(home)
  assert.equal(final.length, 1)
  assert.equal(await readFile(final[0], 'utf8'), beforeFinal, '滚动后的内容 = 最后一次操作前的状态')
  assert.match(await text(), /serverName: final/)
})

test('备份写入失败不能挡住正常改写', async () => {
  const { ctx, text } = await fresh()
  const broken = {
    withFileLock: (_key, run) => run(),
    writeFileAtomic: async (path, content) => writeFile(path, content, 'utf8'),
  }
  // 让 DSH_HOME 指向一个不可创建目录的位置，备份必然失败
  const original = process.env.DSH_HOME
  process.env.DSH_HOME = join(home, 'cordis.patch.yml', 'nested-cannot-exist')
  try {
    const changed = await applyRowOp(ctx, {
      op: 'update', entryId: 'mcp-context7', serverName: 'still-works', transport: 'streamable-http',
      url: 'https://ok.example/mcp',
    })
    assert.equal(changed, true, '备份失败也必须让改写继续')
    assert.match(await text(), /serverName: still-works/)
  } finally {
    process.env.DSH_HOME = original
    setPatchIO(broken)
  }
})

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

test('add：连接策略写进 config（failOnStartupError + reconnect）', async () => {
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, {
    op: 'add', entryId: 'mcp-github', serverName: 'github', transport: 'stdio',
    command: 'npx', args: '-y @modelcontextprotocol/server-github', env: '', url: '', headers: '',
    failOnStartupError: true,
    reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000', reconnectMaxAttempts: '60',
  })
  const out = await text()
  assert.match(out, /failOnStartupError: true/)
  assert.match(out, /reconnect:/)
  assert.match(out, /initialDelayMs: 1000/)
  assert.match(out, /maxDelayMs: 60000/)
  assert.match(out, /maxAttempts: 60/)
})

test('add：没填连接策略时写入**显式默认值**（表单与文件说的是同一件事）', async () => {
  /**
   * 以前空着就省略 `reconnect`，由 MCP 客户端补默认值。但表单会显示这些数字（预填），
   * 所以文件里也应当有：否则"表单显示 500"和"文件里没有"看起来是两回事，而真正生效的
   * 值住在 `dsh-mcp-client` 里。
   *
   * `failOnStartupError` 仍是条件的：false 与"键不存在"完全等价，写它只是噪音。
   */
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, {
    op: 'add', entryId: 'mcp-plain', serverName: 'plain', transport: 'streamable-http',
    command: '', args: '', env: '', url: 'https://plain/mcp', headers: '',
  })
  const out = await text()
  assert.doesNotMatch(out, /failOnStartupError/)
  assert.match(out, /initialDelayMs: 500/)
  assert.match(out, /maxDelayMs: 30000/)
  assert.match(out, /maxAttempts: 10/)
})

test('update：连接策略可写入，留空则删键回到默认', async () => {
  const { ctx, text } = await fresh()
  const base = { op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http', url: 'https://mcp.context7.com/mcp', connectionChanged: true }
  await applyRowOp(ctx, { ...base, failOnStartupError: true, reconnectMaxAttempts: '60', reconnectInitialDelayMs: '1000' })
  let out = await text()
  assert.match(out, /failOnStartupError: true/)
  assert.match(out, /maxAttempts: 60/)

  // 再保存一次但全部清空：回到**默认值**（显式写出），而不是留着上次的 60/1000
  await applyRowOp(ctx, { ...base })
  out = await text()
  assert.doesNotMatch(out, /failOnStartupError/)
  assert.match(out, /maxAttempts: 10/)
  assert.match(out, /initialDelayMs: 500/)
  assert.doesNotMatch(out, /maxAttempts: 60/)
})

test('update：没动过连接字段时，不碰已有的 reconnect（只改 URL 不能误删）', async () => {
  const { ctx, text } = await fresh()
  const base = { op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http' }
  // 先写入一整套连接策略
  await applyRowOp(ctx, { ...base, url: 'https://mcp.context7.com/mcp', connectionChanged: true,
    failOnStartupError: true, reconnectMaxAttempts: '60', reconnectInitialDelayMs: '1000' })
  let out = await text()
  assert.match(out, /reconnect/)
  assert.match(out, /failOnStartupError: true/)

  // 再只改 URL：面板没标记 connectionChanged，已有值必须原样保留
  await applyRowOp(ctx, { ...base, url: 'https://changed.example/mcp', connectionChanged: false })
  out = await text()
  assert.match(out, /https:\/\/changed\.example\/mcp/)
  assert.match(out, /maxAttempts: 60/, '只改 URL 却把 reconnect 删掉了')
  assert.match(out, /failOnStartupError: true/, '只改 URL 却把 failOnStartupError 删掉了')
})

test('update：标记了 connectionChanged 才按表单清空（回到默认）', async () => {
  const { ctx, text } = await fresh()
  const base = { op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http' }
  await applyRowOp(ctx, { ...base, url: 'https://mcp.context7.com/mcp', connectionChanged: true, reconnectMaxAttempts: '60' })
  assert.match(await text(), /maxAttempts: 60/)

  // 用户确实清空了输入框 → 回到显式默认值（不再是"删掉整块"）
  await applyRowOp(ctx, { ...base, url: 'https://mcp.context7.com/mcp', connectionChanged: true })
  const out = await text()
  assert.doesNotMatch(out, /failOnStartupError/)
  assert.match(out, /maxAttempts: 10/)
  assert.doesNotMatch(out, /maxAttempts: 60/)
})

test('update：越界的重连参数抛错且不写文件', async () => {
  const { ctx, text } = await fresh()
  const before = await text()
  await assert.rejects(
    () => applyRowOp(ctx, {
      op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http',
      url: 'https://mcp.context7.com/mcp', reconnectMaxAttempts: '0', connectionChanged: true,
    }),
    /reconnect\.maxAttempts 必须在 1–/,
  )
  assert.equal(await text(), before)
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

test('delete：行本来就不在时**成功**且不写文件（重试不该报错）', async () => {
  /**
   * 删除的目标状态是「这一行不在 patch 里」，而它已经成立。
   *
   * 以前这里抛 "not found"，那在队列通道下基本碰不到（Host 写 patch 前先清空队列）。
   * 但命令现在可以走 HTTP，请求会被重试、也会和周期投影赛跑 —— 若仍抛错，用户会为一次
   * **已经成功**的删除看到一个吓人的失败，而且什么也不用修。
   */
  const { ctx, text } = await fresh()
  const before = await text()
  assert.equal(await applyRowOp(ctx, { op: 'delete', entryId: 'mcp-ghost' }), true)
  assert.equal(await text(), before, '没有变化就不该动文件（也不该churn备份）')
})

test('未知 entryId 的其它操作仍然抛错且不写文件', async () => {
  const { ctx, text } = await fresh()
  const before = await text()
  // toggle/update 指向不存在的行是真错误：请求本身没有意义，必须让调用方知道。
  await assert.rejects(
    () => applyRowOp(ctx, { op: 'toggle', entryId: 'mcp-ghost', enabled: false }),
    /not found/,
  )
  assert.equal(await text(), before)
})

test('update：请求头可写入、可清空（headersChanged 为真时清空即删键）', async () => {
  const { ctx, text } = await fresh()
  // 写入
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp', headers: 'Authorization=Bearer sk-abc', headersChanged: true,
  })
  let out = await text()
  assert.match(out, /Authorization: Bearer sk-abc/)

  // 清空：headersChanged 为真 → 删键，不能留下空 headers: {}
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp', headers: '', headersChanged: true,
  })
  out = await text()
  assert.doesNotMatch(out, /Authorization/)
  assert.doesNotMatch(out, /headers/)
})

test('update：未改动的请求头不会被写坏（headersChanged 为假且字段为空）', async () => {
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp', headers: 'X-K=1', headersChanged: true,
  })
  assert.match(await text(), /X-K: 1|X-K: '1'|X-K: "1"/)

  // 旧面板没有回填该字段（headers 为空、headersChanged 为假）→ 只改 URL 不能动它
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'context7', transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp2', headers: '', headersChanged: false,
  })
  const out = await text()
  assert.match(out, /X-K/, '未改动的请求头必须保留')
  assert.match(out, /mcp2/)
})

test('update：stdio 的环境变量可写入、可清空（PATH 不再落盘）', async () => {
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'ctx', transport: 'stdio',
    command: 'npx', args: '-y pkg', env: 'TOKEN=abc', envChanged: true,
  })
  assert.match(await text(), /TOKEN: abc/)

  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'ctx', transport: 'stdio',
    command: 'npx', args: '-y pkg', env: '', envChanged: true,
  })
  const out = await text()
  // 用户填的变量被清掉，**PATH 也不该出现**。
  //
  // 这里原来断言「PATH 会留下」（spawnEnv 总要注入它）。那条注解现在已经不成立：PATH 属于
  // 运行环境而不是配置，改在启动子进程时注入（`stdioMountConfig`）。写进 yml 的代价是
  // profile 变成「只在这台机器上对」，而且面板会把那条几百字符的 PATH 显示给用户去编辑。
  assert.doesNotMatch(out, /TOKEN/)
  assert.doesNotMatch(out, /PATH/, `清空环境变量后不应残留任何 env（实际：${out.slice(0, 400)}）`)
})

test('env：用户填的变量原样写入，不注入宿主机 PATH', async () => {
  /**
   * PATH 是**运行环境**，不是配置。把它写进 profile 的后果：
   *   · 这份 profile 拷到另一台机器，PATH 就是错的；
   *   · 面板的「环境变量」文本框会把几百字符的宿主机路径显示给用户（既不该看见也不该编辑）；
   *   · 每次保存都重写一遍，diff 全是噪音。
   *
   * 启动子进程时本来就会注入（`stdioMountConfig` 还会把 `npx -y <pkg>` 换成内置 runtime
   * 的 node + pnpx），所以落盘那份从来是冗余的。
   */
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, {
    op: 'add', entryId: 'mcp-envonly', serverName: 'envonly', transport: 'stdio',
    command: 'node', args: 'server.js', env: 'TOKEN=abc\nFOO=bar', headers: '',
  })
  const out = await text()
  assert.match(out, /TOKEN: abc/, '用户填的变量必须保留')
  assert.match(out, /FOO: bar/, '第二个变量也要保留')
  assert.doesNotMatch(out, /PATH/, '不得注入宿主机 PATH')
  assert.doesNotMatch(out, /\/Users\//, '不得把宿主机路径写进 profile')
})

test('update：未改动的环境变量不会被写坏（envChanged 为假且字段为空）', async () => {
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'ctx', transport: 'stdio',
    command: 'npx', args: '-y pkg', env: 'TOKEN=keep', envChanged: true,
  })
  // 旧面板没回填 env：只改参数不能把已配好的令牌删掉
  await applyRowOp(ctx, {
    op: 'update', entryId: 'mcp-context7', serverName: 'ctx', transport: 'stdio',
    command: 'npx', args: '-y other', env: '', envChanged: false,
  })
  const out = await text()
  assert.match(out, /TOKEN: keep/, '未改动的环境变量必须保留')
  assert.match(out, /other/)
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

test('migrateServerEntries：把面板旧条目转成 mcp-client 行（含 scope），且不覆盖同名行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smp-migrate-servers-'))
  const patch = `- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: context7
        transport: streamable-http
        url: https://mcp.context7.com/mcp
`
  await writeFile(join(dir, 'cordis.patch.yml'), patch)
  const ctx = { get: (n) => (n === 'profileContext' ? { dir } : undefined), logger: { warn() {}, info() {}, error() {} } }

  const legacy = [
    { // 项目级：带 scope，行里必须体现出来
      scope: '/p/tcl', id: 'gitnexus', serverName: 'gitnexus', transport: 'streamable-http',
      url: 'http://x/mcp/coding', command: '', args: [], env: '', headers: '',
      failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000', reconnectMaxAttempts: '60',
    },
    { // stdio：args 要变成数组，env 要变成 dict
      scope: 'global', id: 'fs', serverName: 'fs-tools', transport: 'stdio',
      url: '', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: 'TOKEN=abc\nDEBUG=1', headers: '',
    },
    { // 已经存在同 id 的行：不能被覆盖
      scope: '/p/tcl', serverName: 'context7', transport: 'streamable-http', url: 'https://wrong/mcp',
    },
  ]
  const result = await migrateServerEntries(ctx, legacy)
  assert.equal(result.migrated, 2, '两条该迁，同 id 的那条要跳过')
  assert.deepEqual(result.ids, ['mcp-gitnexus', 'mcp-fs-tools'])

  const after = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
  const parsed = (await import('yaml')).parse(after)
  const rows = parsed.flatMap((r) => r?.insert ?? []).filter((r) => r?.name === '@deepseek-ai/dsh-mcp-client')
  const byId = new Map(rows.map((r) => [r.id, r.config ?? {}]))

  assert.equal(byId.get('mcp-gitnexus').scope, '/p/tcl', '项目级的 scope 必须写进行里')
  assert.equal(byId.get('mcp-gitnexus').url, 'http://x/mcp/coding')
  assert.equal(byId.get('mcp-gitnexus').failOnStartupError, true, '连接策略要一起搬过去')
  assert.deepEqual(byId.get('mcp-gitnexus').reconnect, { initialDelayMs: 1000, maxDelayMs: 60000, maxAttempts: 60 })

  // 项目级行必须 disabled：Loader 只看 disabled，不看 scope。不写它的话，同一台服务器
  // 会被 Loader 连一次、又被本插件按 agent 挂载一次 —— 两个客户端、两代工具、一个命名空间。
  const rawRows = parsed.flatMap((r) => r?.insert ?? [])
  const gitnexusRow = rawRows.find((r) => r.id === 'mcp-gitnexus')
  const fsRow = rawRows.find((r) => r.id === 'mcp-fs-tools')
  assert.equal(gitnexusRow.disabled, true, '项目级行必须标记 disabled（跳过 Loader 实例化）')
  assert.equal(fsRow.disabled, undefined, '全局行不该被标记 disabled')

  assert.equal(byId.get('mcp-fs-tools').transport, 'stdio')
  assert.deepEqual(byId.get('mcp-fs-tools').args, ['-y', 'server-filesystem', '/tmp'], 'args 要变成数组')
  assert.equal(byId.get('mcp-fs-tools').env.TOKEN, 'abc', 'env 要变成 dict')
  assert.equal('scope' in byId.get('mcp-fs-tools'), false, 'global 不写 scope 键（缺省即全局）')

  assert.equal(byId.get('mcp-context7').url, 'https://mcp.context7.com/mcp', '同名行不能被覆盖')

  // 幂等：再跑一次不应新增任何行
  const again = await migrateServerEntries(ctx, legacy)
  assert.equal(again.migrated, 0, '第二次运行必须是 no-op')
})

test('migrateServerEntries：行已存在时返回 0，调用方据此仍须清空旧字段', async () => {
  // 这个用例钉住一个真实踩过的坑：行写成功、但「清空旧字段」那一步锁超时失败时，
  // 下一次尝试会看到「行已存在」→ migrated=0。若调用方在 migrated===0 时直接返回，
  // 旧字段就永远清不掉，而面板会把同一台服务器显示两次（字段一次、行一次）。
  const dir = await mkdtemp(join(tmpdir(), 'smp-migrate-idem-'))
  await writeFile(join(dir, 'cordis.patch.yml'), `- insert:
    - id: mcp-gitnexus
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitnexus
        transport: streamable-http
        url: http://x/mcp
`)
  const ctx = { get: (n) => (n === 'profileContext' ? { dir } : undefined), logger: { warn() {}, info() {}, error() {} } }
  const legacy = [{ scope: '/p/tcl', serverName: 'gitnexus', transport: 'streamable-http', url: 'http://x/mcp' }]

  const result = await migrateServerEntries(ctx, legacy)
  assert.deepEqual(result, { migrated: 0, ids: [] },
    '行已在 → 不重复写（幂等），但调用方必须据此仍然清空旧字段')
})

const PROJECT_PATCH = `- insert:
    - id: mcp-gitnexus
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gitnexus
        transport: streamable-http
        url: http://sz-00575123-01/mcp/coding
        scope: /Users/someone/project
      disabled: true
`

/** A patch whose only row is **project-scoped** (永久 disabled，用户开关在 config.enabled）。 */
const freshProject = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smp-profile-'))
  await writeFile(join(dir, 'cordis.patch.yml'), PROJECT_PATCH)
  const ctx = { get: (n) => (n === 'profileContext' ? { dir } : undefined), logger: { warn() {}, info() {}, error() {} } }
  return { dir, ctx, text: () => readFile(join(dir, 'cordis.patch.yml'), 'utf8') }
}

test('toggle：项目级行开关写 config.enabled，**不动** Loader 的 disabled', async () => {
  /**
   * 项目级行有两个「启用」概念，绝不能混：
   *   · entry 级的 `disabled: true` —— 永久的，因为插件自己把行挂进匹配的 agent；
   *     Loader 一旦连接它，同一个服务器就会有两个客户端、两套工具。
   *   · config 级的 `enabled` —— 用户界面上那个开关。
   *
   * 之前 `toggle` 对所有行都写 entry 级 `disabled`，于是：关掉时写 `true` 覆盖本来就
   * 是 `true` 的值 → 没有变化 → 落到「row not found」；打开时清掉 `disabled` →
   * Loader 直接连接了插件也在挂载的行。前者表现为「点了没反应」。
   */
  const { ctx, text } = await freshProject()
  await applyRowOp(ctx, { op: 'toggle', entryId: 'mcp-gitnexus', enabled: false })
  const off = await text()
  assert.match(off, /enabled: false/, '停用必须写进 config.enabled')
  assert.match(off, /disabled: true/, 'Loader 的 disabled 必须保持 true（插件自己挂载）')

  await applyRowOp(ctx, { op: 'toggle', entryId: 'mcp-gitnexus', enabled: true })
  const on = await text()
  assert.doesNotMatch(on, /enabled: false/, '重新启用应清掉 config.enabled')
  assert.match(on, /disabled: true/, '重新启用后 disabled 仍然是 true')
})

test('toggle：全局行仍然写 entry 级 disabled（两种层级不能互换）', async () => {
  // 全局行由 Loader 自己连接，所以 `disabled` 就是它的开关。
  const { ctx, text } = await fresh()
  await applyRowOp(ctx, { op: 'toggle', entryId: 'mcp-context7', enabled: false })
  assert.match(await text(), /disabled: true/)
  assert.doesNotMatch(await text(), /enabled: false/, '全局行不该写 config.enabled')
})
