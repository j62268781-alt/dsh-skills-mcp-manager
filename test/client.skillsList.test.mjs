/**
 * Skills 列表与 MCP 列表的**布局一致性**。
 *
 * 这两份列表此前是两套卡片实现：skills 分成两个可折叠区块（「全局技能」/「项目级技能」），
 * 操作是卡片上并排的三个按钮，标题行与描述行只有标题那一行居中。MCP 那边是一份列表、
 * 工作区顺序、操作收进 `…` 菜单、两列垂直居中。
 *
 * 这个文件钉住「两个页签现在是同一套布局」，因为这些差异很容易在后续维护里被无意恢复：
 *   · 一份列表，不再有「全局技能 / 项目级技能」区块标题
 *   · summary 一行，位置与 MCP 相同（搜索框上方）
 *   · 「添加技能」与搜索框同一行（和「添加服务器」同一个槽位）
 *   · 操作在 `…` 菜单里，不在卡片上平铺
 *   · 卡片是 `smp-cardRow`（左标题+描述、右操作），不是只有标题行居中
 *   · 顺序为 全局 → 工作区（按工作区顺序）
 *
 * **一处有意保留的差异**：skills 仍有「项目」筛选器（MCP 没有）。技能是按项目写进不同
 * 目录的，筛选器决定"当前在管哪个项目"；MCP 的作用域则在服务器自己的表单里选。所以下面
 * 的夹具把条目放在"全局 + 当前项目"两档里——这正是筛选器开启时列表展示的集合。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const doc = (over = {}) => emptyDoc({
  skills: [
    { name: 'global-skill', description: '全局的', scope: 'global', enabled: true },
    { name: 'tcl-skill', description: 'TCL 的', scope: '/p/tcl', enabled: true },
    // 另一档：筛选器指向 /p/tcl 时它**不**出现在列表里（技能按项目分开管）。这条夹具的
    // 意义就是钉住这一点没有被「一份列表」改掉——它同时是 skills 与 MCP 唯一的语义差异。
    { name: 'other-skill', description: 'OTHER 的', scope: '/p/other', enabled: false },
  ],
  workspaces: [{ path: '/p/tcl', title: 'TCL' }, { path: '/p/other', title: 'OTHER' }],
  currentWorkspace: '/p/tcl',
  skillDirs: { userDsh: '/h/skills', userAgents: '/h/.agents/skills' },
  rowOpsReady: true, reconnectReady: true,
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

/**
 * The Nth `<input>` inside the in-place edit form (`smp-formGrid`).
 *
 * Scoped to the form on purpose: the filter row's search box is also an `<input>`, so a
 * page-wide lookup silently shifts by one and would edit the wrong field.
 */
const formInput = (panel, index) => {
  const grid = panel.findAll((node) => String(node.props?.className ?? '') === 'smp-formGrid')
  assert.equal(grid.length, 1, `应只有一个编辑表单，实际 ${grid.length}`)
  // 表单里的 input 都带 smp-input，且工具栏的搜索框不在这个 grid 内。
  const inputs = panel.findAll((node) => node.type === 'input'
    && String(node.props?.className ?? '') === 'smp-input')
  assert.equal(inputs.length, 2, `技能名与描述两个 input，实际 ${inputs.length}`)
  assert.ok(inputs.length > index, `表单里没有第 ${index} 个 input（共 ${inputs.length} 个）`)
  return inputs[index]
}

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
    // 一份列表：全局与当前项目的技能在同一份 `cards` 里
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
    // 两个工作区都在列表里 —— 这正是去掉筛选器要达到的效果：别的项目的技能也看得见
    assert.ok(at('tcl-skill') > at('global-skill'), `TCL 的排在全局之后：${JSON.stringify(names)}`)
    assert.ok(at('other-skill') > at('tcl-skill'), `OTHER 的按注册表顺序排在 TCL 之后：${JSON.stringify(names)}`)
  } finally {
    panel.restore()
  }
})

test('Skills：工具栏里没有「项目」筛选器了（与 MCP 一致）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills()
  try {
    const bar = panel.find((node) => String(node.props?.className ?? '') === 'smp-filterRow')
    assert.ok(bar !== null, '找不到工具栏')
    // 搜索框 + 添加按钮，没有项目下拉/自定义路径输入
    assert.equal(panel.findAll((node) => node.type === 'select').length, 0, '工具栏不该再有项目下拉')
    assert.equal(panel.byPlaceholder('项目绝对路径'), null, '工具栏不该再有自定义路径输入')
    assert.ok(!textOf(bar).includes('选工作区'), '工具栏不该再有「选工作区」')
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

    // summary 行与 MCP 用同一个类，且只有一个
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

    // 未打开菜单时，卡片上不该有裸的编辑/删除按钮
    const inline = panel.findAll((node) => node.type === 'button'
      && ['编辑', '删除', '预览'].includes(textOf(node).trim()))
    assert.deepEqual(inline, [], '操作不该平铺在卡片上')

    // 打开后三个操作都在菜单里
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
    assert.equal(has('smp-cardRow'), cards, '每张卡片都要有 smp-cardRow（左内容右操作，整行居中）')
    assert.equal(has('smp-cardMain'), cards, '每张卡片都要有 smp-cardMain')
    assert.equal(has('smp-cardEnd'), cards, '每张卡片都要有 smp-cardEnd（右侧状态位）')
  } finally {
    panel.restore()
  }
})

