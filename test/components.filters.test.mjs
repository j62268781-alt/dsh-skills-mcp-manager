/** components/filters 接口测试：名称搜索、计数标签、scope 过滤。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterByName, matchesName, serversForScope, tabLabel } from '../lib/src/components/filters.js'

test('matchesName：只按名称、忽略大小写、空查询全通过', () => {
  assert.equal(matchesName('Demo-Skill', 'demo'), true)
  assert.equal(matchesName('github', 'HUB'), true, '大小写不敏感：github 含 hub')
  assert.equal(matchesName('github', 'gitlab'), false)
  assert.equal(matchesName('anything', '  '), true)
  assert.equal(matchesName(undefined, 'x'), false)
})

test('filterByName：默认按 serverName，可指定字段', () => {
  const servers = [{ serverName: 'context7' }, { serverName: 'github' }]
  assert.deepEqual(filterByName(servers, 'ctx').length, 0)
  assert.deepEqual(filterByName(servers, 'con').map((s) => s.serverName), ['context7'])
  const skills = [{ name: 'code-review' }, { name: 'docs' }]
  assert.deepEqual(filterByName(skills, 'code', 'name').map((s) => s.name), ['code-review'])
})

test('tabLabel：标签带计数（0 也照实显示）', () => {
  assert.equal(tabLabel('MCP', 5), 'MCP (5)')
  assert.equal(tabLabel('Skills', 0), 'Skills (0)')
})

test('serversForScope：缺省 scope 视为全局', () => {
  const servers = [{ serverName: 'a' }, { serverName: 'b', scope: '/p/app' }]
  assert.deepEqual(serversForScope(servers, 'global').map((s) => s.serverName), ['a'])
  assert.deepEqual(serversForScope(servers, '/p/app').map((s) => s.serverName), ['b'])
})
