/** crud/servers 接口测试：四种行操作的构造与草稿/条目的转换。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addServerOp, connectionChanged, connectionDraft, deleteServerOp, draftFromRow, envChanged, headersChanged,
  inflightKeyForRow, rowEntryId, toggleServerOp, updateServerOp,
} from '../lib/src/crud/servers.js'

test('rowEntryId / inflightKeyForRow：两种 entryId 归一成同一个键', () => {
  assert.equal(rowEntryId('12306-mcp'), 'mcp-12306-mcp')
  // File rows carry `mcp-x`, Loader entries carry `include:mcp-x`; the in-flight key must
  // be the same or an add leaves its optimistic card next to the real one.
  assert.equal(inflightKeyForRow('mcp-x'), 'mcp-x')
  assert.equal(inflightKeyForRow('include:mcp-x'), 'mcp-x')
})

test('addServerOp：补默认传输、参数按字符串透传', () => {
  const op = addServerOp({ serverName: 'x', command: 'npx', args: '-y pkg' })
  assert.equal(op.op, 'add')
  assert.equal(op.entryId, 'mcp-x')
  assert.equal(op.transport, 'streamable-http')
  assert.equal(op.args, '-y pkg')
  assert.equal(op.env, '')
})

test('updateServerOp：沿用原行 id', () => {
  const op = updateServerOp('include:mcp-x', { serverName: 'x2', transport: 'stdio', command: 'node' })
  assert.equal(op.op, 'update')
  assert.equal(op.entryId, 'include:mcp-x')
  assert.equal(op.transport, 'stdio')
})

test('toggleServerOp / deleteServerOp：只带必要字段', () => {
  assert.deepEqual(toggleServerOp('mcp-x', false), { op: 'toggle', entryId: 'mcp-x', enabled: false })
  assert.deepEqual(deleteServerOp('mcp-x'), { op: 'delete', entryId: 'mcp-x' })
})

test('draftFromRow：stdio 行用原始 command 回填，不用拼好的 target', () => {
  // target 是「命令 + 参数」拼出来的：塞回 command 会把 `npx -y pkg` 当成可执行文件
  const draft = draftFromRow({ serverName: 'x', transport: 'stdio', target: 'npx -y p', command: 'npx', args: '-y p', env: 'T=1' })
  assert.equal(draft.command, 'npx')
  assert.equal(draft.url, '')
  assert.equal(draft.args, '-y p')
  assert.equal(draft.env, 'T=1')
  // 没写 runtime 的行按 `system` 读（可靠的默认），**不是** `auto`。
  //
  // 这里原先是 `'auto'`，锁的是旧默认 —— 而 `auto` 走的 pnpx 在真机上会
  // `Cannot find package 'zod'` 直接退出，所以默认值换成了 system。
  assert.equal(draft.runtime, 'system')
})

test('draftFromRow：runtime 回填行里的实际值（选过 auto 不能被悄悄改回 system）', () => {
  // 写死默认值会让「编辑一次就丢掉用户的选择」，而且改动发生在用户没碰过的控件上。
  const viaAuto = draftFromRow({ serverName: 'x', transport: 'stdio', command: 'npx', args: '', runtime: 'auto' })
  assert.equal(viaAuto.runtime, 'auto')
  const viaSystem = draftFromRow({ serverName: 'x', transport: 'stdio', command: 'npx', args: '', runtime: 'system' })
  assert.equal(viaSystem.runtime, 'system')
})

test('draftFromRow：http 行用 url 回填地址', () => {
  const draft = draftFromRow({ serverName: 'y', transport: 'streamable-http', target: 'https://y/mcp', url: 'https://y/mcp' })
  assert.equal(draft.url, 'https://y/mcp')
  assert.equal(draft.command, '')
})

test('draftFromRow：回填连接策略，缺省为空', () => {
  const tuned = draftFromRow({
    serverName: 'x', transport: 'stdio', command: 'npx', args: '',
    failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxAttempts: '60',
  })
  assert.equal(tuned.failOnStartupError, true)
  assert.equal(tuned.reconnectInitialDelayMs, '1000')
  assert.equal(tuned.reconnectMaxAttempts, '60')
  assert.equal(tuned.reconnectMaxDelayMs, '')
})

test('connectionChanged：只有真改过才算改动（防止误删已有配置）', () => {
  const row = { failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxAttempts: '60' }
  // 表单已正确回填，用户没动过 → 不算改动
  assert.equal(connectionChanged(connectionDraft(row), row), false)
  // 表单没有回填（旧 Host 不投影这些字段）→ 也不能算改动
  assert.equal(connectionChanged({ serverName: 'x', transport: 'streamable-http' }, undefined), false)
  assert.equal(connectionChanged(connectionDraft(row), undefined), false, '没有 original 时必须是 no-op')
  // 真改了一个数字 / 清空了一个数字 / 切换勾选框 → 算改动
  assert.equal(connectionChanged({ ...connectionDraft(row), reconnectMaxAttempts: '30' }, row), true)
  assert.equal(connectionChanged({ ...connectionDraft(row), reconnectInitialDelayMs: '' }, row), true)
  assert.equal(connectionChanged({ ...connectionDraft(row), failOnStartupError: false }, row), true)
  // 反过来：原来没配、现在填了 → 也算改动
  assert.equal(connectionChanged({ ...connectionDraft(row) }, {}), true)
})

test('updateServerOp：把「是否改过连接字段」带进 op', () => {
  const row = { failOnStartupError: true, reconnectMaxAttempts: '60' }
  const draft = connectionDraft(row)
  assert.equal(updateServerOp('mcp-x', draft, row).connectionChanged, false)
  assert.equal(updateServerOp('mcp-x', { ...draft, reconnectMaxAttempts: '30' }, row).connectionChanged, true)
  assert.equal(updateServerOp('mcp-x', draft).connectionChanged, false, '缺少 original 时必须保守地判为未改动')
})

test('addServerOp / updateServerOp：带上连接策略字段', () => {
  const draft = {
    serverName: 'x', transport: 'stdio', command: 'npx',
    failOnStartupError: true, reconnectInitialDelayMs: '1000', reconnectMaxDelayMs: '60000', reconnectMaxAttempts: '60',
  }
  for (const op of [addServerOp(draft), updateServerOp('mcp-x', draft)]) {
    assert.equal(op.failOnStartupError, true)
    assert.equal(op.reconnectInitialDelayMs, '1000')
    assert.equal(op.reconnectMaxDelayMs, '60000')
    assert.equal(op.reconnectMaxAttempts, '60')
  }
  // 没填时是空值，Host 会跳过这些键（用客户端默认）
  const plain = addServerOp({ serverName: 'x' })
  assert.equal(plain.failOnStartupError, false)
  assert.equal(plain.reconnectMaxAttempts, '')
})

test('draftFromRow：http 行回填请求头，否则一次「只改 URL」会删掉鉴权头', () => {
  const draft = draftFromRow({
    serverName: 'x', transport: 'streamable-http', url: 'https://x/mcp',
    headersText: 'Authorization=Bearer sk-abc',
  })
  assert.equal(draft.headers, 'Authorization=Bearer sk-abc')
  // 配置对象形态（项目级条目）也要能回填
  const fromObject = draftFromRow({ transport: 'streamable-http', url: 'https://y/mcp', headers: { 'X-Api-Key': 'k' } })
  assert.equal(fromObject.headers, 'X-Api-Key=k')
  // stdio 行不带请求头
  assert.equal(draftFromRow({ transport: 'stdio', command: 'npx', headers: { A: '1' } }).headers, '')
})

test('headersChanged / envChanged：仅真改动才写，缺 original 时保守为 false', () => {
  const row = { transport: 'streamable-http', headersText: 'A=1' }
  // 未动
  assert.equal(headersChanged({ headers: 'A=1' }, row), false)
  // 改了值
  assert.equal(headersChanged({ headers: 'A=2' }, row), true)
  // 清空 = 要删键，必须算改动
  assert.equal(headersChanged({ headers: '' }, row), true)
  // 没有 original（旧版 Host 不投影该字段）→ 不能当成「用户清空了」
  assert.equal(headersChanged({ headers: '' }, undefined), false)
  assert.equal(headersChanged({ headers: '' }, null), false)

  const envRow = { env: 'T=1' }
  assert.equal(envChanged({ env: 'T=1' }, envRow), false)
  assert.equal(envChanged({ env: '' }, envRow), true)
  assert.equal(envChanged({ env: '' }, undefined), false)
})

test('updateServerOp：带上环境变量与请求头的改动标记', () => {
  const op = updateServerOp('include:mcp-x', { serverName: 'x', headers: 'A=2' }, { transport: 'streamable-http', headersText: 'A=1' })
  assert.equal(op.headersChanged, true)
  assert.equal(op.envChanged, false)
})
