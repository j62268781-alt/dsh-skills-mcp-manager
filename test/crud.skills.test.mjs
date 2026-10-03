/** crud/skills 接口测试：scope 归属、upsert/remove、名称搜索与校验。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dropOptimisticSkill, hideSkillUntilGone, isValidSkillName, matchesSkillName, removalTargetOf,
  removeSkill, scopeOfSkill, skillDraftFrom, skillEntryOf, skillsForScope, upsertSkill, upsertSkillByName,
} from '../lib/src/crud/skills.js'

const g = { name: 'global-one', scope: 'global' }
const p = { name: 'proj-one', scope: '/p/app' }

test('scopeOfSkill / skillsForScope：缺省算全局，项目级按路径归属', () => {
  assert.equal(scopeOfSkill({ name: 'x' }), 'global')
  assert.equal(scopeOfSkill(p), '/p/app')
  assert.deepEqual(skillsForScope([g, p], 'global'), [g])
  assert.deepEqual(skillsForScope([g, p], '/p/app'), [p])
  assert.deepEqual(skillsForScope([g, p], '/p/other'), [])
})

test('skillEntryOf：草稿转条目，空 scope 记为 global，缺省启用', () => {
  const entry = skillEntryOf({ name: '  demo  ', description: ' d ', body: 'b' }, '')
  assert.deepEqual(entry, { name: 'demo', description: 'd', body: 'b', scope: 'global', enabled: true })
  assert.equal(skillEntryOf({ name: 'x', enabled: false }, '/p/app').enabled, false)
  assert.equal(skillEntryOf({ name: 'x' }, '/p/app').scope, '/p/app')
})

test('upsertSkill：新增追加，编辑按身份替换', () => {
  const added = upsertSkill([g], { name: 'new', scope: 'global' })
  assert.equal(added.length, 2)
  const edited = upsertSkill([g, p], { name: 'global-two', scope: 'global' }, g)
  assert.equal(edited.length, 2)
  assert.equal(edited[0].name, 'global-two')
  assert.equal(edited[1], p)
})

test('removeSkill：按身份删除', () => {
  assert.deepEqual(removeSkill([g, p], g), [p])
})

test('upsertSkillByName：同 (name, scope) 覆盖，不同 scope 各自保留', () => {
  const g2 = { name: 'same', scope: 'global' }
  const p2 = { name: 'same', scope: '/p/app' }
  const base = [g2, p2]
  const updated = upsertSkillByName(base, { name: 'same', scope: 'global', description: 'new' })
  assert.equal(updated.length, 2)
  assert.equal(updated.find((x) => scopeOfSkill(x) === 'global').description, 'new')
  assert.equal(updated.find((x) => scopeOfSkill(x) === '/p/app'), p2)
  assert.equal(upsertSkillByName(base, { name: 'fresh', scope: 'global' }).length, 3)
})

test('matchesSkillName：只按名称匹配、忽略大小写', () => {
  assert.equal(matchesSkillName({ name: 'Demo-Skill', description: 'zzz' }, 'demo'), true)
  assert.equal(matchesSkillName({ name: 'demo', description: 'needle' }, 'needle'), false)
  assert.equal(matchesSkillName({ name: 'demo' }, ''), true)
})

test('skillDraftFrom / isValidSkillName：回填与校验', () => {
  assert.deepEqual(skillDraftFrom({ name: 'a', description: 'b', body: 'c' }), { name: 'a', description: 'b', body: 'c', enabled: true })
  assert.equal(isValidSkillName('demo-skill_1'), true)
  assert.equal(isValidSkillName('bad name'), false)
  assert.equal(isValidSkillName(''), false)
})

test('removalTargetOf：全局记 global，项目级记项目路径', () => {
  assert.deepEqual(removalTargetOf({ name: 'test-skills', scope: 'global' }), { name: 'test-skills', scopeKey: 'global' })
  assert.deepEqual(removalTargetOf({ name: 'p', scope: '/p/app' }), { name: 'p', scopeKey: '/p/app' })
  // 缺省 scope 与空 scope 都按全局处理，避免墓碑键写成 "name::"。
  assert.deepEqual(removalTargetOf({ name: 'x' }), { name: 'x', scopeKey: 'global' })
  assert.deepEqual(removalTargetOf({ name: 'x', scope: '' }), { name: 'x', scopeKey: 'global' })
})

test('dropOptimisticSkill：删掉同名乐观卡片，其它条目与实例保持不变', () => {
  const ghost = { name: 'test-skills', scope: 'global', optimistic: true }
  const other = { name: 'keep', scope: 'global', optimistic: true }
  const list = [ghost, other]
  const next = dropOptimisticSkill(list, 'test-skills')
  assert.deepEqual(next, [other])
  assert.equal(next[0], other)
  // 没有命中时必须原样返回，让 React 跳过这次渲染。
  assert.equal(dropOptimisticSkill(list, 'nope'), list)
  assert.equal(dropOptimisticSkill(list, ''), list)
})

test('hideSkillUntilGone：登记墓碑、去重、空名不产生条目', () => {
  const once = hideSkillUntilGone([], 'test-skills', 'global')
  assert.deepEqual(once, ['test-skills::global'])
  assert.equal(hideSkillUntilGone(once, 'test-skills', 'global'), once)
  assert.deepEqual(hideSkillUntilGone(once, 'p', '/p/app'), ['test-skills::global', 'p::/p/app'])
  // 缺省 scope 回落到 global，键必须和 discovered 的 `name::scope` 对得上。
  assert.deepEqual(hideSkillUntilGone([], 'x', undefined), ['x::global'])
  assert.deepEqual(hideSkillUntilGone([], '', 'global'), [])
})
