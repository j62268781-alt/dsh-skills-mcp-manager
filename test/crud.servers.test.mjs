/** crud/servers 接口测试：四种行操作的构造与草稿/条目的转换。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addServerOp, deleteServerOp, draftFromRow, inflightKeyForRow, removeProjectEntry,
  replaceProjectEntry, rowEntryId, toggleServerOp, updateServerOp,
} from '../lib/src/crud/servers.js'

test('rowEntryId / inflightKeyForRow：id 与投影 entryId 的对应', () => {
  assert.equal(rowEntryId('12306-mcp'), 'mcp-12306-mcp')
  assert.equal(inflightKeyForRow('mcp-x'), 'include:mcp-x')
  assert.equal(inflightKeyForRow('include:mcp-x'), 'include:mcp-x')
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

test('draftFromRow：编辑表单用 target 回填地址', () => {
  const draft = draftFromRow({ serverName: 'x', transport: 'stdio', target: 'npx', args: '-y p', env: 'T=1' })
  assert.equal(draft.command, '')
  assert.equal(draft.url, 'npx')
  assert.equal(draft.args, '-y p')
  assert.equal(draft.env, 'T=1')
  assert.equal(draft.runtime, 'auto')
})

test('replaceProjectEntry / removeProjectEntry：按身份替换与删除', () => {
  const a = { serverName: 'a' }
  const b = { serverName: 'b' }
  const servers = [a, b]
  assert.deepEqual(replaceProjectEntry(servers, a, { serverName: 'a2' })[0], { serverName: 'a2' })
  assert.deepEqual(removeProjectEntry(servers, a), [b])
})
