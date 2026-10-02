/** skills/reconcile 接口测试：全局技能的落盘与回收。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileSkills, scopeRoot } from '../src/skills/reconcile.js'

const home = mkdtempSync(join(tmpdir(), 'smp-skills-'))
process.env.DSH_HOME = home
const ctx = { logger: { warn() {}, info() {}, error() {} } }
// 契约：条目自带 scope（'global' 或项目路径）——面板写入时一定带上
const skill = { name: 'demo-skill', description: '演示技能', body: '# 标题\n\n正文', enabled: true, scope: 'global' }

test('scopeRoot：全局指向 $DSH_HOME/skills', () => {
  assert.equal(scopeRoot('global'), join(home, 'skills'))
})

test('reconcileSkills：写入 SKILL.md（含 frontmatter），移除配置后清理目录', async () => {
  await reconcileSkills(ctx, [skill])
  const file = join(home, 'skills', skill.name, 'SKILL.md')
  assert.ok(existsSync(file), 'SKILL.md 未生成')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /name: demo-skill/)
  assert.match(text, /演示技能/)
  assert.match(text, /正文/)

  // 清理按状态文件记录的文件执行（删文件，目录可能留空）
  await reconcileSkills(ctx, [])
  assert.equal(existsSync(file), false, 'SKILL.md 未被清理')
  const state = JSON.parse(readFileSync(join(home, 'skills-mcp-panel.state.json'), 'utf8'))
  assert.ok(Array.isArray(state.files), '状态文件应记录 owned 文件')
})

test('reconcileSkills：重复调用不报错（幂等）', async () => {
  await reconcileSkills(ctx, [skill])
  await reconcileSkills(ctx, [skill])
  assert.ok(existsSync(join(home, 'skills', skill.name, 'SKILL.md')))
})
