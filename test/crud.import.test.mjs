/** crud/import 接口测试：同名跳过、请求构造、按钮文案。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importLabel, importRequest, nextNonce, splitImport, takenNames } from '../lib/src/crud/import.js'

const rows = [{ serverName: 'context7' }, { serverName: 'github' }]
const found = [
  { serverName: 'context7', transport: 'streamable-http' },
  { serverName: 'new-tool', transport: 'stdio' },
]

test('takenNames：全局看配置行，项目级只看同项目的条目', () => {
  assert.deepEqual([...takenNames({ scope: 'global', profileRows: rows })], ['context7', 'github'])
  const servers = [
    { serverName: 'a', scope: '/p/app' },
    { serverName: 'b', scope: '/p/other' },
  ]
  assert.deepEqual([...takenNames({ scope: 'project', target: '/p/app', servers })], ['a'])
})

test('splitImport：同名进 skipped，其余进 fresh（不覆盖）', () => {
  const { fresh, skipped } = splitImport(found, takenNames({ scope: 'global', profileRows: rows }))
  assert.deepEqual(fresh.map((s) => s.serverName), ['new-tool'])
  assert.deepEqual(skipped.map((s) => s.serverName), ['context7'])
})

test('importRequest：全局不带项目路径，项目级带上', () => {
  assert.deepEqual(importRequest({ source: 'claude', scope: 'global', project: '/p/x', nonce: 1 }),
    { source: 'claude', scope: 'global', project: '', nonce: '1' })
  assert.equal(importRequest({ source: 'cursor', scope: 'project', project: '/p/x', nonce: 2 }).project, '/p/x')
})

test('nextNonce / importLabel：nonce 唯一，文案带跳过数', () => {
  assert.notEqual(nextNonce('claude', 1), nextNonce('claude', 2))
  assert.equal(importLabel({ scope: 'global', fresh: 1, skipped: 2 }), '导入 1 个到配置文件（跳过 2 个）')
  assert.equal(importLabel({ scope: 'project', fresh: 3, skipped: 0 }), '导入 3 个')
})
