/**
 * Skills 列表与 MCP 列表的**布局一致性**。
 *
 * 技能现在与 MCP 一样是「磁盘即真源」：`SKILL.md` 就是条目，列表来自 Host 的磁盘扫描
 * （`/runtime` 的 `skills` 字段），没有任何 `config.skills[]`。这个文件钉住两个页签
 * 共用同一套布局/交互，以及技能只剩磁盘这一种形态：
 *   · 一份列表，不再有「全局技能 / 项目级技能」区块标题
 *   · summary 一行，位置与 MCP 相同（搜索框上方）
 *   · 「添加技能」与搜索框同一行
 *   · 操作在 `…` 菜单里，不在卡片上平铺
 *   · 卡片是 `smp-cardRow`（左标题+描述、右操作）
 *   · 顺序为 全局 → 工作区（按工作区顺序）
 *   · 没有启用开关（磁盘上没有「禁用」这个表示）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const disk = (name, scope, source) => ({
  name,
  description: name,
  scope,
  source,
  path: `${scope === 'global' ? '/h' : scope}/${source.endsWith('agents') ? '.agents' : '.dsh'}/skills/${name}/SKILL.md`,
})

const doc = (over = {}) => emptyDoc({
  discoveredSkills: [
    disk('global-skill', 'global', 'user-dsh'),
    disk('tcl-skill', '/p/tcl', 'project-dsh'),
    disk('other-skill', '/p/other', 'project-agents'),
  ],
  workspaces: [{ path: '/p/tcl', title: 'TCL' }, { path: '/p/other', title: 'OTHER' }],
  currentWorkspace: '/p/tcl',
  skillDirs: { userDsh: '/h/skills', userAgents: '/h/.agents/skills' },
  ...over,
})

/** Boot and switch to the Skills tab. */
async function bootSkills(over) {
  const panel = await bootPanel(doc(over))
  const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
  assert.ok(tab !== null, '找不到 Skills 页签')
  panel.click(tab)
  return panel
}

/** Card identity texts, in render order. */
const cardNames = (panel) => panel
  .findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-cardToggle'))
  .map((node) => textOf(node).replace(/\s+/g, ' ').trim())

test('Skills：一份列表，不再有「全局技能 / 项目级技能」区块', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const all = []
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node === null || node === undefined || typeof node !== 'object' || node.element !== true) return
      for (const child of Array.isArray(node.children) ? node.children : []) {
        if (typeof child === 'string') all.push(child)
      }
      if (typeof node.type === 'function') { walk(node.type({ ...node.props, children: node.children })); return }
      walk(node.children)
    }
    walk(panel.runtime.tree)
    assert.ok(!all.includes('全局技能'), '不该再有「全局技能」区块标题')
    assert.ok(!all.includes('项目级技能'), '不该再有「项目级技能」区块标题')
    const cards = panel.findAll((node) => String(node.props?.className ?? '') === 'smp-cards' && node.key === 'cards')
    assert.equal(cards.length, 1, `技能应只渲染一份 cards 列表，实际 ${cards.length} 份`)
    const names = cardNames(panel)
    assert.ok(names.some((n) => n.includes('global-skill')), '全局技能没出现')
    assert.ok(names.some((n) => n.includes('tcl-skill')), '当前项目的技能没出现')
  } finally {
    panel.restore()
  }
})

test('Skills：跨工作区一份列表，顺序为 全局 → 工作区（按注册表顺序）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const names = cardNames(panel)
    const at = (n) => names.findIndex((x) => x.includes(n))
    assert.ok(at('global-skill') === 0, `全局应排第一：${JSON.stringify(names)}`)
    assert.ok(at('tcl-skill') > at('global-skill'), `TCL 的排在全局之后：${JSON.stringify(names)}`)
    assert.ok(at('other-skill') > at('tcl-skill'), `OTHER 的按注册表顺序排在 TCL 之后：${JSON.stringify(names)}`)
  } finally {
    panel.restore()
  }
})

