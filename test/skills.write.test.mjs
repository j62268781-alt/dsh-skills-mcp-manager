/** skills/write 接口测试：校验、创建、更新、改名（动目录 + 重写 frontmatter）、删除与备份。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkill, deleteSkill, renderSkillMarkdown, renameSkill, stripFrontmatter, updateSkill, validateSkillName, writableRoots } from '../src/skills/write.js'

const root = mkdtempSync(join(tmpdir(), 'smp-write-'))
const dir = join(root, 'skills')

test('writableRoots：全局与项目的 dsh/agents 四个目标', () => {
  const roots = writableRoots({ dshHome: '/h', agentsHome: '/a', projectRoot: '/p' })
  assert.deepEqual(roots.map((r) => `${r.scope}:${r.id}`), ['global:dsh', 'global:agents', 'project:agents', 'project:dsh'])
  assert.equal(roots[0].dir, '/h/skills')
  assert.equal(roots[2].dir, '/p/.agents/skills')
})

test('validateSkillName：拒绝空、斜杠、点开头、超长', () => {
  assert.equal(validateSkillName('ok-name').ok, true)
  for (const bad of ['', '  ', 'a/b', 'a\\b', '.hidden', '..', 'x'.repeat(65)]) {
    assert.equal(validateSkillName(bad).ok, false, `应拒绝 ${JSON.stringify(bad)}`)
  }
  assert.equal(validateSkillName('  trimmed  ').value, 'trimmed')
})

test('createSkill：写入 <name>/SKILL.md 且带 frontmatter；同名拒绝', async () => {
  const made = await createSkill({ dir, name: 'alpha', description: '第一个', body: '# 正文\n步骤' })
  assert.equal(made.ok, true)
  const text = readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')
  assert.match(text, /^---\n/)
  assert.match(text, /name: alpha/)
  assert.match(text, /description: 第一个/)
  assert.match(text, /# 正文/)
  const again = await createSkill({ dir, name: 'alpha', description: 'x' })
  assert.equal(again.ok, false)
  assert.match(again.reason, /已存在/)
})

test('updateSkill：同名更新正文；不存在则报错', async () => {
  const up = await updateSkill({ dir, name: 'alpha', description: '改过', body: '# 新正文' })
  assert.equal(up.ok, true)
  assert.match(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8'), /# 新正文/)
  const missing = await updateSkill({ dir, name: 'nope', body: 'x' })
  assert.equal(missing.ok, false)
})

test('renameSkill：目录一起改名 + frontmatter name 同步 + 备份旧目录', async () => {
  const res = await renameSkill({ dir, from: 'alpha', to: 'beta', description: '第一个', body: '# 正文' })
  assert.equal(res.ok, true)
  assert.equal(existsSync(join(dir, 'alpha')), false)
  assert.equal(existsSync(join(dir, 'beta', 'SKILL.md')), true)
  assert.match(readFileSync(join(dir, 'beta', 'SKILL.md'), 'utf8'), /name: beta/)
  assert.equal(existsSync(res.backup), true)
  assert.match(readFileSync(join(res.backup, 'SKILL.md'), 'utf8'), /name: alpha/)
})

test('renameSkill：目标已存在时拒绝，不覆盖', async () => {
  await createSkill({ dir, name: 'gamma', description: 'g' })
  const res = await renameSkill({ dir, from: 'beta', to: 'gamma' })
  assert.equal(res.ok, false)
  assert.match(res.reason, /已存在/)
  assert.equal(existsSync(join(dir, 'beta')), true)
})

test('renameSkill：from 与 to 相同则等价于更新', async () => {
  const res = await renameSkill({ dir, from: 'beta', to: 'beta', description: '同', body: '# 同' })
  assert.equal(res.ok, true)
  assert.match(readFileSync(join(dir, 'beta', 'SKILL.md'), 'utf8'), /# 同/)
})

test('deleteSkill：删除目录并留备份', async () => {
  const res = await deleteSkill({ dir, name: 'gamma' })
  assert.equal(res.ok, true)
  assert.equal(existsSync(join(dir, 'gamma')), false)
  assert.equal(existsSync(res.backup), true)
})

test('renderSkillMarkdown / stripFrontmatter：往返一致', async () => {
  const text = renderSkillMarkdown({ name: 'x', description: 'd', body: '正文' })
  assert.equal(stripFrontmatter(text).trim(), '正文')
  assert.equal(stripFrontmatter('没有 frontmatter').trim(), '没有 frontmatter')
})
