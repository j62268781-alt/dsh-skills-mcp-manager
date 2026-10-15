/**
 * MCP 列表的展示顺序。
 *
 * 钉住两条用户可见的规则，它们很容易在后续维护里被"顺手"改掉：
 *   · 全局第一，然后按**工作区注册表顺序**分组；注册表不认识的作用域排在最后
 *   · 同一组内保持配置文件的行顺序（= 创建顺序），所以新增的排在自己工作区最后一个
 *
 * 分组**不产生分区标题**：面板此前有意去掉了「全局 MCP / 项目级 MCP」两个区块，
 * 因为两档只是同一种东西差一个 scope 字段。这里验证的是顺序，不是标题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderedScopeGroups, scopeKey } from '../lib/src/components/scopeOrder.js'

const srv = (serverName, scope = '') => ({ serverName, scope, entryId: `mcp-${serverName}` })
const names = (groups) => groups.map((group) => group.items.map((row) => row.serverName))

test('scopeKey：缺省与 global 都是全局档，其它路径原样', () => {
  assert.equal(scopeKey(undefined), '')
  assert.equal(scopeKey(''), '')
  assert.equal(scopeKey('global'), '')
  assert.equal(scopeKey('/p/tcl'), '/p/tcl')
})

test('全局第一，再按工作区注册表顺序——即使配置文件行顺序相反', () => {
  const rows = [srv('other', '/p/other'), srv('ctx'), srv('tcl', '/p/tcl')]
  const groups = orderedScopeGroups(rows, ['/p/tcl', '/p/other'])
  assert.deepEqual(groups.map((g) => g.scope), ['', '/p/tcl', '/p/other'])
  assert.deepEqual(names(groups), [['ctx'], ['tcl'], ['other']])
})

test('同组内保持配置文件行顺序（= 创建顺序，新增在最后）', () => {
  const rows = [srv('gitnexus', '/p/tcl'), srv('late', '/p/tcl'), srv('newest', '/p/tcl')]
  const groups = orderedScopeGroups(rows, ['/p/tcl'])
  assert.deepEqual(names(groups), [['gitnexus', 'late', 'newest']], '新增的行应排在该工作区最后')
})

test('注册表不认识的作用域排在已知工作区之后，按首次出现顺序', () => {
  const rows = [srv('manual', '/p/hand'), srv('alsoHand', '/p/other-hand'), srv('tcl', '/p/tcl')]
  const groups = orderedScopeGroups(rows, ['/p/tcl'])
  assert.deepEqual(groups.map((g) => g.scope), ['/p/tcl', '/p/hand', '/p/other-hand'])
})

test('空作用域列表 = 全局一组；没有任何行时返回空数组', () => {
  assert.deepEqual(orderedScopeGroups([srv('a')], []).map((g) => g.scope), [''])
  assert.deepEqual(orderedScopeGroups([], ['/p/tcl']), [], '没有行也没有待新增时不产生空分组')
})

test('进行中的新增会为自己的作用域建组，占位卡片落在将来出现的位置', () => {
  const groups = orderedScopeGroups([srv('ctx')], ['/p/tcl'], ['/p/tcl'])
  assert.deepEqual(groups.map((g) => g.scope), ['', '/p/tcl'])
  assert.deepEqual(names(groups), [['ctx'], []], '新作用域此时还没有行，但仍要占位')
})

test('未知 scope 视为全局，不会分裂成两个全局组', () => {
  const groups = orderedScopeGroups([srv('a'), srv('b', 'global'), srv('c')], [])
  assert.equal(groups.length, 1)
  assert.deepEqual(names(groups), [['a', 'b', 'c']])
})

test('入参不是数组时不抛错（Host 投影可能缺失）', () => {
  assert.deepEqual(orderedScopeGroups(undefined, undefined, undefined), [])
  assert.deepEqual(orderedScopeGroups(null, null, null), [])
  // 没有行时工作区自己不成组；只有明确在写入的作用域才占位
  assert.deepEqual(orderedScopeGroups(null, ['/p/x'], null), [])
  assert.deepEqual(orderedScopeGroups(null, ['/p/x'], ['/p/x']).map((g) => g.scope), ['/p/x'])
})
