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
  // 用 join 拼期望值：插件走原生 join，Windows 上得到反斜杠属于正确行为，
  // 把分隔符写死只会把平台差异误报成功能故障。
  assert.equal(roots[0].dir, join('/h', 'skills'))
  assert.equal(roots[2].dir, join('/p', '.agents', 'skills'))
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

/**
 * 读回必须是写入的**逆运算**：不带改动的「编辑 → 保存」不能改变文件内容。
 *
 * 用户报告「编辑后正文多了一行，然后才到正文」。原因就在这对函数之间：
 * `renderSkillMarkdown` 写成 `---<front>---\n\n<body>` 并把正文的前导换行剥掉，
 * 而 `bodyOf` 只吃掉了 frontmatter 结尾的**一个**换行，把那个空行当成正文的一部分。
 * 于是编辑框第一行是空的；保存又把它当真实内容写回去，文件每次往返都长一点。
 *
 * 这条测试钉住的是**不变量**（往返恒等），而不是某个具体正则 —— 只要两边再次漂移就会失败。
 */
test('bodyOf / renderSkillMarkdown：往返恒等，且不带改动的保存不改文件', async () => {
  const { bodyOf } = await import('../src/skills/discover.js')
  const { renderSkillMarkdown } = await import('../src/skills/write.js')

  for (const body of [
    'test',
    'line1\nline2',
    'line1\n\nline2',
    'line1\n\n\nline3',
    '# 标题\n\n正文',
    // 缩进开头：写入侧**保留**缩进，所以读取侧不能把它当分隔符吃掉
    '    indented code',
    '  a\n  b',
  ]) {
    const file = renderSkillMarkdown({ name: 'demo', description: 'd', body })
    assert.equal(bodyOf(file), body, `往返改变了正文：${JSON.stringify(body)}`)
    // 再写一次必须逐字节相同 —— 这正是「每存一次多一行」的那条不变量
    assert.equal(renderSkillMarkdown({ name: 'demo', description: 'd', body: bodyOf(file) }), file,
      '不带改动的保存改变了文件内容')
  }
})

test('bodyOf / stripFrontmatter：两份实现必须一致（它们漂移过一次）', async () => {
  const { bodyOf } = await import('../src/skills/discover.js')
  const { stripFrontmatter } = await import('../src/skills/write.js')
  for (const markdown of [
    '---\nname: a\ndescription: d\n---\n\ntext',
    '---\nname: a\n---\n    indented',
    '---\nname: a\n---\n',
    'no frontmatter',
    '',
  ]) {
    assert.equal(stripFrontmatter(markdown), bodyOf(markdown),
      `两份 frontmatter 剥离实现结果不同：${JSON.stringify(markdown)}`)
  }
})
