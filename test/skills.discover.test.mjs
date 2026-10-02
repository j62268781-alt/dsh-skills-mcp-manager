/** skills/discover 接口测试：目录束、平铺 md、缺失根、优先级去重。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills, parseFrontmatter, skillRootsFor } from '../src/skills/discover.js'

const root = mkdtempSync(join(tmpdir(), 'smp-discover-'))
const project = join(root, 'proj')
const dshHome = join(root, 'dsh')
const agentsHome = join(root, 'agents')

const bundle = (base, name, fm, body = '正文') => {
  mkdirSync(join(base, name), { recursive: true })
  writeFileSync(join(base, name, 'SKILL.md'), `---\n${fm}\n---\n\n${body}\n`)
}
const flat = (base, name, fm) => {
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, `${name}.md`), `---\n${fm}\n---\n\n正文\n`)
}

// 项目级：目录束 + 与用户级同名（应被项目级遮蔽）
bundle(join(project, '.agents/skills'), 'dart-add-unit-test', 'name: dart-add-unit-test\ndescription: 为 Dart 加单测')
bundle(join(project, '.agents/skills'), 'context7', 'name: context7\ndescription: 项目版 context7')
flat(join(project, '.dsh/skills'), 'flat-skill', 'name: flat-skill\ndescription: 平铺 md')
// 用户级：目录束 + 同名（应被上面的项目级遮蔽）
bundle(join(agentsHome, 'skills'), 'context7', 'name: context7\ndescription: 用户版 context7')
bundle(join(agentsHome, 'skills'), 'deepwiki', 'name: deepwiki\ndescription: 查仓库文档')
mkdirSync(join(agentsHome, 'skills', 'no-skill-md'), { recursive: true })   // 无 SKILL.md，应忽略

test('skillRootsFor：四个根、顺序与 source 标签与 DSH 对齐', () => {
  const roots = skillRootsFor({ projectRoots: ['/p/a'], dshHome: '/h', agentsHome: '/u' })
  assert.deepEqual(roots.map((r) => r.source), ['project-dsh', 'project-agents', 'user-dsh', 'user-agents'])
  assert.equal(roots[0].path, '/p/a/.dsh/skills')
  assert.equal(roots[1].path, '/p/a/.agents/skills')
  assert.equal(roots[2].scope, 'global')
})

test('parseFrontmatter：取 name/description，无 frontmatter 返回空对象', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: b\n---\n正文'), { name: 'a', description: 'b' })
  assert.deepEqual(parseFrontmatter('# 没有 frontmatter'), {})
  assert.deepEqual(parseFrontmatter('---\n: bad yaml: [\n---\n'), {})
})

test('discoverSkills：目录束 + 平铺 md + 忽略非技能目录', async () => {
  const skills = await discoverSkills({ projectRoots: [project], dshHome, agentsHome })
  const names = skills.map((s) => s.name).sort()
  // 同名技能分属不同 scope（项目级 / 用户级），两者并存 —— DSH 也是这么看的
  assert.deepEqual(names, ['context7', 'context7', 'dart-add-unit-test', 'deepwiki', 'flat-skill'])
  assert.equal(names.includes('no-skill-md'), false)
  assert.equal(skills.find((s) => s.name === 'flat-skill').source, 'project-dsh')
  assert.equal(skills.find((s) => s.name === 'deepwiki').source, 'user-agents')
})

test('discoverSkills：同名技能按 scope 各留一份，项目级那份来自 project-agents', async () => {
  const skills = await discoverSkills({ projectRoots: [project], dshHome, agentsHome })
  const both = skills.filter((s) => s.name === 'context7')
  assert.equal(both.length, 2)
  const projectOne = both.find((s) => s.scope === project)
  const userOne = both.find((s) => s.scope === 'global')
  assert.equal(projectOne.source, 'project-agents')
  assert.equal(projectOne.description, '项目版 context7')
  assert.equal(userOne.source, 'user-agents')
})

test('discoverSkills：根不存在时返回空数组而不抛错', async () => {
  const skills = await discoverSkills({ projectRoots: ['/nonexistent-project'], dshHome: '/nope', agentsHome: '/nope2' })
  assert.deepEqual(skills, [])
})
