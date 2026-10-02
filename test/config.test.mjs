/** config 接口测试：三种 form 形状的归一化与数组字段读取。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listOf, snapshotOf, statusOf } from '../lib/src/config.js'

test('snapshotOf：getSnapshot().value / store / 裸 snapshot / 空', () => {
  assert.deepEqual(snapshotOf({ getSnapshot: () => ({ value: { a: 1 } }) }), { a: 1 })
  assert.deepEqual(snapshotOf({ store: { getSnapshot: () => ({ value: { b: 2 } }) } }), { b: 2 })
  assert.deepEqual(snapshotOf({ snapshot: { value: { c: 3 } } }), { c: 3 })
  assert.deepEqual(snapshotOf(null), {})
  assert.deepEqual(snapshotOf({}), {})
})

test('statusOf：默认 ready，可读出控制器状态', () => {
  assert.equal(statusOf({}), 'ready')
  assert.equal(statusOf({ getSnapshot: () => ({ status: 'loading' }) }), 'loading')
})

test('listOf：数组字段原样返回，非数组/缺失一律空数组', () => {
  const form = { getSnapshot: () => ({ value: { servers: [{ serverName: 'a' }], skills: null } }) }
  assert.deepEqual(listOf(form, 'servers'), [{ serverName: 'a' }])
  assert.deepEqual(listOf(form, 'skills'), [])
  assert.deepEqual(listOf(form, 'missing'), [])
  assert.deepEqual(listOf(null, 'servers'), [])
})