test('Skills：「添加技能」与搜索框同一行，summary 在搜索框上方', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const bar = panel.find((node) => String(node.props?.className ?? '') === 'smp-filterRow')
    assert.ok(bar !== null, '找不到工具栏')
    assert.ok(textOf(bar).includes('添加技能'), '「添加技能」应与搜索框同一行')
    const summaries = panel.findAll((node) => String(node.props?.className ?? '').includes('smp-summaryAbove'))
    assert.equal(summaries.length, 1, `summary 行应只有一个，实际 ${summaries.length}`)
    assert.match(textOf(summaries[0]), /共 \d+ 个/, 'summary 要报列表里的条目数')
  } finally {
    panel.restore()
  }
})

test('Skills：操作在 `…` 菜单里，不是卡片上平铺的三个按钮', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const triggers = panel.findAll((node) => String(node.props?.className ?? '') === 'smp-moreTrigger')
    assert.equal(triggers.length, cardNames(panel).length, `每个卡片一个 \`…\` 触发器，实际 ${triggers.length}`)
    const inline = panel.findAll((node) => node.type === 'button'
      && ['编辑', '删除', '预览'].includes(textOf(node).trim()))
    assert.deepEqual(inline, [], '操作不该平铺在卡片上')
    panel.click(triggers[0])
    const items = panel.findAll((node) => String(node.props?.className ?? '').includes('smp-menuItem'))
      .map((node) => textOf(node).trim())
    assert.deepEqual(items, ['预览', '编辑', '删除'], `菜单项不对：${JSON.stringify(items)}`)
  } finally {
    panel.restore()
  }
})

test('Skills：卡片用两列结构（smp-cardRow / smp-cardMain / smp-cardEnd），与 MCP 相同', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const has = (cls) => panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes(cls)).length
    const cards = cardNames(panel).length
    assert.equal(has('smp-cardRow'), cards, '每张卡片都要有 smp-cardRow')
    assert.equal(has('smp-cardMain'), cards, '每张卡片都要有 smp-cardMain')
    assert.equal(has('smp-cardEnd'), cards, '每张卡片都要有 smp-cardEnd')
  } finally {
    panel.restore()
  }
})

test('Skills：磁盘条目没有启用开关（没有可切换的状态）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const switches = panel.findAll((node) => node.type === 'button' && node.props?.role === 'switch')
    assert.equal(switches.length, 0, `磁盘技能不该有开关，实际 ${switches.length}`)
    assert.equal(cardNames(panel).length, 3)
  } finally {
    panel.restore()
  }
})

test('Skills：卡片标签统一为 全局 / 工作区名（不再显示 dsh/agents 根名）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills({
    discoveredSkills: [
      disk('disk-agents', 'global', 'user-agents'),
      disk('disk-dsh', 'global', 'user-dsh'),
    ],
  })
  try {
    const tags = panel
      .findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-tag'))
      .map((node) => textOf(node).trim())
      .filter((text) => text !== '')
    assert.ok(tags.every((t) => t === '全局' || t === 'TCL' || t === 'OTHER'), `标签词表不对：${JSON.stringify([...new Set(tags)])}`)
    assert.ok(!tags.includes('dsh'), '不该再用「dsh」当标签')
    assert.ok(!tags.includes('agents'), '不该再用「agents」当标签')
  } finally {
    panel.restore()
  }
})

test('Skills：编辑磁盘技能加载正文后 POST /skills，成功即更新列表', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills({ skillBody: '# 旧正文' })
  const { doc } = panel
  try {
    panel.openMenu(0)
    panel.click(panel.byText('编辑'))
    await panel.settle()
    assert.ok(panel.byText('保存') !== null, '磁盘技能应打开编辑对话框')
    // 正文来自 GET /skill，不是 settings。
    const body = panel.find((node) => node.type === 'textarea')
    assert.equal(body?.props?.value, '# 旧正文', '正文没有从 /skill 读取')
    panel.change(body, '# 新正文')
    panel.click(panel.byText('保存'))
    await panel.settle()
    const command = (doc.skillCommands ?? []).at(-1)
    assert.equal(command?.op, 'update')
    assert.equal(command?.body, '# 新正文')
    assert.equal(command?.nonce ?? '', '', 'HTTP 写入不再携带回执 nonce')
  } finally {
    panel.restore()
  }
})