test('Skills：受管条目有启用开关，磁盘发现的条目没有', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootSkills({
    discoveredSkills: [
      { name: 'disk-only', description: '磁盘上的', path: '/h/skills/disk-only/SKILL.md', source: 'user-agents', scope: 'global' },
    ],
  })
  try {
    const switches = panel.findAll((node) => node.type === 'button' && node.props?.role === 'switch')
    // 受管条目（三个：全局 + 两个工作区）各一个开关；磁盘发现的 `disk-only` 没有——它不在
    // config.skills[] 里，没有可切换的状态，画一个"永远开着"的开关等于承诺一个不存在的控制。
    assert.equal(switches.length, 3, `开关数应为 3（受管条目），实际 ${switches.length}`)
    assert.ok(cardNames(panel).some((n) => n.includes('disk-only')), '磁盘条目也要出现在列表里')
  } finally {
    panel.restore()
  }
})

test('Skills：卡片标签统一为 全局 / 工作区名（不再显示 dsh/agents 根名）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 标签回答的是「这个条目是谁的」，与 MCP 用同一套词表；「文件落在两个根中的哪一个」
   * 是展开后「落盘」那一行的事。以前 skills 按根名打标签（dsh / agents），而 MCP 全局
   * 干脆不打标签——两个页签读起来是两套语言。
   */
  const panel = await bootSkills({
    discoveredSkills: [
      { name: 'disk-agents', description: '磁盘上的', path: '/h/.agents/skills/disk-agents/SKILL.md', source: 'user-agents', scope: 'global' },
      { name: 'disk-dsh', description: '磁盘上的', path: '/h/.dsh/skills/disk-dsh/SKILL.md', source: 'user-dsh', scope: 'global' },
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
    // 两个用户级根的文件都算全局，标签一样
    const names = cardNames(panel)
    assert.ok(names.find((n) => n.includes('disk-agents'))?.endsWith('全局'), 'agents 根的文件标「全局」')
    assert.ok(names.find((n) => n.includes('disk-dsh'))?.endsWith('全局'), 'dsh 根的文件也标「全局」')
  } finally {
    panel.restore()
  }
})

test('Skills：编辑受管条目要写 config.skills[]（只写磁盘会被 reconcile 静默回退）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 这条钉住一个**会静默丢数据**的路径。
   *
   * Host 每个周期都会把 `config.skills[]` 里的启用条目镜像到磁盘
   * （`src/skills/reconcile.js`）。所以「编辑」如果只写 SKILL.md 而不更新配置条目，
   * 几秒后 reconcile 就会把文件改回去——用户看到自己的修改消失了，却没有任何报错。
   *
   * 因此受管条目是**原地编辑**（卡片变成表单），与 MCP 行的编辑方式一致；磁盘发现
   * （不在配置里）的条目才走对话框。
   */
  const panel = await bootSkills()
  const { doc, runtime } = panel
  try {
    // 打开第一张卡片（global-skill）的菜单 → 编辑
    panel.openMenu(0)
    panel.click(panel.byText('编辑'))

    // 原地编辑：卡片位置出现表单，而不是弹出磁盘编辑对话框
    assert.ok(panel.byText('保存到配置') !== null, '受管条目应进入原地编辑（保存到配置）')
    assert.equal(panel.byText('创建'), null, '受管条目的编辑不该走磁盘对话框')

    // 原地表单没有 placeholder（对话框的才有），按 label 顺序找描述字段：
    // skillFieldDefs() = 技能名 / 描述 / 正文
    // 只看表单里的 input：搜索框也是 input，全局查找会多算一个。
    panel.change(formInput(panel, 1), '改过的描述')

    const before = JSON.stringify(doc.skills ?? [])
    panel.click(panel.byText('保存到配置'))

    const after = doc.skills ?? []
    assert.notEqual(JSON.stringify(after), before, '保存后 config.skills[] 必须变化（否则磁盘会被 reconcile 改回）')
    const changed = after.find((s) => s.name === 'global-skill')
    assert.equal(changed?.description, '改过的描述', '改的是配置条目本身')
    assert.equal(changed?.scope, 'global', '作用域不能被改动丢失')
    assert.equal(changed?.enabled, true, '启用状态要保留')
  } finally {
    panel.restore()
  }
})

test('Skills：原地编辑不会把已停用的技能悄悄改回启用', { skip: skipWithoutBundle() }, async () => {
  /**
   * `skillEntryOf` 把「缺失的 enabled」当成启用（`draft.enabled === false ? false : true`）。
   * 所以编辑一张停用卡片时，草稿必须带上 `enabled: false`，否则一次无关的改名/改描述就会
   * 顺手把技能打开——用户只会看到磁盘上多了一个文件，不知道为什么。
   */
  const panel = await bootSkills({
    skills: [
      { name: 'global-skill', description: '全局的', scope: 'global', enabled: true },
      { name: 'off-skill', description: '停用的', scope: 'global', enabled: false },
    ],
    currentWorkspace: '',
  })
  const { doc } = panel
  try {
    // off-skill 是第二张卡片（同一作用域内按配置顺序）
    const names = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-cardToggle'))
    const index = names.findIndex((node) => textOf(node).includes('off-skill'))
    assert.ok(index !== -1, `找不到停用卡片：${names.map((n) => textOf(n))}`)

    panel.openMenu(index)
    panel.click(panel.byText('编辑'))
    assert.ok(panel.byText('保存到配置') !== null, '停用条目也要能原地编辑')

    panel.change(formInput(panel, 1), '改过的描述')
    panel.click(panel.byText('保存到配置'))

    const edited = (doc.skills ?? []).find((s) => s.name === 'off-skill')
    assert.equal(edited?.description, '改过的描述')
    assert.equal(edited?.enabled, false, '编辑不能顺手启用一个已停用的技能')
  } finally {
    panel.restore()
  }
})
