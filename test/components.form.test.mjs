/** components/form 接口测试：字段定义（含文案）与校验。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HINTS, fieldApplies, isValidName, serverFieldDefs, skillFieldDefs,
  validateServerDraft, validateSkillDraft,
} from '../lib/src/components/form.js'

test('文案被固定住：名称提示与环境变量示例', () => {
  assert.equal(HINTS.serverName, '例如 context7，最多 32 字符')
  assert.match(HINTS.env, /^TEST_TOKEN=sk-xxxxxxx/)
  assert.match(HINTS.env, /多个变量一行一个/)
  assert.equal(HINTS.project, '请选择项目')
})

test('serverFieldDefs：字段顺序与适用范围', () => {
  const keys = serverFieldDefs().map((f) => f.key)
  assert.deepEqual(keys.slice(0, 2), ['serverName', 'transport'])
  const defs = serverFieldDefs()
  assert.equal(fieldApplies(defs.find((f) => f.key === 'url'), { transport: 'streamable-http' }), true)
  assert.equal(fieldApplies(defs.find((f) => f.key === 'url'), { transport: 'stdio' }), false)
  assert.equal(fieldApplies(defs.find((f) => f.key === 'command'), { transport: 'stdio' }), true)
  assert.equal(fieldApplies(defs.find((f) => f.key === 'env'), { transport: 'streamable-http' }), false)
})

test('skillFieldDefs：名称/描述/正文', () => {
  assert.deepEqual(skillFieldDefs().map((f) => f.key), ['name', 'description', 'body'])
})

test('isValidName：长度与字符集（服务 32、技能 64）', () => {
  assert.equal(isValidName('context7'), true)
  assert.equal(isValidName('a'.repeat(32)), true)
  assert.equal(isValidName('a'.repeat(33)), false)
  assert.equal(isValidName('a'.repeat(64), 64), true)
  assert.equal(isValidName('bad name'), false)
  assert.equal(isValidName(''), false)
})

test('validateServerDraft：stdio 要命令、http 要 URL', () => {
  assert.equal(validateServerDraft({ serverName: 'x', transport: 'stdio', command: 'npx' }), null)
  assert.match(validateServerDraft({ serverName: 'x', transport: 'stdio', command: '  ' }), /需要填写命令/)
  assert.equal(validateServerDraft({ serverName: 'x', transport: 'streamable-http', url: 'https://y/mcp' }), null)
  assert.match(validateServerDraft({ serverName: 'x', url: '' }), /需要填写 URL/)
  assert.match(validateServerDraft({ serverName: '' }), /名称只能用/)
})

test('validateSkillDraft：名称与正文必填', () => {
  assert.equal(validateSkillDraft({ name: 'demo', body: '# hi' }), null)
  assert.match(validateSkillDraft({ name: 'demo', body: '  ' }), /正文/)
  assert.match(validateSkillDraft({ name: 'bad name', body: 'x' }), /名称只能用/)
})
