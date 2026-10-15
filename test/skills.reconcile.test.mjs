/** skills/reconcile 接口测试：全局技能的落盘与回收。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NAME, LEGACY_NAME } from '../src/identity.js'
import { readState, reconcileSkills, scopeRoot } from '../src/skills/reconcile.js'

const home = mkdtempSync(join(tmpdir(), 'smp-skills-'))
process.env.DSH_HOME = home
const ctx = { logger: { warn() {}, info() {}, error() {} } }
// 契约：条目自带 scope（'global' 或项目路径）——面板写入时一定带上
const skill = { name: 'demo-skill', description: '演示技能', body: '# 标题\n\n正文', enabled: true, scope: 'global' }

test('scopeRoot：全局指向 $DSH_HOME/skills', () => {
  assert.equal(scopeRoot('global'), join(home, 'skills'))
})

test('scopeRoot：id 选根 —— agents 走 DSH_AGENTS_HOME，项目级两个根都在项目下', () => {
  /**
   * 每个作用域都有**两个**可写根，DSH 的 provider 两个都读。所以根是条目的一部分：
   * 少了它，写到 ~/.agents/skills 的文件会被下一轮 reconcile 搬到默认根去。
   */
  const agents = mkdtempSync(join(tmpdir(), 'smp-agents-'))
  process.env.DSH_AGENTS_HOME = agents
  try {
    assert.equal(scopeRoot('global', 'dsh'), join(home, 'skills'))
    assert.equal(scopeRoot('global', 'agents'), join(agents, 'skills'))
    assert.equal(scopeRoot('/p/app', 'dsh'), '/p/app/.dsh/skills')
    assert.equal(scopeRoot('/p/app', 'agents'), '/p/app/.agents/skills')
    // 缺省仍然是 dsh（旧条目没有这个字段，语义不能变）
    assert.equal(scopeRoot('global'), join(home, 'skills'))
    assert.equal(scopeRoot('/p/app'), '/p/app/.dsh/skills')
  } finally {
    delete process.env.DSH_AGENTS_HOME
  }
})

test('reconcileSkills：按条目自己的 id 写对应根，不会把它搬到另一个根', async () => {
  const agents = mkdtempSync(join(tmpdir(), 'smp-agents-write-'))
  process.env.DSH_AGENTS_HOME = agents
  const scopedHome = mkdtempSync(join(tmpdir(), 'smp-skills-roots-'))
  process.env.DSH_HOME = scopedHome
  try {
    const inAgents = { name: 'agents-skill', description: '写 agents 根', body: 'a', enabled: true, scope: 'global', id: 'agents' }
    const inDsh = { name: 'dsh-skill', description: '写 dsh 根', body: 'd', enabled: true, scope: 'global', id: 'dsh' }
    await reconcileSkills(ctx, [inAgents, inDsh])

    const agentsFile = join(agents, 'skills', 'agents-skill', 'SKILL.md')
    const dshFile = join(scopedHome, 'skills', 'dsh-skill', 'SKILL.md')
    assert.ok(existsSync(agentsFile), 'agents 根的文件没写进去')
    assert.ok(existsSync(dshFile), 'dsh 根的文件没写进去')
    // 关键：agents 条目**不能**同时出现在 dsh 根下（那正是"被搬走"的样子）
    assert.equal(existsSync(join(scopedHome, 'skills', 'agents-skill', 'SKILL.md')), false,
      'agents 根的条目被写进了 dsh 根')
    assert.equal(existsSync(join(agents, 'skills', 'dsh-skill', 'SKILL.md')), false,
      'dsh 根的条目被写进了 agents 根')

    // 再跑一次必须幂等：内容相同就不该重写，文件留在原地
    const result = await reconcileSkills(ctx, [inAgents, inDsh])
    assert.deepEqual(result.written, [], '内容未变时不该重写')
    assert.ok(existsSync(agentsFile) && existsSync(dshFile), '重复 reconcile 把文件搬走了')
  } finally {
    delete process.env.DSH_AGENTS_HOME
    process.env.DSH_HOME = home
  }
})

test('reconcileSkills：缺省 id 的旧条目仍然写 dsh 根（向后兼容）', async () => {
  const scopedHome = mkdtempSync(join(tmpdir(), 'smp-skills-legacy-'))
  process.env.DSH_HOME = scopedHome
  try {
    // 这是"这个字段存在之前"写入的形状：只有 scope
    await reconcileSkills(ctx, [{ name: 'old-skill', description: '旧', body: 'b', enabled: true, scope: 'global' }])
    assert.ok(existsSync(join(scopedHome, 'skills', 'old-skill', 'SKILL.md')), '旧条目应落在 dsh 根')
  } finally {
    process.env.DSH_HOME = home
  }
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
  const state = JSON.parse(readFileSync(join(home, 'dsh-skills-mcp-manager.state.json'), 'utf8'))
  assert.ok(Array.isArray(state.files), '状态文件应记录 owned 文件')
})

test('reconcileSkills：重复调用不报错（幂等）', async () => {
  await reconcileSkills(ctx, [skill])
  await reconcileSkills(ctx, [skill])
  assert.ok(existsSync(join(home, 'skills', skill.name, 'SKILL.md')))
})

test('旧技能归属清单自动导入，新状态优先，移除旧配置后仍能回收文件', async () => {
  const migrationHome = mkdtempSync(join(tmpdir(), 'smp-skills-migration-'))
  process.env.DSH_HOME = migrationHome
  try {
    const file = join(migrationHome, 'skills', 'legacy-skill', 'SKILL.md')
    mkdirSync(join(migrationHome, 'skills', 'legacy-skill'), { recursive: true })
    writeFileSync(file, '# legacy skill\n')
    const state = { files: [file] }
    writeFileSync(join(migrationHome, `${LEGACY_NAME}.state.json`), JSON.stringify(state))
    assert.deepEqual(await readState(), state)
    assert.deepEqual(JSON.parse(readFileSync(join(migrationHome, `${NAME}.state.json`), 'utf8')), state)
    await reconcileSkills(ctx, [])
    assert.equal(existsSync(file), false)
    assert.deepEqual(await readState(), { files: [] }, '不能重新读取遗留的旧清单')
  } finally {
    process.env.DSH_HOME = home
  }
})
