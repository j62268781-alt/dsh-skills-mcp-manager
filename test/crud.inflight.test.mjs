/** crud/inflight 接口测试：标记、完成判定与安全超时。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TIMEOUT, UPDATE_GRACE, hasSettled, isPending, markInflight, pendingAdds, pendingLabel, settleInflight,
} from '../lib/src/crud/inflight.js'

const rows = [{ entryId: 'include:mcp-a', serverName: 'a', enabled: true }]

test('markInflight / isPending：按 entryId 记录', () => {
  const map = markInflight({}, 'include:mcp-a', { kind: 'delete' })
  assert.equal(isPending(map, 'include:mcp-a'), true)
  assert.equal(isPending(map, 'include:mcp-b'), false)
})

test('pendingLabel：四类操作各自的文案', () => {
  assert.equal(pendingLabel({ kind: 'delete' }), '删除中…')
  assert.equal(pendingLabel({ kind: 'toggle' }), '切换中…')
  assert.equal(pendingLabel({ kind: 'add' }), '正在写入配置文件…')
  assert.equal(pendingLabel({ kind: 'update' }), '保存中…')
})

test('hasSettled：删除看行消失、切换看期望值、新增看行出现', () => {
  const at = 1000
  assert.equal(hasSettled({ kind: 'delete', at }, undefined, at + 10), true)
  assert.equal(hasSettled({ kind: 'delete', at }, rows[0], at + 10), false)
  assert.equal(hasSettled({ kind: 'toggle', at, expectEnabled: true }, rows[0], at + 10), true)
  assert.equal(hasSettled({ kind: 'toggle', at, expectEnabled: false }, rows[0], at + 10), false)
  assert.equal(hasSettled({ kind: 'toggle', at, expectEnabled: false }, undefined, at + 10), true, '行已消失即算完成')
  assert.equal(hasSettled({ kind: 'add', at }, rows[0], at + 10), true)
  assert.equal(hasSettled({ kind: 'add', at }, undefined, at + 10), false)
})

test('hasSettled：编辑看名称变化，超宽限期也算完成（避免永久转圈）', () => {
  const at = 1000
  assert.equal(hasSettled({ kind: 'update', at, expectName: 'a' }, rows[0], at + 10), true)
  assert.equal(hasSettled({ kind: 'update', at, expectName: 'zzz' }, rows[0], at + 10), false)
  assert.equal(hasSettled({ kind: 'update', at, expectName: 'zzz' }, rows[0], at + UPDATE_GRACE + 1), true)
})

test('settleInflight：已达成的移除、未达成的保留；无变化时返回同一实例', () => {
  const map = { 'include:mcp-a': { kind: 'toggle', at: 1000, expectEnabled: false } }
  const same = settleInflight(map, { profileRows: rows, now: 1010 })
  assert.equal(same, map, '未达成时应原样返回，便于 React 跳过渲染')

  const settled = settleInflight(map, { profileRows: [], now: 1010 })
  assert.deepEqual(settled, {}, '行已消失 → 操作完成')
})

test('settleInflight：安全超时兜底（行仍在、状态未变 → 一直等）', () => {
  const map = { 'include:mcp-x': { kind: 'toggle', at: 1000, expectEnabled: false } }
  const waitRows = [{ entryId: 'include:mcp-x', serverName: 'x', enabled: true }]
  const kept = settleInflight(map, { profileRows: waitRows, now: 1000 + DEFAULT_TIMEOUT - 1 })
  assert.deepEqual(Object.keys(kept), ['include:mcp-x'])
  const dropped = settleInflight(map, { profileRows: waitRows, now: 1000 + DEFAULT_TIMEOUT })
  assert.deepEqual(dropped, {})
})

test('pendingAdds：只列还没出现的新增项', () => {
  const map = { 'include:mcp-new': { kind: 'add', at: 1 }, 'include:mcp-a': { kind: 'add', at: 1 }, 'include:mcp-b': { kind: 'delete', at: 1 } }
  assert.deepEqual(pendingAdds(map, rows).map(([id]) => id), ['include:mcp-new'])
})
